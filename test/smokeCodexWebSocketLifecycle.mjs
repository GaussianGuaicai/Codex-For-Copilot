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
    webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }));
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
  const turnStates = [];
  const handshakeEvents = [];
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
    onTextDelta: (delta) => text.push(delta),
    onRawResponseItem: (item) => rawItems.push(item),
    onTurnState: (state) => turnStates.push(state),
    onWebSocketHandshake: (handshake) => handshakeEvents.push(handshake)
  });

  assertEqual(upgradeHeaders['openai-beta'], 'responses_websockets=2026-02-06', 'upgrade beta');
  assertEqual(upgradeHeaders['session-id'], '22222222-2222-4222-8222-222222222222', 'upgrade session');
  assertEqual(frames.length, 2, 'prewarm and response frames');
  assertEqual(frames[0].generate, false, 'prewarm frame');
  assertEqual(frames[1].previous_response_id, 'resp_warm', 'formal request continues prewarm');
  assertEqual(frames[1].input.length, 0, 'formal request sends incremental empty input');
  assertEqual(frames[1].client_metadata['x-codex-turn-state'], 'opaque-sticky-state', 'turn state replayed in frame');
  assertEqual(text.join(''), 'hello', 'visible output emitted once');
  assertEqual(rawItems.length, 1, 'raw output item retained');
  assertEqual(turnStates[0], 'opaque-sticky-state', 'turn state captured');
  assertEqual(handshakeEvents[0].modelsEtag, 'models-etag-test', 'models etag captured');
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
