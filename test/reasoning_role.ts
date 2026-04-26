/**
 * Unit test: Verify reasoning_content handling for DeepSeek thinking mode.
 */

import { convertToOpenAIMessages, buildOpenAIRequest } from '../src/translate';

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

function testThinkingConvertedToReasoningContent() {
  console.log('\n=== Test: thinking blocks → reasoning_content field ===');

  const messages = convertToOpenAIMessages({
    model: 'deepseek-v4-pro',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'What is 2+2?',
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me calculate 2+2...' },
          { type: 'text', text: 'The answer is 4.' },
        ],
      },
      {
        role: 'user',
        content: 'What about 3+3?',
      },
    ],
    stream: false,
  }, 'deepseek-v4-pro');

  // Should have 3 messages: user, assistant, user
  assert(messages.length === 3, `Expected 3 messages, got ${messages.length}`);

  // Assistant message should have reasoning_content field
  assert(messages[1].role === 'assistant', 'Second message role is assistant');
  assert(
    messages[1].content === 'The answer is 4.',
    `Assistant content is "The answer is 4.", got: "${messages[1].content}"`,
  );
  assert(
    (messages[1] as any).reasoning_content === 'Let me calculate 2+2...',
    `Assistant has reasoning_content field`,
  );
}

function testNoThinkingWhenOnlyText() {
  console.log('\n=== Test: text-only assistant → no reasoning_content ===');

  const messages = convertToOpenAIMessages({
    model: 'deepseek-v4-pro',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Hello',
      },
      {
        role: 'assistant',
        content: 'Hi there!',
      },
    ],
    stream: false,
  }, 'deepseek-v4-pro');

  assert(messages.length === 2, `Expected 2 messages, got ${messages.length}`);
  assert(messages[1].role === 'assistant', 'Message role is assistant');
  assert(
    !(messages[1] as any).reasoning_content,
    'No reasoning_content on plain assistant message',
  );
}

function testDeepSeekFirstRoundNoEnableThinking() {
  console.log('\n=== Test: DeepSeek first round → no enable_thinking ===');

  // First round: no prior reasoning
  const req1 = buildOpenAIRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  }, 'deepseek-v4-pro');

  assert(req1.enable_thinking === undefined, 'DeepSeek first round has NO enable_thinking (no reasoning history)');
}

function testDeepSeekSecondRoundHasEnableThinking() {
  console.log('\n=== Test: DeepSeek second round → has enable_thinking ===');

  // Second round: has reasoning history
  const req2 = buildOpenAIRequest({
    model: 'deepseek-v4-pro',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Hmm...' },
          { type: 'text', text: 'Hi!' },
        ],
      },
      { role: 'user', content: 'How are you?' },
    ],
    stream: true,
  }, 'deepseek-v4-pro');

  assert(req2.enable_thinking === true, 'DeepSeek second round has enable_thinking (has reasoning history)');
  // Check reasoning_content is on the assistant message
  const assistantMsg = req2.messages.find(m => m.role === 'assistant');
  assert(
    (assistantMsg as any)?.reasoning_content === 'Hmm...',
    'Assistant message has reasoning_content field',
  );
}

function testNonDeepSeekNoEnableThinking() {
  console.log('\n=== Test: Non-DeepSeek → no enable_thinking ===');

  const req = buildOpenAIRequest({
    model: 'qwen3.6-plus',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  }, 'qwen3.6-plus');

  assert(req.enable_thinking === undefined, 'Non-DeepSeek has no enable_thinking');
}

function testExplicitThinkingOverride() {
  console.log('\n=== Test: explicit thinking type overrides model check ===');

  // Even for non-DeepSeek model, explicit thinking type should enable it
  const req = buildOpenAIRequest({
    model: 'qwen3.6-plus',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
    thinking: { type: 'enabled' },
  }, 'qwen3.6-plus');

  assert(req.enable_thinking === true, 'Explicit thinking type enables enable_thinking');
}

function runTests() {
  console.log('OpenCode Reasoning Content Unit Tests');

  try { testThinkingConvertedToReasoningContent(); } catch (e) { console.log(`  ✗ crashed: ${e}`); failed++; }
  try { testNoThinkingWhenOnlyText(); } catch (e) { console.log(`  ✗ crashed: ${e}`); failed++; }
  try { testDeepSeekFirstRoundNoEnableThinking(); } catch (e) { console.log(`  ✗ crashed: ${e}`); failed++; }
  try { testDeepSeekSecondRoundHasEnableThinking(); } catch (e) { console.log(`  ✗ crashed: ${e}`); failed++; }
  try { testNonDeepSeekNoEnableThinking(); } catch (e) { console.log(`  ✗ crashed: ${e}`); failed++; }
  try { testExplicitThinkingOverride(); } catch (e) { console.log(`  ✗ crashed: ${e}`); failed++; }

  const total = passed + failed;
  console.log(`\n=== Results: ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
