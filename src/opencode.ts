import { config, getModelEndpoint, isAnthropicNativeModel } from './config';
import { log, formatBody, COLORS } from './logger';
import type { AnthropicRequest, OpenAIRequest } from './types';

async function apiFetch(endpoint: string, body: unknown, model: string, isAnthropic: boolean, apiKey?: string): Promise<globalThis.Response> {
  const key = apiKey || config.apiKey;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  };

  if (isAnthropic) {
    headers['anthropic-version'] = '2023-06-01';
  }

  log('→ OPENCODE', `POST ${endpoint} [Model: ${model}]`, COLORS.magenta);
  log('  BODY', formatBody(body), COLORS.dim);

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export async function callOpenCodeGo(requestBody: OpenAIRequest, model: string, apiKey?: string) {
  const endpoint = getModelEndpoint(model);
  return apiFetch(endpoint, requestBody, model, false, apiKey);
}

export async function callOpenCodeGoAnthropic(requestBody: AnthropicRequest, model: string, apiKey?: string) {
  const endpoint = getModelEndpoint(model);
  return apiFetch(endpoint, requestBody, model, true, apiKey);
}

export async function callOpenCodeGoStream(
  requestBody: OpenAIRequest & { stream: true },
  model: string,
  apiKey?: string,
): Promise<globalThis.Response> {
  const endpoint = getModelEndpoint(model);
  return apiFetch(endpoint, requestBody, model, false, apiKey);
}

export async function callOpenCodeGoAnthropicStream(
  requestBody: AnthropicRequest & { stream: true },
  model: string,
  apiKey?: string,
): Promise<globalThis.Response> {
  const endpoint = getModelEndpoint(model);
  return apiFetch(endpoint, requestBody, model, true, apiKey);
}

export function getUpstreamModel(model: string): { model: string; isAnthropic: boolean } {
  return { model, isAnthropic: isAnthropicNativeModel(model) };
}
