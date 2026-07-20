import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responsesClient.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
const { streamResponseText, disposeReusableResponsesWebSockets } = loaded.exports;
const server = createServer();
const webSocketServer = new WebSocketServer({ noServer: true });
const frames = [];
let upgradeHeaders;

webSocketServer.on('headers', (headers) => {
  headers.push('x-codex-turn-state: opaque-sticky-state');
  headers.push('x-models-etag: models-etag-test');
  headers.push('x-reasoning-included: true');
  headers.push('openai-model: gpt-test');
});
server.on('upgrade', (request, socket, head) => {
  upgradeHeaders = request.headers;
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});
webSocketServer.on('connection', (webSocket) => {
  webSocket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    if (frame.generate === false) {
      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_warm', status: 'in_progress' } }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_warm', status: 'completed' } }));
      return;
    }
    webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_final', status: 'in_progress' } }));
    webSocket.send(JSON.stringify({
      type: 'response.reasoning_text.delta',
      item_id: 'rs_managed',
      output_index: 0,
      content_index: 0,
      delta: 'Planning',
      sequence_number: 1
    }));
    webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }));
    webSocket.send(JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      sequence_number: 2,
      item: {
        id: 'fc_managed',
        type: 'function_call',
        call_id: 'call_managed',
        name: 'read_pull_request',
        arguments: ''
      }
    }));
    webSocket.send(JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_managed',
      output_index: 1,
      sequence_number: 3,
      name: '',
      arguments: '{"number":10}'
    }));
    webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: ' after tool' }));
    webSocket.send(JSON.stringify({
      type: 'response.output_item.done',
      output_index: 1,
      sequence_number: 5,
      item: {
        id: 'fc_managed',
        type: 'function_call',
        call_id: 'call_managed',
        name: 'read_pull_request',
        arguments: '{"number":10}'
      }
    }));
    webSocket.send(JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'reasoning_1', encrypted_content: 'not-logged' }
    }));
    webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_final', status: 'completed' } }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const port = server.address().port;
  const text = [];
  const rawItems = [];
  const reasoningDeltas = [];
  const toolCalls = [];
  const presentation = [];
  const turnStates = [];
  const handshakeEvents = [];
  const transportMetrics = [];
  let responseCompleted = false;
  let preparedFormalRequestBeforeCompletion = false;
  await streamResponseText({
    baseURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    apiKey: 'test-token',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${port}/backend-api/codex/responses` },
    authIdentity: 'codexAuth:acct-test',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444444',
      windowId: '55555555-5555-4555-8555-555555555555'
    },
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)',
    websocketPrewarm: 'enabled',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    maxOutputTokens: 100,
    token: createCancellationToken(),
    onTextDelta: (delta) => {
      text.push(delta);
      presentation.push({ type: 'text', delta });
    },
    onReasoningTextDelta: (delta) => reasoningDeltas.push(delta),
    onToolCall: (callId, name, input) => {
      toolCalls.push({ callId, name, input });
      presentation.push({ type: 'tool', callId });
    },
    onRawResponseItem: (item) => rawItems.push(item),
    onTurnState: (state) => turnStates.push(state),
    onWebSocketHandshake: (handshake) => handshakeEvents.push(handshake),
    onTransportMetrics: (metrics) => {
      transportMetrics.push(metrics);
      if (!responseCompleted
        && metrics.requestBodyBytes > 0
        && metrics.previousResponseIdUsed === true) {
        preparedFormalRequestBeforeCompletion = true;
      }
    },
    onResponseCompleted() {
      responseCompleted = true;
    }
  });

  assertEqual(upgradeHeaders['openai-beta'], 'responses_websockets=2026-02-06', 'upgrade beta');
  assertEqual(upgradeHeaders['session-id'], '22222222-2222-4222-8222-222222222222', 'upgrade session');
  assertEqual(frames.length, 2, 'prewarm and response frames');
  assertEqual(frames[0].generate, false, 'prewarm frame');
  assertEqual(frames[1].previous_response_id, 'resp_warm', 'formal request continues prewarm');
  assertEqual(frames[1].input.length, 0, 'formal request sends incremental empty input');
  assertEqual(frames[1].client_metadata['x-codex-turn-state'], 'opaque-sticky-state', 'turn state replayed in frame');
  assertEqual(text.join(''), 'hello after tool', 'visible output emitted once');
  assertEqual(JSON.stringify(presentation), JSON.stringify([
    { type: 'text', delta: 'hello' },
    { type: 'tool', callId: 'call_managed' },
    { type: 'text', delta: ' after tool' }
  ]), 'managed WebSocket reports a completed tool call before later text');
  assertEqual(JSON.stringify(toolCalls), JSON.stringify([{
    callId: 'call_managed',
    name: 'read_pull_request',
    input: { number: 10 }
  }]), 'managed WebSocket reports a function call once');
  assertEqual(JSON.stringify(reasoningDeltas), JSON.stringify([{
    text: 'Planning',
    itemId: 'rs_managed',
    contentIndex: 0,
    outputIndex: 0
  }]), 'managed WebSocket reasoning item identity');
  assertEqual(rawItems.length, 2, 'raw output items retained');
  assertEqual(turnStates[0], 'opaque-sticky-state', 'turn state captured');
  assertEqual(handshakeEvents[0].modelsEtag, 'models-etag-test', 'models etag captured');
  assertEqual(preparedFormalRequestBeforeCompletion, true, 'formal request bytes emitted before completion');
  const formalRequestMetrics = transportMetrics.find((metrics) => metrics.previousResponseIdUsed === true
    && typeof metrics.websocketSerializeMs === 'number');
  assertEqual(typeof formalRequestMetrics?.websocketSerializeMs, 'number', 'WebSocket serialization timing is reported');
  assertEqual(
    formalRequestMetrics?.requestBodyBytes,
    Buffer.byteLength(JSON.stringify(frames[1])),
    'reported WebSocket bytes match the raw response.create frame'
  );

  await streamResponseText({
    baseURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    apiKey: 'test-token',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${port}/backend-api/codex/responses` },
    authIdentity: 'codexAuth:acct-test',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444445',
      windowId: '55555555-5555-4555-8555-555555555555'
    },
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)',
    websocketPrewarm: 'disabled',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"filePath":"src/provider.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' }
    ],
    maxOutputTokens: 100,
    token: createCancellationToken(),
    onTextDelta() {}
  });

  assertEqual(frames[2].previous_response_id, undefined, 'full tool replay omits previous response id');
  assertEqual(frames[2].input.length, 3, 'full tool replay retains matching function call');

  const toolOutputContinuationMetrics = [];
  await streamResponseText({
    baseURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    apiKey: 'test-token',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${port}/backend-api/codex/responses` },
    authIdentity: 'codexAuth:acct-test',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444445',
      windowId: '55555555-5555-4555-9555-555555555555'
    },
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)',
    websocketPrewarm: 'disabled',
    requestCompression: 'disabled',
    previousResponseId: 'resp_final',
    allowToolOutputContinuation: true,
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [{ type: 'function_call_output', call_id: 'call_managed', output: 'tool result' }],
    maxOutputTokens: 100,
    token: createCancellationToken(),
    onTextDelta() {},
    onTransportMetrics: (metrics) => toolOutputContinuationMetrics.push(metrics)
  });

  assertEqual(frames[3].previous_response_id, 'resp_final', 'tool-output continuation preserves previous response id');
  assertEqual(frames[3].input.length, 1, 'tool-output continuation sends only the appended result');
  assertEqual(frames[3].input[0].type, 'function_call_output', 'tool-output continuation preserves result type');
  assertEqual(
    toolOutputContinuationMetrics.some((metrics) => (
      metrics.previousResponseIdUsed === true && metrics.incrementalInputCount === 1
    )),
    true,
    'tool-output continuation reports previous response use'
  );

  const branchContinuationMetrics = [];
  await streamResponseText({
    baseURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    apiKey: 'test-token',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${port}/backend-api/codex/responses` },
    authIdentity: 'codexAuth:acct-test',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444446',
      windowId: '55555555-5555-8555-9555-555555555555'
    },
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)',
    websocketPrewarm: 'disabled',
    requestCompression: 'disabled',
    previousResponseId: 'resp_final',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [{ type: 'message', role: 'user', content: 'Continue this branch.' }],
    maxOutputTokens: 100,
    token: createCancellationToken(),
    onTextDelta() {},
    onTransportMetrics: (metrics) => branchContinuationMetrics.push(metrics)
  });

  assertEqual(frames[4].previous_response_id, 'resp_final', 'projected branch continuation preserves previous response id');
  assertEqual(frames[4].input.length, 1, 'projected branch continuation keeps only appended input');
  assertEqual(
    branchContinuationMetrics.some((metrics) => (
      metrics.previousResponseIdUsed === true && metrics.incrementalInputCount === 1
    )),
    true,
    'projected branch continuation reports previous response use'
  );
  console.log('Smoke test passed: managed WebSocket handshake, prewarm, continuation, Turn State, and raw items are correct.');
} finally {
  disposeReusableResponsesWebSockets();
  webSocketServer.close();
  server.close();
  await loaded.dispose();
}

function createCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() { return { dispose() {} }; }
  };
}
