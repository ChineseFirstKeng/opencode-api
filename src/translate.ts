import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIResponseChoice,
  OpenAITool,
  OpenAIToolCall,
} from './types';

// ── Request: Anthropic → OpenAI ────────────────────────────────────

export function extractSystemMessage(request: AnthropicRequest): string {
  const parts: string[] = [];

  if (request.system) {
    if (typeof request.system === 'string') {
      parts.push(request.system);
    } else {
      for (const s of request.system) {
        if (s.type === 'text' && s.text) {
          parts.push(s.text);
        }
      }
    }
  }

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      }
    }
  }

  return parts.join('\n');
}

function convertContentBlocks(
  blocks: AnthropicContentBlock[],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const hasImage = blocks.some((b) => b.type === 'image');
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      parts.push({ type: 'text', text: block.thinking || '' });
    } else if (block.type === 'image' && block.source) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type || 'image/jpeg'};base64,${block.source.data}`,
        },
      });
    }
  }

  if (hasImage) return parts;
  return parts.map((p) => p.text).join('\n\n');
}

export function convertToOpenAIMessages(request: AnthropicRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const systemMessage = extractSystemMessage(request);

  if (systemMessage) {
    messages.push({ role: 'system', content: systemMessage });
  }

  for (const msg of request.messages) {
    if (msg.role === 'system') continue;

    // Assistant: tool_use → tool_calls
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textBlocks: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            if (block.text) textBlocks.push(block.text);
            break;
          case 'thinking':
            textBlocks.push(block.thinking || '');
            break;
          case 'tool_use':
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
            break;
        }
      }

      messages.push({
        role: 'assistant',
        content: textBlocks.join('\n\n') || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    // User: tool_result blocks → role:tool messages
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResultBlocks: Array<{ tool_use_id: string; content: string }> = [];
      const otherBlocks: AnthropicContentBlock[] = [];

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResultBlocks.push({
            tool_use_id: block.tool_use_id,
            content: block.content ?? '',
          });
        } else {
          otherBlocks.push(block);
        }
      }

      // tool_results must come first (protocol: tool_use → tool_result → user)
      for (const tr of toolResultBlocks) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }

      if (otherBlocks.length > 0) {
        messages.push({
          role: 'user',
          content: convertContentBlocks(otherBlocks),
        });
      }
      continue;
    }

    // Plain string content
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      continue;
    }

    // Array content (text/image only, no tool blocks)
    messages.push({
      role: msg.role as 'user' | 'assistant',
      content: convertContentBlocks(msg.content as any),
    });
  }

  return messages;
}

export function convertToOpenAITools(tools: AnthropicRequest['tools']): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export function convertToolChoice(
  toolChoice: AnthropicRequest['tool_choice'],
): OpenAIRequest['tool_choice'] {
  if (!toolChoice) return undefined;

  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      if (toolChoice.name) {
        return { type: 'function' as const, function: { name: toolChoice.name } };
      }
      return undefined;
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

export function buildOpenAIRequest(request: AnthropicRequest, upstreamModel?: string): OpenAIRequest {
  const openAIRequest: OpenAIRequest = {
    model: upstreamModel || request.model,
    messages: convertToOpenAIMessages(request),
    stream: request.stream,
  };

  if (request.max_tokens) openAIRequest.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) openAIRequest.temperature = request.temperature;
  if (request.top_p !== undefined) openAIRequest.top_p = request.top_p;
  if (request.top_k !== undefined) openAIRequest.top_k = request.top_k;
  if (request.stop_sequences) openAIRequest.stop = request.stop_sequences;
  if (request.metadata?.user_id) openAIRequest.user = request.metadata.user_id;
  if (request.tools) openAIRequest.tools = convertToOpenAITools(request.tools);
  if (request.tool_choice) openAIRequest.tool_choice = convertToolChoice(request.tool_choice);

  return openAIRequest;
}

// ── Response: OpenAI → Anthropic (non-streaming) ───────────────────

export function convertToAnthropicResponse(
  openAIResponse: OpenAIResponse,
  requestModel: string,
): Record<string, unknown> {
  const choice = openAIResponse.choices[0];
  const content = choice?.message?.content || '';

  const contentBlocks: Array<Record<string, unknown>> = [];
  if (content) {
    contentBlocks.push({ type: 'text', text: content });
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  const finishReason = choice?.finish_reason;
  let stopReason = 'end_turn';
  if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason === 'stop') stopReason = 'end_turn';

  const promptTokens = openAIResponse.usage?.prompt_tokens ?? 0;
  const cachedTokens = openAIResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  const usage: Record<string, number> = {
    input_tokens: promptTokens - cachedTokens,
    output_tokens: openAIResponse.usage?.completion_tokens ?? 0,
  };
  if (cachedTokens > 0) {
    usage.cache_read_input_tokens = cachedTokens;
  }

  return {
    id: openAIResponse.id,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
