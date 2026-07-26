import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexRequestBuilder.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
try {
  const {
    areCodexRequestsIncrementallyCompatible,
    buildCodexResponsesRequest,
    buildCodexResponsesRequestWithMetrics,
    buildCodexResponsesWebSocketEvent,
    resetCodexToolSchemaCache
  } = loaded.exports;
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
  const compatibilityDefaultReasoningRequest = buildCodexResponsesRequest({
    ...base,
    reasoning: undefined,
    tools: []
  });
  const standardRequest = buildCodexResponsesRequest({
    ...base,
    compatibilityEnabled: false,
    reasoning: undefined,
    tools: []
  });
  const continuationInput = [
    { type: 'message', id: '', role: 'assistant', content: 'empty id' },
    { type: 'message', id: 'legacy-message-id', role: 'assistant', content: 'legacy id' },
    { type: 'message', id: 'msg_valid123', role: 'assistant', content: 'valid message id' },
    { type: 'function_call', id: 'fc_valid123', call_id: 'call_valid', name: 'read', arguments: '{}' },
    { type: 'function_call_output', id: 'legacy-output-id', call_id: 'call_valid', output: 'result' }
  ];
  const sanitizedHttpRequest = buildCodexResponsesRequest({
    ...base,
    input: continuationInput,
    tools: []
  });
  const sanitizedWebSocketEvent = buildCodexResponsesWebSocketEvent({
    ...base,
    input: continuationInput,
    tools: []
  });
  const appended = buildCodexResponsesRequest({ ...base, input: [...base.input, { type: 'message', role: 'user', content: 'next' }] });
  const event = buildCodexResponsesWebSocketEvent(base, false);
  resetCodexToolSchemaCache();
  const firstBuild = buildCodexResponsesRequestWithMetrics(base);
  const secondBuild = buildCodexResponsesRequestWithMetrics(base);
  assertEqual(request.prompt_cache_key, identity.threadId, 'stable prompt cache key');
  assertEqual(request.client_metadata.turn_id, identity.turnId, 'turn metadata');
  assertEqual(request.parallel_tool_calls, true, 'parallel tools');
  assertEqual(request.instructions, base.instructions, 'configured instructions preserved with tools');
  assertEqual(request.include[0], 'reasoning.encrypted_content', 'encrypted reasoning include');
  assertEqual(JSON.stringify(request.reasoning), JSON.stringify({ effort: 'high', summary: 'auto' }), 'explicit compatibility reasoning preserved');
  assertEqual(JSON.stringify(compatibilityDefaultReasoningRequest.reasoning), JSON.stringify({ effort: 'medium', summary: 'auto' }), 'compatibility default reasoning is normalized');
  assertEqual(compatibilityDefaultReasoningRequest.include[0], 'reasoning.encrypted_content', 'compatibility default reasoning requests encrypted content');
  assertEqual('reasoning' in standardRequest, false, 'standard request does not add default reasoning');
  assertEqual('include' in standardRequest, false, 'standard request does not request encrypted reasoning');
  assertEqual('id' in sanitizedHttpRequest.input[0], false, 'HTTP continuation omits empty response item id');
  assertEqual('id' in sanitizedHttpRequest.input[1], false, 'HTTP continuation omits legacy response item id');
  assertEqual(sanitizedHttpRequest.input[2].id, 'msg_valid123', 'HTTP continuation preserves valid response item id');
  assertEqual(sanitizedHttpRequest.input[3].id, 'fc_valid123', 'HTTP continuation preserves valid function call item id');
  assertEqual(sanitizedHttpRequest.input[3].call_id, 'call_valid', 'HTTP continuation preserves call id');
  assertEqual('id' in sanitizedHttpRequest.input[4], false, 'HTTP continuation omits legacy tool output item id');
  assertEqual(sanitizedHttpRequest.input[4].call_id, 'call_valid', 'HTTP continuation preserves tool output call id');
  assertEqual('id' in sanitizedWebSocketEvent.input[1], false, 'WebSocket continuation omits legacy response item id');
  assertEqual(sanitizedWebSocketEvent.input[2].id, 'msg_valid123', 'WebSocket continuation preserves valid response item id');
  assertEqual(sanitizedWebSocketEvent.input[4].call_id, 'call_valid', 'WebSocket continuation preserves tool output call id');
  assertEqual(event.generate, false, 'prewarm generate flag');
  assertEqual('stream' in event, false, 'WebSocket stream omitted');
  assertEqual(areCodexRequestsIncrementallyCompatible(request, appended), true, 'input ignored by request fingerprint');
  assertEqual(firstBuild.metrics.toolSchemaCacheHit, false, 'first request build reports schema cache miss');
  assertEqual(secondBuild.metrics.toolSchemaCacheHit, true, 'second request build reports schema cache hit');
  assertEqual(firstBuild.metrics.toolSchemaBytes > 0, true, 'request build reports tool schema bytes');
  assertEqual(secondBuild.metrics.requestBuildMs >= 0, true, 'request build reports duration');
  console.log('Smoke test passed: shared Codex request construction and incremental fingerprint are correct.');
} finally {
  await loaded.dispose();
}
