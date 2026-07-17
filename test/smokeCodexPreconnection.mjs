import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responsesClient.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
const { disposeReusableResponsesWebSockets, preconnectCodexResponsesWebSocket, streamResponseText } = loaded.exports;
const server = createServer();
const webSocketServer = new WebSocketServer({ noServer: true });
const frames = [];
let upgradeCount = 0;
let connectionCount = 0;
let preconnectHeaders;
let resolvePreconnected;
const preconnected = new Promise((resolve) => {
  resolvePreconnected = resolve;
});
let resolveHandshake;
const handshakeCompleted = new Promise((resolve) => {
  resolveHandshake = resolve;
});

server.on('upgrade', (request, socket, head) => {
  upgradeCount += 1;
  preconnectHeaders ??= request.headers;
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});

webSocketServer.on('connection', (webSocket) => {
  connectionCount += 1;
  resolvePreconnected();
  webSocket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_preconnected', status: 'in_progress' } }));
    webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'reused handshake' }));
    webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_preconnected', status: 'completed' } }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  const compatibilityProfile = { enabled: true, endpointKey: baseURL };
  const preconnectStarted = preconnectCodexResponsesWebSocket({
    baseURL,
    apiKey: 'test-api-key',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    compatibilityProfile,
    authIdentity: 'codexAuth:acct-test',
    extensionVersion: 'preconnection-smoke',
    userAgent: 'codex-for-copilot/preconnection-smoke',
    onConnected: (handshake) => resolveHandshake(handshake)
  });
  assertEqual(preconnectStarted, true, 'preconnection starts');
  const [handshake] = await Promise.all([handshakeCompleted, preconnected]);
  assertEqual(handshake.reasoningIncluded, false, 'preconnection handshake callback');

  const deltas = [];
  const sessionEvents = [];
  await streamResponseText({
    baseURL,
    apiKey: 'test-api-key',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile,
    authIdentity: 'codexAuth:acct-test',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444444',
      windowId: '55555555-5555-4555-8555-555555555555'
    },
    extensionVersion: 'preconnection-smoke',
    userAgent: 'codex-for-copilot/preconnection-smoke',
    websocketPrewarm: 'disabled',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'Smoke test instructions',
    input: [{ type: 'message', role: 'user', content: 'Use the existing socket.' }],
    maxOutputTokens: 32,
    token: createCancellationToken(),
    onTextDelta: (text) => deltas.push(text),
    onWebSocketSession: (event) => sessionEvents.push(event)
  });

  assertEqual(upgradeCount, 1, 'preconnection reuses one WebSocket upgrade');
  assertEqual(connectionCount, 1, 'preconnection reuses one WebSocket connection');
  assertEqual(preconnectHeaders.authorization, 'Bearer test-api-key', 'preconnection authorization header');
  assertEqual(preconnectHeaders['chatgpt-account-id'], 'acct-test', 'preconnection account header');
  assertEqual(preconnectHeaders['openai-beta'], 'responses_websockets=2026-02-06', 'preconnection beta header');
  assertEqual(preconnectHeaders['session-id'], undefined, 'preconnection omits session identity');
  assertEqual(preconnectHeaders['thread-id'], undefined, 'preconnection omits thread identity');
  assertEqual(preconnectHeaders['x-codex-installation-id'], undefined, 'preconnection omits installation identity');
  assertEqual(frames.length, 1, 'preconnection sends no prompt frame before the formal request');
  assertEqual(frames[0].type, 'response.create', 'preconnection formal request type');
  assertEqual(frames[0].client_metadata.session_id, '22222222-2222-4222-8222-222222222222', 'formal request carries session identity');
  assertEqual(deltas.join(''), 'reused handshake', 'preconnection formal response text');
  assertEqual(sessionEvents[0]?.reused, false, 'preconnection is not a previous-response reuse');
  assertEqual(sessionEvents[0]?.origin, 'preconnected', 'preconnection session origin');
  console.log('Smoke test passed: an identity-free WebSocket preconnection is reused by the formal Codex request.');
} finally {
  disposeReusableResponsesWebSockets();
  webSocketServer.close();
  server.close();
  await loaded.dispose();
}

function createCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    }
  };
}