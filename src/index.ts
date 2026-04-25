import express, { type Request, type Response, type NextFunction } from 'express';
import { config, ALL_MODELS } from './config';
import { log, formatBody, COLORS } from './logger';
import { buildOpenAIRequest, convertToAnthropicResponse } from './translate';
import { translateOpenAIChunkToAnthropicEvents } from './stream';
import type { AnthropicRequest, AnthropicStreamState, OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from './types';
import { callOpenCodeGo, callOpenCodeGoAnthropic, callOpenCodeGoAnthropicStream, callOpenCodeGoStream, getUpstreamModel } from './opencode';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Rate Limiter ───────────────────────────────────────────────────

const requestTimestamps: number[] = [];

function rateLimitMiddleware(_req: Request, res: Response, next: NextFunction) {
  if (!config.rateLimit.enabled) return next();

  const now = Date.now();
  const windowStart = now - config.rateLimit.windowMs;

  // Prune old timestamps
  while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= config.rateLimit.maxRequests) {
    const retryAfter = Math.ceil((requestTimestamps[0] + config.rateLimit.windowMs - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: { type: 'rate_limit_error', message: `Rate limit exceeded. Try again in ${retryAfter}s.` },
    });
  }

  requestTimestamps.push(now);
  next();
}

// ── Logging Middleware ─────────────────────────────────────────────

function loggingMiddleware(req: Request, _res: Response, next: NextFunction) {
  const method = req.method;
  const url = req.url;
  const headers = {
    'content-type': req.headers['content-type'],
    'x-api-key': req.headers['x-api-key'] ? '***' + (req.headers['x-api-key'] as string).slice(-4) : undefined,
    authorization: req.headers['authorization'] ? 'Bearer ***' : undefined,
  };
  log('← REQUEST', `${method} ${url}`, COLORS.cyan);
  log('  HEADERS', JSON.stringify(headers), COLORS.dim);
  if (req.body && Object.keys(req.body).length > 0) {
    log('  BODY', formatBody(req.body), COLORS.dim);
  }
  next();
}

app.use(loggingMiddleware);

// ── Auth Middleware ─────────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip auth for public endpoints
  if (req.path === '/health' && req.method === 'GET') return next();
  if (req.path === '/v1/models' && req.method === 'GET') return next();

  const apiKey = (req.headers['x-api-key'] as string) ||
                 (req.headers['authorization'] as string)?.replace('Bearer ', '') ||
                 config.apiKey;

  if (!apiKey) {
    return res.status(401).json({
      error: { type: 'authentication_error', message: 'API key required. Set x-api-key header or OPENCODE_GO_API_KEY env var.' },
    });
  }

  // Store resolved key for downstream use
  (req as any).resolvedApiKey = apiKey;
  next();
}

app.use(authMiddleware);

// ── SSE Helpers ────────────────────────────────────────────────────

function writeSSE(res: Response, eventType: string, data: Record<string, unknown>) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function translateAndStreamOpenAI(upstream: globalThis.Response, res: Response, model: string) {
  log('← OPENCODE', `Upstream status: ${upstream.status}, content-type: ${upstream.headers.get('content-type')}`, COLORS.dim);

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const state: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    finished: false,
    toolCalls: {},
  };

  let rawLineCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        rawLineCount++;
        if (rawLineCount <= 15) {
          log('← RAW', trimmed.slice(0, 200), COLORS.dim);
        }

        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          log('← RAW', 'stream: [DONE]', COLORS.green);
          if (!state.finished) {
            if (state.contentBlockOpen) {
              writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: state.contentBlockIndex });
            }
            if (state.messageStartSent) {
              writeSSE(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 0 },
              });
              writeSSE(res, 'message_stop', { type: 'message_stop' });
            }
          }
          res.end();
          return;
        }

        try {
          const chunk: OpenAIStreamChunk = JSON.parse(dataStr);
          const events = translateOpenAIChunkToAnthropicEvents(chunk, state);
          for (const evt of events) {
            const detail = evt.type === 'content_block_delta' ? ' ' + JSON.stringify((evt as any).delta) : '';
            log('→ SSE', `${evt.type}${detail}`, COLORS.cyan);
            writeSSE(res, evt.type as string, evt);
          }
        } catch {
          // Parse error, skip
        }
      }
    }

    // Stream ended without [DONE]
    if (state.messageStartSent && !state.finished) {
      log('← OPENCODE', 'Stream ended (no [DONE]), closing', COLORS.yellow);
      if (state.contentBlockOpen) {
        writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: state.contentBlockIndex });
      }
      writeSSE(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      writeSSE(res, 'message_stop', { type: 'message_stop' });
    } else if (!state.messageStartSent) {
      log('← OPENCODE', 'Stream ended without any parseable events', COLORS.red);
      // Close content block if open before error
      if (state.contentBlockOpen) {
        writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: state.contentBlockIndex });
      }
      writeSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: 'Upstream returned empty stream' } });
    }
    res.end();
  } catch (err) {
    log('← OPENCODE', `Stream error: ${err}`, COLORS.red);
    // Ensure content block is closed before error
    if (state.contentBlockOpen) {
      writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: state.contentBlockIndex });
    }
    if (state.messageStartSent) {
      writeSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: 'Stream error' } });
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

function pipeSSEStream(upstream: globalThis.Response, res: Response) {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const read = () => {
    reader.read().then(({ done, value }: { done: boolean; value?: Uint8Array }) => {
      if (done) {
        // Flush remaining buffer
        if (buffer.trim()) {
          res.write(buffer + '\n');
        }
        res.end();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      // For SSE, each line is typically a complete event line
      // We reassemble full SSE events (data may span multiple lines in spec,
      // but most SSE senders from this upstream send one line per event field)
      let output = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
          // Empty line = end of an SSE event, pass through
        }
        output += line + '\n';
      }
      if (output) {
        res.write(output);
      }

      read();
    }).catch((err: Error) => {
      log('← OPENCODE', `Stream error: ${err.message}`, COLORS.red);
      res.end();
    });
  };

  read();
}

// ── Helpers ────────────────────────────────────────────────────────

function getApiKey(req: Request): string {
  return (req as any).resolvedApiKey || config.apiKey;
}

async function handleUpstreamError(res: Response, response: globalThis.Response): Promise<boolean> {
  if (response.ok) return false;
  const errorText = await response.text();
  log('← OPENCODE', `Error ${response.status}: ${errorText}`, COLORS.red);

  // Translate OpenAI-format errors to Anthropic format
  let anthropicError: { type: string; message: string };
  try {
    const parsed = JSON.parse(errorText);
    const openAIError = parsed?.error || parsed;
    if (typeof openAIError === 'object' && openAIError.message) {
      anthropicError = {
        type: translateErrorType(openAIError.type || openAIError.code || 'api_error'),
        message: openAIError.message,
      };
    } else {
      throw new Error('not a structured error');
    }
  } catch {
    anthropicError = { type: 'api_error', message: errorText };
  }

  res.status(response.status).json({ error: anthropicError });
  return true;
}

function translateErrorType(openAIErrorType: string): string {
  const map: Record<string, string> = {
    'invalid_request_error': 'invalid_request_error',
    'authentication_error': 'authentication_error',
    'permission_error': 'permission_error',
    'not_found': 'not_found',
    'rate_limit_error': 'rate_limit_error',
    'rate_limit': 'rate_limit_error',
    'insufficient_quota': 'permission_error',
    'server_error': 'api_error',
    'api_error': 'api_error',
    'context_length_exceeded': 'invalid_request_error',
  };
  return map[openAIErrorType] || 'api_error';
}

// ── POST /v1/messages ──────────────────────────────────────────────

app.post('/v1/messages', rateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    const request: AnthropicRequest = req.body;

    if (!request.messages || request.messages.length === 0) {
      return res.status(400).json({
        error: { type: 'invalid_request_error', message: 'messages is required' },
      });
    }

    const { model, isAnthropic } = getUpstreamModel(request.model || config.defaultModel);
    const isStream = request.stream;

    log('⚙️  ROUTE', `Model: ${model}, Stream: ${isStream}, API: ${isAnthropic ? 'Anthropic' : 'OpenAI'}`, COLORS.yellow);

    if (isAnthropic) {
      // Anthropic-native: forward as-is (no conversion needed)
      if (isStream) {
        const response = await callOpenCodeGoAnthropicStream(
          { ...request, stream: true },
          model,
          getApiKey(req),
        );

        if (await handleUpstreamError(res, response)) return;
        if (!response.body) {
          return res.status(500).json({ error: { type: 'api_error', message: 'No response body' } });
        }

        log('← OPENCODE', 'Streaming started (Anthropic passthrough)', COLORS.green);
        return pipeSSEStream(response, res);
      } else {
        const response = await callOpenCodeGoAnthropic(request, model, getApiKey(req));
        if (await handleUpstreamError(res, response)) return;
        const data = await response.json();
        log('← OPENCODE', `Status: ${response.status}`, COLORS.green);
        log('  RESPONSE', formatBody(data), COLORS.green);
        return res.json(data);
      }
    } else {
      // OpenAI model: convert Anthropic → OpenAI, call, convert back
      const openAIRequest = buildOpenAIRequest(request, model);

      if (isStream) {
        const response = await callOpenCodeGoStream(
          { ...openAIRequest, stream: true } as OpenAIRequest & { stream: true },
          model,
          getApiKey(req),
        );

        if (await handleUpstreamError(res, response)) return;
        if (!response.body) {
          return res.status(500).json({ error: { type: 'api_error', message: 'No response body' } });
        }

        log('← OPENCODE', 'Streaming started (translating OpenAI→Anthropic)', COLORS.green);
        return await translateAndStreamOpenAI(response, res, model);
      } else {
        const response = await callOpenCodeGo(openAIRequest, model, getApiKey(req));

        if (await handleUpstreamError(res, response)) return;

        const openAIResponse = (await response.json()) as OpenAIResponse;
        const anthropicResponse = convertToAnthropicResponse(openAIResponse, request.model || config.defaultModel);
        log('← OPENCODE', `Status: ${response.status}`, COLORS.green);
        log('  RESPONSE', formatBody(anthropicResponse), COLORS.green);
        return res.json(anthropicResponse);
      }
    }
  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: { type: 'api_error', message: error instanceof Error ? error.message : 'Internal server error' },
      });
    }
  }
});

// ── POST /v1/messages/count_tokens ─────────────────────────────────

app.post('/v1/messages/count_tokens', (_req: Request, res: Response) => {
  // Rough estimation: ~4 chars per token for Chinese/English mixed text
  // This is adequate for the proxy use case
  const body = _req.body || {};
  const text = JSON.stringify(body);
  const estimatedTokens = Math.ceil(text.length / 4);
  return res.json({ input_tokens: estimatedTokens });
});

// ── POST /v1/chat/completions (OpenAI-compatible) ──────────────────

app.post('/v1/chat/completions', rateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    const openAIRequest: OpenAIRequest = req.body;

    if (!openAIRequest.messages || openAIRequest.messages.length === 0) {
      return res.status(400).json({
        error: { type: 'invalid_request_error', message: 'messages is required' },
      });
    }

    const { model } = getUpstreamModel(openAIRequest.model || config.defaultModel);
    const isStream = openAIRequest.stream;

    log('⚙️  ROUTE', `[OpenAI] Model: ${model}, Stream: ${isStream}`, COLORS.yellow);

    if (isStream) {
      const response = await callOpenCodeGoStream(
        { ...openAIRequest, stream: true } as OpenAIRequest & { stream: true },
        model,
        getApiKey(req),
      );

      if (await handleUpstreamError(res, response)) return;

      if (!response.body) {
        return res.status(500).json({ error: { type: 'api_error', message: 'No response body' } });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            res.write(buffer + '\n');
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          res.write(line + '\n');
        }
      }
      res.end();
    } else {
      const response = await callOpenCodeGo(openAIRequest, model, getApiKey(req));
      if (await handleUpstreamError(res, response)) return;
      const data = await response.json();
      log('← OPENCODE', `Status: ${response.status}`, COLORS.green);
      return res.json(data);
    }
  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: { type: 'api_error', message: error instanceof Error ? error.message : 'Internal server error' },
      });
    }
  }
});

// ── POST /v1/embeddings ────────────────────────────────────────────

app.post('/v1/embeddings', rateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    const apiKey = getApiKey(req);
    const { model } = getUpstreamModel(req.body?.model || config.defaultModel);
    const endpoint = `${config.baseUrl}/embeddings`;

    log('→ OPENCODE', `POST ${endpoint} [Model: ${model}]`, COLORS.magenta);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...req.body, model }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log('← OPENCODE', `Embedding error ${response.status}: ${errorText}`, COLORS.red);
      return res.status(response.status).json({ error: { type: 'api_error', message: errorText } });
    }

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    console.error('Embedding error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: { type: 'api_error', message: error instanceof Error ? error.message : 'Internal server error' },
      });
    }
  }
});

// ── GET /v1/models ─────────────────────────────────────────────────

app.get('/v1/models', (_req: Request, res: Response) => {
  return res.json({
    object: 'list',
    data: ALL_MODELS.map((id) => ({ id, object: 'model' })),
  });
});

// ── GET /health ────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    opencode_go_url: config.baseUrl,
    default_model: config.defaultModel,
    timestamp: new Date().toISOString(),
  });
});

// ── Start Server ───────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`\n${COLORS.bold}${COLORS.cyan}OpenCode Anthropic Proxy running on port ${config.port}${COLORS.reset}`);
  console.log(`${COLORS.cyan}OpenCode Go API: ${config.baseUrl}${COLORS.reset}`);
  console.log(`${COLORS.cyan}Default model: ${config.defaultModel}${COLORS.reset}`);
  console.log(`${COLORS.cyan}Health check: http://localhost:${config.port}/health${COLORS.reset}`);
  if (config.rateLimit.enabled) {
    console.log(`${COLORS.yellow}Rate limit: ${config.rateLimit.maxRequests} req / ${config.rateLimit.windowMs}ms${COLORS.reset}`);
  }
  console.log('');
});
