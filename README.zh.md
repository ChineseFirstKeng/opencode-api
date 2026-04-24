<p align="right">
  <strong>中文</strong> | <a href="README.md">English</a>
</p>

# opencode-api

一个代理服务，将 Anthropic API 格式转换为 OpenCode Go API 格式。让你在 Claude Code 和其他兼容 Anthropic 的工具中使用 OpenCode 模型。

## 功能

- **Anthropic ↔ OpenAI 格式转换** — 将 Anthropic Messages API 请求转为 OpenAI Chat Completions 格式，再将响应转回
- **流式 SSE 翻译** — 实时逐块翻译流式响应，完整保留 Anthropic 事件语义
- **双路径路由** — 原生 Anthropic 模型（MiniMax）直接转发；其余模型通过 OpenAI 路径翻译
- **工具调用** — 完整支持 Anthropic tool_use ↔ OpenAI function calls，包括 `tool_choice` 映射
- **OpenAI 兼容端点** — `/v1/chat/completions` 供原生 OpenAI 客户端使用
- **Embeddings 支持** — `/v1/embeddings` 透传到 OpenCode
- **图片支持** — Anthropic 内容块中的 Base64 图片自动转为 OpenAI image_url 格式
- **思考/推理** — 保留并翻译 thinking 块
- **Token 估算** — `count_tokens` 真实估算而非固定返回 0
- **频率限制** — 可选的可配置速率限制器
- **灵活认证** — 支持通过 `x-api-key` 头、`Authorization: Bearer` 头或环境变量传入 API Key

## 安装

### 全局安装

```bash
npm install -g opencode-api
```

### 本地开发

```bash
git clone https://github.com/ChineseFirstKeng/opencode-api.git
cd opencode-api
npm install
cp .env.example .env
```

## 快速开始

```bash
# 全局启动
opencode-api start

# 本地开发
npm run dev
```

代理启动于 `http://localhost:4141`。访问 `http://localhost:4141/health` 确认运行状态。

## 使用方式

### 配合 Claude Code

Claude 通过 `ANTHROPIC_AUTH_TOKEN` 环境变量传入 API Key，代理将其作为 `x-api-key` 请求头：

```bash
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=your-opencode-go-key \
ANTHROPIC_MODEL=qwen3.6-plus \
claude
```

### 通过配置文件 .claude/settings.json

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

### Anthropic 格式调用

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-opencode-go-key" \
  -d '{"model": "qwen3.6-plus", "max_tokens": 100, "messages": [{"role": "user", "content": "你好"}]}'

# 流式请求
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-opencode-go-key" \
  -d '{"model": "qwen3.6-plus", "max_tokens": 100, "messages": [{"role": "user", "content": "你好"}], "stream": true}'
```

### OpenAI 格式调用

```bash
curl -X POST http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-opencode-go-key" \
  -d '{"model": "qwen3.6-plus", "max_tokens": 100, "messages": [{"role": "user", "content": "你好"}]}'
```

### 工具调用示例

```bash
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-opencode-go-key" \
  -d '{
    "model": "qwen3.6-plus",
    "max_tokens": 200,
    "tools": [{
      "name": "get_weather",
      "description": "获取某个地点的当前天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": {"type": "string", "description": "城市名称"}
        },
        "required": ["location"]
      }
    }],
    "messages": [{"role": "user", "content": "东京的天气怎么样？"}]
  }'
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCODE_GO_API_KEY` | 备用 API Key（客户端未提供时使用） | - |
| `OPENCODE_GO_BASE_URL` | OpenCode Go API 基础地址 | `https://opencode.ai/zen/go/v1` |
| `OPENCODE_MODEL` | 默认模型 | `qwen3.6-plus` |
| `PROXY_PORT` | 代理监听端口 | `4141` |
| `RATE_LIMIT_ENABLED` | 启用速率限制 | `false` |
| `RATE_LIMIT_WINDOW_MS` | 速率限制时间窗口（毫秒） | `60000` |
| `RATE_LIMIT_MAX` | 窗口内最大请求数 | `30` |

**API Key 解析优先级：**

1. `x-api-key` HTTP 请求头
2. `Authorization: Bearer <key>` HTTP 请求头
3. `OPENCODE_GO_API_KEY` 环境变量

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | Anthropic Messages API — 流式、工具调用、图文混合 |
| `/v1/messages/count_tokens` | POST | Token 估算 |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API |
| `/v1/embeddings` | POST | OpenAI Embeddings API |
| `/v1/models` | GET | 列出可用模型 |
| `/health` | GET | 健康检查 |

## 项目结构

```
src/
  index.ts       — Express 应用、路由、服务器启动
  config.ts      — 配置、环境变量、模型列表
  types.ts       — TypeScript 类型定义
  logger.ts      — 带颜色的日志工具
  translate.ts   — Anthropic ↔ OpenAI 消息/工具翻译
  stream.ts      — SSE 流翻译（OpenAI 块 → Anthropic 事件）
  opencode.ts    — OpenCode Go API 客户端和模型路由
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `opencode-api start` | 启动代理服务器 |
| `opencode-api --help` | 显示帮助 |

## 测试

```bash
# 先启动代理
npm run dev

# 在另一个终端运行测试
npm test
```

测试覆盖：健康检查、模型列表、非流式/流式消息、系统消息、认证检查、Token 计数、OpenAI 格式接口。

## 许可证

MIT
