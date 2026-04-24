const BASE_URL = process.env.PROXY_URL || 'http://127.0.0.1:4141';
const API_KEY = process.env.OPENCODE_GO_API_KEY || '';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

async function testHealth() {
  console.log('\n=== Test: Health Check ===');
  const response = await fetch(`${BASE_URL}/health`);
  const data = await response.json();
  assert(response.ok, 'Status 200');
  assert(data.status === 'ok', 'status is ok');
  assert(typeof data.default_model === 'string', 'default_model present');
  return true;
}

async function testModels() {
  console.log('\n=== Test: List Models ===');
  const response = await fetch(`${BASE_URL}/v1/models`);
  const data = await response.json();
  assert(response.ok, 'Status 200');
  assert(data.data?.length > 0, 'Has models');
  return true;
}

async function testNonStreaming() {
  console.log('\n=== Test: Non-Streaming Message ===');
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say "Hello from OpenCode!" in one sentence.' }],
    }),
  });

  assert(response.ok, `Status ${response.status}`);
  if (!response.ok) {
    const err = await response.json();
    console.log('  Error:', JSON.stringify(err));
    return false;
  }

  const data = await response.json();
  assert(data.content?.[0]?.text?.length > 0, 'Has text response');
  assert(data.type === 'message', 'Response type is message');
  assert(data.role === 'assistant', 'Role is assistant');
  assert(data.stop_reason === 'end_turn', 'Stop reason is end_turn');
  assert(typeof data.usage?.input_tokens === 'number', 'Has input_tokens');
  assert(typeof data.usage?.output_tokens === 'number', 'Has output_tokens');
  return true;
}

async function testStreaming() {
  console.log('\n=== Test: Streaming Message ===');
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
      stream: true,
    }),
  });

  assert(response.ok, `Status ${response.status}`);
  if (!response.ok) return false;
  assert(!!response.body, 'Has response body');

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let eventCount = 0;
  let hasMessageStart = false;
  let hasMessageStop = false;
  let hasContentDelta = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          eventCount++;
          if (parsed.type === 'message_start') hasMessageStart = true;
          if (parsed.type === 'message_stop') hasMessageStop = true;
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            hasContentDelta = true;
            fullResponse += parsed.delta.text;
          }
        } catch { /* skip parse errors */ }
      }
    }
  }

  assert(hasMessageStart, 'Has message_start event');
  assert(hasContentDelta, 'Has content_block_delta events');
  assert(hasMessageStop, 'Has message_stop event');
  assert(fullResponse.length > 0, 'Has content text');
  console.log(`  Events: ${eventCount}, Response: "${fullResponse.slice(0, 80)}..."`);
  return true;
}

async function testSystemMessage() {
  console.log('\n=== Test: System Message ===');
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      max_tokens: 1024,
      system: 'You are a helpful assistant that always responds in Chinese.',
      messages: [{ role: 'user', content: 'Say "hello" in Chinese.' }],
    }),
  });

  assert(response.ok, `Status ${response.status}`);
  if (!response.ok) return false;

  const data = await response.json();
  assert(data.content?.[0]?.text?.length > 0, 'Has text response');
  return true;
}

async function testChatCompletions() {
  console.log('\n=== Test: OpenAI /v1/chat/completions ===');
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say "Hello from OpenAI endpoint!"' }],
    }),
  });

  assert(response.ok, `Status ${response.status}`);
  if (!response.ok) return false;

  const data = await response.json();
  assert(data.choices?.[0]?.message?.content?.length > 0, 'Has completion text');
  assert(data.object === 'chat.completion', 'Object type is chat.completion');
  return true;
}

async function testChatCompletionsStream() {
  console.log('\n=== Test: OpenAI /v1/chat/completions (Streaming) ===');
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Say "streaming works"' }],
      stream: true,
    }),
  });

  assert(response.ok, `Status ${response.status}`);
  if (!response.ok) return false;
  assert(!!response.body, 'Has response body');

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunks = 0;
  let hasContent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          chunks++;
          if (parsed.choices?.[0]?.delta?.content) hasContent = true;
        } catch { /* skip */ }
      }
    }
  }
  assert(chunks > 0, `Received ${chunks} chunks`);
  assert(hasContent, 'Has content in stream');
  return true;
}

async function testAuthFailure() {
  console.log('\n=== Test: Auth Failure ===');
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'test' }],
    }),
  });

  // Without API key, should return 401
  if (API_KEY) {
    assert(response.status === 401 || response.ok, 'Auth enforced (401 or passes with key from env)');
  } else {
    assert(response.status === 401, 'Returns 401 without API key');
  }
  return true;
}

async function testCountTokens() {
  console.log('\n=== Test: Count Tokens ===');
  const response = await fetch(`${BASE_URL}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello, world!' }],
    }),
  });

  assert(response.ok, `Status ${response.status}`);
  const data = await response.json();
  assert(typeof data.input_tokens === 'number', 'Returns input_tokens number');
  return true;
}

async function runTests() {
  console.log('Starting OpenCode Anthropic Proxy Tests...');
  console.log('Proxy URL:', BASE_URL);

  const tests = [
    testHealth,
    testModels,
    testAuthFailure,
    testCountTokens,
    testChatCompletions,
    testChatCompletionsStream,
  ];

  // These require a valid API key
  if (API_KEY) {
    tests.push(testNonStreaming);
    tests.push(testStreaming);
    tests.push(testSystemMessage);
  } else {
    console.log('\n⚠️  OPENCODE_GO_API_KEY not set — skipping model-dependent tests');
  }

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      console.log(`  ✗ crashed: ${error}`);
      failed++;
    }
  }

  const total = passed + failed;
  console.log(`\n=== Results: ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
