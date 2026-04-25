// verify: error translation + enable_thinking condition

// ── translateErrorType (from src/index.ts) ──
function translateErrorType(openAIErrorType: string): string {
  const map: Record<string, string> = {
    'invalid_request_error': 'invalid_request_error',
    'authentication_error':  'authentication_error',
    'permission_error':      'permission_error',
    'not_found':             'not_found',
    'rate_limit_error':      'rate_limit_error',
    'rate_limit':            'rate_limit_error',
    'insufficient_quota':    'permission_error',
    'server_error':          'api_error',
    'api_error':             'api_error',
    'context_length_exceeded': 'invalid_request_error',
  };
  return map[openAIErrorType] || 'api_error';
}

// ── enable_thinking condition (from src/translate.ts) ──
function shouldEnableThinking(requestThinking: { type: string } | undefined, model: string): boolean {
  return requestThinking?.type === 'enabled' || model.toLowerCase().includes('deepseek');
}

let pass = 0, fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('✓', msg); }
  else      { fail++; console.log('✗', msg); }
}

// ========== 1. translateErrorType ==========
console.log('=== translateErrorType ===');
check(translateErrorType('rate_limit')              === 'rate_limit_error',      'rate_limit → rate_limit_error');
check(translateErrorType('rate_limit_error')        === 'rate_limit_error',      'rate_limit_error passthrough');
check(translateErrorType('insufficient_quota')      === 'permission_error',       'insufficient_quota → permission_error');
check(translateErrorType('context_length_exceeded') === 'invalid_request_error', 'context_length_exceeded → invalid_request_error');
check(translateErrorType('server_error')            === 'api_error',              'server_error → api_error');
check(translateErrorType('authentication_error')    === 'authentication_error',  'authentication_error passthrough');
check(translateErrorType('invalid_request_error')   === 'invalid_request_error', 'invalid_request_error passthrough');
check(translateErrorType('permission_error')        === 'permission_error',       'permission_error passthrough');
check(translateErrorType('not_found')               === 'not_found',              'not_found passthrough');
check(translateErrorType('unknown_xyz')             === 'api_error',              'unknown type → api_error fallback');

// ========== 2. enable_thinking ==========
console.log('\n=== enable_thinking condition ===');
// Old bug: non-DeepSeek models with thinking.enabled would NOT get enable_thinking
check(shouldEnableThinking({ type: 'enabled' }, 'qwen3.6-plus')       === true,  'thinking=enabled + qwen → true (NEW FIX)');
check(shouldEnableThinking({ type: 'enabled' }, 'glm-5.1')            === true,  'thinking=enabled + glm → true');
check(shouldEnableThinking({ type: 'enabled' }, 'kimi-k2.6')          === true,  'thinking=enabled + kimi → true');
// DeepSeek still works without explicit thinking
check(shouldEnableThinking(undefined, 'deepseek-v4-pro')               === true,  'no thinking + deepseek → true (backward compat)');
check(shouldEnableThinking(undefined, 'deepseek-v4-flash')             === true,  'no thinking + deepseek-flash → true');
// Non-DeepSeek without thinking → false
check(shouldEnableThinking(undefined, 'qwen3.6-plus')                  === false, 'no thinking + qwen → false');
check(shouldEnableThinking(undefined, 'minimax-m2.7')                  === false, 'no thinking + minimax → false');
// Disabled thinking should NOT enable it
check(shouldEnableThinking({ type: 'disabled' } as any, 'qwen3.6-plus')=== false, 'thinking=disabled + qwen → false');
// DeepSeek OR 条件：即使 disabled，模型名含 deepseek 仍会开启
check(shouldEnableThinking({ type: 'disabled' } as any, 'deepseek-v4-pro')=== true, 'thinking=disabled + deepseek → true (model match wins)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
