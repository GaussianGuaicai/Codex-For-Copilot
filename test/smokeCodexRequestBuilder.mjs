import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexRequestBuilder.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
try {
  const { buildCodexResponsesRequest, buildCodexResponsesWebSocketEvent, areCodexRequestsIncrementallyCompatible } = loaded.exports;
  const identity = {
    installationId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    turnId: '44444444-4444-4444-8444-444444444444',
    windowId: '55555555-5555-4555-8555-555555555555'
  };
  const base = {
    compatibilityEnabled: true,
    identity,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
    reasoning: { effort: 'high', summary: 'auto' },
    maxOutputTokens: 100,
    omitMaxOutputTokens: true,
    textVerbosity: 'medium'
  };
  const request = buildCodexResponsesRequest(base);
  const appended = buildCodexResponsesRequest({ ...base, input: [...base.input, { type: 'message', role: 'user', content: 'next' }] });
  const event = buildCodexResponsesWebSocketEvent(base, false);
  assertEqual(request.prompt_cache_key, identity.threadId, 'stable prompt cache key');
  assertEqual(request.client_metadata.turn_id, identity.turnId, 'turn metadata');
  assertEqual(request.parallel_tool_calls, true, 'parallel tools');
  assertEqual(request.include[0], 'reasoning.encrypted_content', 'encrypted reasoning include');
  assertEqual(event.generate, false, 'prewarm generate flag');
  assertEqual('stream' in event, false, 'WebSocket stream omitted');
  assertEqual(areCodexRequestsIncrementallyCompatible(request, appended), true, 'input ignored by request fingerprint');
  console.log('Smoke test passed: shared Codex request construction and incremental fingerprint are correct.');
} finally {
  await loaded.dispose();
}
