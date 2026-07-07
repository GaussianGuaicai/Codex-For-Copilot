import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-provider-'));
const bundlePath = join(tempDir, 'responsesClient.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/responsesClient.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: ['vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      LanguageModelChatToolMode: {
        Required: 2
      }
    };
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const { streamResponseText } = require(bundlePath);

try {
  await runHttpTransportSmokeTest(streamResponseText);
  await runAutoFallbackSmokeTest(streamResponseText);
  await runWebSocketTransportSmokeTest(streamResponseText);

  console.log('Smoke tests passed: HTTP, auto fallback, and WebSocket transports are correct.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

async function runHttpTransportSmokeTest(streamResponseText) {
  let capturedRequest;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      userAgent: request.headers['user-agent'],
      accountId: request.headers['chatgpt-account-id'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };

    writeSseResponse(response, ['hello', ' world']);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const deltas = [];

    await streamResponseText({
      baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'http',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Ping' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => deltas.push(text)
    });

    assertHttpRequest(capturedRequest, '/backend-api/codex/responses');
    assertEqual(deltas.join(''), 'hello world', 'HTTP streamed text');
  } finally {
    server.close();
  }
}

async function runAutoFallbackSmokeTest(streamResponseText) {
  let capturedRequest;
  let fallbackEvent;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(426, { connection: 'close' });
      response.end('WebSocket upgrade not supported by this test server.');
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      userAgent: request.headers['user-agent'],
      accountId: request.headers['chatgpt-account-id'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };

    writeSseResponse(response, ['fallback', ' path']);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const deltas = [];

    await streamResponseText({
      baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'auto',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Ping' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => deltas.push(text),
      onTransportFallback: (event) => {
        fallbackEvent = event;
      }
    });

    assertHttpRequest(capturedRequest, '/backend-api/codex/responses');
    assertEqual(deltas.join(''), 'fallback path', 'auto fallback streamed text');
    assertEqual(fallbackEvent?.from, 'websocket', 'fallback from transport');
    assertEqual(fallbackEvent?.to, 'http', 'fallback to transport');
  } finally {
    server.close();
  }
}

async function runWebSocketTransportSmokeTest(streamResponseText) {
  let capturedUpgrade;
  let capturedClientEvent;
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    capturedUpgrade = {
      url: request.url,
      authorization: request.headers.authorization,
      userAgent: request.headers['user-agent'],
      accountId: request.headers['chatgpt-account-id']
    };

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', (data) => {
      capturedClientEvent = JSON.parse(data.toString('utf8'));
      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_ws', status: 'in_progress' } }));
      webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }));
      webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: ' websocket' }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_ws', status: 'completed' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const deltas = [];

    await streamResponseText({
      baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'websocket',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Ping' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => deltas.push(text)
    });

    assertEqual(capturedUpgrade.url, '/backend-api/codex/responses', 'WebSocket upgrade path');
    assertEqual(capturedUpgrade.authorization, 'Bearer test-api-key', 'WebSocket authorization header');
    assertEqual(capturedUpgrade.userAgent, 'local.codex-for-copilot/1.0.0 Codex-Extension', 'WebSocket user agent');
    assertEqual(capturedUpgrade.accountId, 'acct-test', 'WebSocket ChatGPT account id header');
    assertEqual(capturedClientEvent.type, 'response.create', 'WebSocket client event type');
    assertEqual(capturedClientEvent.model, 'gpt-5.5', 'WebSocket model');
    assertEqual(capturedClientEvent.instructions, 'Smoke test instructions', 'WebSocket instructions');
    assertEqual(capturedClientEvent.store, false, 'WebSocket store flag');
    assertEqual('stream' in capturedClientEvent, false, 'WebSocket stream flag omitted');
    assertEqual('max_output_tokens' in capturedClientEvent, false, 'WebSocket max output tokens omitted for Codex account auth');
    assertEqual(JSON.stringify(capturedClientEvent.input), JSON.stringify([{ role: 'user', content: 'Ping' }]), 'WebSocket input');
    assertEqual(deltas.join(''), 'hello websocket', 'WebSocket streamed text');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

function createHeaders() {
  return {
    'User-Agent': 'local.codex-for-copilot/1.0.0 Codex-Extension',
    'ChatGPT-Account-ID': 'acct-test'
  };
}

function createCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
  };
}

function assertHttpRequest(capturedRequest, expectedUrl) {
  assertEqual(capturedRequest.method, 'POST', 'method');
  assertEqual(capturedRequest.url, expectedUrl, 'request path');
  assertEqual(capturedRequest.authorization, 'Bearer test-api-key', 'authorization header');
  assertEqual(capturedRequest.userAgent, 'local.codex-for-copilot/1.0.0 Codex-Extension', 'user agent');
  assertEqual(capturedRequest.accountId, 'acct-test', 'ChatGPT account id header');
  assertEqual(capturedRequest.body.model, 'gpt-5.5', 'model');
  assertEqual(capturedRequest.body.instructions, 'Smoke test instructions', 'top-level instructions');
  assertEqual(capturedRequest.body.store, false, 'store flag');
  assertEqual(capturedRequest.body.stream, true, 'stream flag');
  assertEqual('max_output_tokens' in capturedRequest.body, false, 'max output tokens omitted for Codex account auth');
  assertEqual(JSON.stringify(capturedRequest.body.input), JSON.stringify([{ role: 'user', content: 'Ping' }]), 'input');
}

function writeSseResponse(response, deltas) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  for (const delta of deltas) {
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
  }

  response.write('data: {"type":"response.completed","response":{"id":"resp_mock","object":"response","status":"completed"}}\n\n');
  response.write('data: [DONE]\n\n');
  response.end();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
