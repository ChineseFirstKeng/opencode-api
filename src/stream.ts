import type { AnthropicStreamState, OpenAIStreamChunk } from './types';

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) return false;
  if (state.currentBlockType !== 'tool') return false;
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  );
}

function closeContentBlock(state: AnthropicStreamState): Record<string, unknown> | null {
  if (!state.contentBlockOpen) return null;
  state.contentBlockOpen = false;
  state.currentBlockType = undefined;
  return { type: 'content_block_stop', index: state.contentBlockIndex };
}

function mapOpenAIStopReasonToAnthropic(reason: string | null): string {
  if (!reason) return 'end_turn';
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'stop_sequence';
    default: return 'end_turn';
  }
}

export function translateOpenAIChunkToAnthropicEvents(
  chunk: OpenAIStreamChunk,
  state: AnthropicStreamState,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  if (chunk.choices.length === 0) {
    return events;
  }

  const choice = chunk.choices[0];
  const delta = choice.delta as any;

  if (!state.messageStartSent) {
    const promptTokens = chunk.usage?.prompt_tokens ?? 0;
    const cachedTokens = chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const message: Record<string, unknown> = {
      id: chunk.id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: chunk.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: promptTokens - cachedTokens,
        output_tokens: 0,
      },
    };
    if (cachedTokens > 0) {
      (message.usage as Record<string, unknown>).cache_read_input_tokens = cachedTokens;
    }

    events.push({ type: 'message_start', message });
    state.messageStartSent = true;
  }

  // Handle reasoning_content → thinking blocks
  if (delta?.reasoning_content) {
    if (state.contentBlockOpen && state.currentBlockType !== 'thinking') {
      const close = closeContentBlock(state);
      if (close) {
        state.contentBlockIndex++;
        events.push(close);
      }
    }
    if (!state.contentBlockOpen) {
      events.push({
        type: 'content_block_start',
        index: state.contentBlockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
      state.contentBlockOpen = true;
      state.currentBlockType = 'thinking';
    }
    events.push({
      type: 'content_block_delta',
      index: state.contentBlockIndex,
      delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
    });
  }

  // Handle text content
  if (delta?.content) {
    // Close thinking block if switching to text
    if (state.contentBlockOpen && state.currentBlockType === 'thinking') {
      const close = closeContentBlock(state);
      if (close) {
        state.contentBlockIndex++;
        events.push(close);
      }
    }
    if (isToolBlockOpen(state)) {
      const close = closeContentBlock(state);
      if (close) {
        state.contentBlockIndex++;
        events.push(close);
      }
    }
    if (!state.contentBlockOpen) {
      events.push({
        type: 'content_block_start',
        index: state.contentBlockIndex,
        content_block: { type: 'text', text: '' },
      });
      state.contentBlockOpen = true;
      state.currentBlockType = 'text';
    }
    events.push({
      type: 'content_block_delta',
      index: state.contentBlockIndex,
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  // Handle tool calls
  if (delta?.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        if (state.contentBlockOpen) {
          const close = closeContentBlock(state);
          if (close) {
            state.contentBlockIndex++;
            events.push(close);
          }
        }
        const anthropicBlockIndex = state.contentBlockIndex;
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        };
        events.push({
          type: 'content_block_start',
          index: anthropicBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        });
        state.contentBlockOpen = true;
        state.currentBlockType = 'tool';
      }
      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index];
        if (toolCallInfo) {
          events.push({
            type: 'content_block_delta',
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: toolCall.function.arguments,
            },
          });
        }
      }
    }
  }

  // Handle finish
  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({ type: 'content_block_stop', index: state.contentBlockIndex });
      state.contentBlockOpen = false;
      state.currentBlockType = undefined;
    }

    const promptTokens = chunk.usage?.prompt_tokens ?? 0;
    const cachedTokens = chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: Record<string, number> = {
      input_tokens: promptTokens - cachedTokens,
      output_tokens: chunk.usage?.completion_tokens ?? 0,
    };
    if (cachedTokens > 0) {
      usage.cache_read_input_tokens = cachedTokens;
    }

    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
        stop_sequence: null,
      },
      usage,
    });
    events.push({ type: 'message_stop' });
    state.finished = true;
  }

  return events;
}
