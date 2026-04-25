import process from 'node:process';

export const config = {
  apiKey: process.env.OPENCODE_GO_API_KEY || '',
  baseUrl: process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1',
  defaultModel: process.env.OPENCODE_MODEL || 'qwen3.6-plus',
  port: parseInt(process.env.PROXY_PORT || '4141', 10),

  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED === 'true',
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
  },
};

export const ALL_MODELS = [
  'qwen3.6-plus',
  'qwen3.5-plus',
  'glm-5.1',
  'glm-5',
  'kimi-k2.5',
  'kimi-k2.6',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'minimax-m2.7',
  'minimax-m2.5',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
];

const ANTHROPIC_NATIVE = new Set(['minimax-m2.7', 'minimax-m2.5']);

// Models that do NOT support vision/image input. Add new text-only models here.
export const NO_VISION = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
]);

export function getModelEndpoint(model: string): string {
  if (ANTHROPIC_NATIVE.has(model)) {
    return `${config.baseUrl}/messages`;
  }
  return `${config.baseUrl}/chat/completions`;
}

export function isAnthropicNativeModel(model: string): boolean {
  return ANTHROPIC_NATIVE.has(model);
}
