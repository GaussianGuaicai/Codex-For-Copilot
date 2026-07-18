import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responsesClient.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
const { disposeReusableResponsesWebSockets, streamResponseText } = loaded.exports;
const server = createServer();
const webSocketServer = new WebSocketServer({ noServer: true });
const frames = [];
let connectionCount = 0;

server.on('upgrade', (request, socket, head) => {
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});

webSocketServer.on('connection', (webSocket) => {
  connectionCount += 1;
  webSocket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    if (frame.generate === false) {
      return;
    }

    webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_after_prewarm_timeout', status: 'in_progress' } }));
    webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'formal response' }));
    webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_after_prewarm_timeout', status: 'completed' } }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const deltas = [];
  const metrics = [];
  await streamResponseText({
    baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    apiKey: 'test-api-key',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${address.port}/backend-api/codex/responses` },
    authIdentity: 'codexAuth:acct-test',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444444',
      windowId: '55555555-5555-4555-8555-555555555555'
    },
    extensionVersion: 'prewarm-budget-smoke',
    userAgent: 'codex-for-copilot/prewarm-budget-smoke',
    websocketPrewarm: 'enabled',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'Smoke test instructions',
    input: [{ type: 'message', role: 'user', content: 'Continue after the prewarm budget.' }],
    maxOutputTokens: 32,
    token: createCancellationToken(),
    onTextDelta: (text) => deltas.push(text),
    onTransportMetrics: (metric) => metrics.push(metric)
  });

  assertEqual(frames.length, 2, 'prewarm timeout frame count');
  assertEqual(frames[0].generate, false, 'prewarm timeout sends generate false');
  assertEqual(frames[1].generate, undefined, 'prewarm timeout sends formal request after recreating socket');
  assertEqual(connectionCount, 2, 'prewarm timeout recreates the WebSocket connection');
  assertEqual(deltas.join(''), 'formal response', 'prewarm timeout preserves formal response streaming');
  assertEqual(metrics.some((metric) => metric.prewarmResult === 'timed-out'), true, 'prewarm timeout reports bounded result');
  assertEqual(metrics.some((metric) => metric.prewarmTimedOut === true), true, 'prewarm timeout reports timeout state');

  const autoFramesStart = frames.length;
  const autoMetrics = [];
  await streamResponseText({
    baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    apiKey: 'test-api-key',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${address.port}/backend-api/codex/responses` },
    authIdentity: 'codexAuth:acct-test-auto',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222223',
      threadId: '33333333-3333-4333-8333-333333333334',
      turnId: '44444444-4444-4444-8444-444444444445',
      windowId: '55555555-5555-4555-8555-555555555555'
    },
    extensionVersion: 'prewarm-budget-smoke',
    userAgent: 'codex-for-copilot/prewarm-budget-smoke',
    websocketPrewarm: 'auto',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'Smoke test instructions',
    input: [{ type: 'message', role: 'user', content: 'Skip speculative prewarm.' }],
    maxOutputTokens: 32,
    token: createCancellationToken(),
    onTextDelta() {},
    onTransportMetrics: (metric) => autoMetrics.push(metric)
  });

  assertEqual(frames.length, autoFramesStart + 1, 'auto prewarm sends only the formal request');
  assertEqual(frames[autoFramesStart].generate, undefined, 'auto prewarm omits generate false');
  assertEqual(autoMetrics.some((metric) => metric.prewarmResult === 'skipped-auto'), true, 'auto prewarm reports skipped result');
  console.log('Smoke test passed: a stalled prewarm is bounded and the formal WebSocket request recovers on a new connection.');
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