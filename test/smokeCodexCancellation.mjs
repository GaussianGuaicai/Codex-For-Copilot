import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responsesClient.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
const { streamResponseText, disposeReusableResponsesWebSockets } = loaded.exports;
const server = createServer();
const webSocketServer = new WebSocketServer({ noServer: true });
let requestCount = 0;
let markFirstRequestReceived;
const firstRequestReceived = new Promise((resolve) => {
  markFirstRequestReceived = resolve;
});

server.on('upgrade', (request, socket, head) => {
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});
webSocketServer.on('connection', (webSocket) => {
  webSocket.on('message', () => {
    requestCount += 1;
    if (requestCount === 1) {
      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'cancelled', status: 'in_progress' } }));
      markFirstRequestReceived();
      return;
    }
    webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'next', status: 'in_progress' } }));
    webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'next-ok' }));
    webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'next', status: 'completed' } }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const port = server.address().port;
  const cancellation = createCancellationToken();
  const first = requestOptions(port, 'session-cancelled', cancellation.token, () => undefined);
  const firstResponse = streamResponseText(first);
  await firstRequestReceived;
  cancellation.cancel();
  await completeWithin(firstResponse, 1_000, 'cancelled request returns promptly');

  const output = [];
  await completeWithin(
    streamResponseText(requestOptions(port, 'session-next', createCancellationToken().token, (delta) => output.push(delta))),
    1_000,
    'request after cancellation completes promptly'
  );
  assertEqual(output.join(''), 'next-ok', 'request after cancellation succeeds');
  assertEqual(requestCount, 2, 'cancelled request is not replayed');
  console.log('Smoke test passed: cancellation closes its socket without poisoning or duplicating the next request.');
} finally {
  disposeReusableResponsesWebSockets();
  webSocketServer.close();
  server.close();
  await loaded.dispose();
}

function requestOptions(port, sessionId, token, onTextDelta) {
  return {
    baseURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    apiKey: 'token',
    transport: 'websocket',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${port}/backend-api/codex/responses` },
    authIdentity: 'auth',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId,
      threadId: `${sessionId}-thread`,
      turnId: `${sessionId}-turn`,
      windowId: 'window'
    },
    extensionVersion: 'test',
    websocketPrewarm: 'disabled',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    maxOutputTokens: 32,
    token,
    onTextDelta
  };
}

function createCancellationToken() {
  const listeners = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    }
  };
  return {
    token,
    cancel() {
      token.isCancellationRequested = true;
      for (const listener of listeners) listener();
    }
  };
}

async function completeWithin(promise, timeoutMs, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
