<p align="right">
  <a href="README.zh.md">中文</a> | <strong>English</strong>
</p>

# opencode-api

Proxy service that translates Anthropic API format to OpenCode Go API format. Use OpenCode models with Claude Code and other Anthropic-compatible tools.

## Features

- **Anthropic ↔ OpenAI format translation** — Converts Anthropic Messages API requests to OpenAI Chat Completions format and translates responses back
- **Streaming SSE translation** — Real-time chunk-by-chunk translation of streaming responses with full Anthropic event semantics
- **Dual-path routing** — Anthropic-native models (MiniMax) forwarded as-is; all other models translated through OpenAI path
- **Tool use / Function calling** — Full support for Anthropic tool_use → OpenAI function calls and back, including `tool_choice` mapping
- **OpenAI-compatible endpoint** — `/v1/chat/completions` for tools that speak OpenAI format natively
- **Embeddings support** — `/v1/embeddings` passthrough to OpenCode
- **Image support** — Base64 images in Anthropic content blocks converted to OpenAI image_url format
- **Thinking / Reasoning** — Thinking blocks preserved and translated
- **Token estimation** — Realistic `count_tokens` estimation
- **Rate limiting** — Optional configurable rate limiter
- **Flexible auth** — API key accepted via `x-api-key` header, `Authorization: Bearer` header, or environment variable

## Installation

### Global Install (npm)

```bash
npm install -g opencode-api
```

### Local Development

```bash
git clone https://github.com/ChineseFirstKeng/opencode-api.git
cd opencode-api
npm install
cp .env.example .env
```

## Quick Start

```bash
# Global
opencode-api start

# Local dev
npm run dev
```

The proxy starts at `http://localhost:4141`. Check `http://localhost:4141/health` to verify.

## Usage

### With Claude Code

Claude passes the API key via `ANTHROPIC_AUTH_TOKEN` env var, which is sent as the `x-api-key` header:

```bash
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=your-opencode-go-key \
ANTHROPIC_MODEL=qwen3.6-plus \
claude
```

### With .claude/settings.json

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "your-opencode-go-key",
    "ANTHROPIC_MODEL": "qwen3.6-plus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3.6-plus",
    "ANTHROPIC_SMALL_FAST_MODEL": "qwen3.6-plus",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1"
  }
}
```

### With curl (Anthropic format)

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-opencode-go-key" \
  -d '{"model": "qwen3.6-plus", "max_tokens": 100, "messages": [{"role": "user", "content": "Hello"}]}'

# With streaming
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-opencode-go-key" \
  -d '{"model": "qwen3.6-plus", "max_tokens": 100, "messages": [{"role": "user", "content": "Hello, how are you?"}], "stream": true}'
```

### With curl (OpenAI format)

```bash
curl -X POST http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-opencode-go-key" \
  -d '{"model": "qwen3.6-plus", "max_tokens": 100, "messages": [{"role": "user", "content": "Hello"}]}'
```

### With tools

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-opencode-go-key" \
  -d '{
    "model": "qwen3.6-plus",
    "max_tokens": 200,
    "tools": [{
      "name": "get_weather",
      "description": "Get the current weather for a location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {"type": "string", "description": "City name"}
        },
        "required": ["location"]
      }
    }],
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}]
  }'
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_GO_API_KEY` | Fallback API key if client doesn't provide one | - |
| `OPENCODE_GO_BASE_URL` | OpenCode Go API base URL | `https://opencode.ai/zen/go/v1` |
| `OPENCODE_MODEL` | Default model to use | `qwen3.6-plus` |
| `PROXY_PORT` | Proxy listen port | `4141` |
| `RATE_LIMIT_ENABLED` | Enable rate limiting | `false` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds | `60000` |
| `RATE_LIMIT_MAX` | Max requests per window | `30` |

**API Key resolution order:**

1. `x-api-key` HTTP header
2. `Authorization: Bearer <key>` HTTP header
3. `OPENCODE_GO_API_KEY` environment variable

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API — streaming, tool use, text+image |
| `/v1/messages/count_tokens` | POST | Token estimation |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API |
| `/v1/embeddings` | POST | OpenAI Embeddings API |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |

## Architecture

```
┌─────────────┐     Anthropic Format      ┌─────────────────┐     OpenAI Format       ┌──────────────────┐
│  Claude Code │ ────────────────────────> │  opencode-api   │ ──────────────────────> │  opencode.ai     │
│  (or curl)   │ <──────────────────────── │  port 4141      │ <────────────────────── │  /zen/go/v1      │
└─────────────┘     Anthropic Format       └─────────────────┘     OpenAI Format         └──────────────────┘
```

## Project Structure

```
src/
  index.ts       — Express app setup, routes, server start
  config.ts      — Configuration, environment variables, model list
  types.ts       — TypeScript type definitions
  logger.ts      — Logging utilities with color output
  translate.ts   — Anthropic ↔ OpenAI message/tool translation
  stream.ts      — SSE stream translation (OpenAI chunk → Anthropic event)
  opencode.ts    — OpenCode Go API client and model routing
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `opencode-api start` | Start the proxy server |
| `opencode-api --help` | Show help |

## Testing

```bash
# Start proxy first
npm run dev

# Run tests in another terminal
npm test
```

The test suite covers: health check, model listing, non-streaming messages, streaming messages, system message handling, auth enforcement, token counting, OpenAI-format completions (both streaming and non-streaming).

## License

MIT
