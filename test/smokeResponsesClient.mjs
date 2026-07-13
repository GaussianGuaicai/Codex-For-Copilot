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

const {
  disposeReusableResponsesWebSockets,
  isResponsesContinuationMissError,
  streamResponseText
} = require(bundlePath);

try {
  await runHttpTransportSmokeTest(streamResponseText);
  await runHttpContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
  await runAutoFallbackSmokeTest(streamResponseText);
  await runWebSocketTransportSmokeTest(streamResponseText);
  await runWebSocketContinuationSmokeTest(streamResponseText);
  await runWebSocketContinuationMissSmokeTest(
    streamResponseText,
    isResponsesContinuationMissError,
    disposeReusableResponsesWebSockets
  );
  await runWebSocketSequentialReuseSmokeTest(streamResponseText);

  console.log('Smoke tests passed: HTTP, auto fallback, and WebSocket transports are correct.');
} finally {
  disposeReusableResponsesWebSockets();
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

async function runHttpContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError) {
  let capturedRequest;
  const backendMessage = 'Previous response resp_missing_http was not found.';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'previous_response_not_found',
        message: backendMessage,
        param: 'previous_response_id'
      }
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    let rejectedError;

    try {
      await streamResponseText({
        baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
        apiKey: 'test-api-key',
        headers: createHeaders(),
        transport: 'http',
        previousResponseId: 'resp_missing_http',
        omitMaxOutputTokens: true,
        model: 'gpt-5.5',
        instructions: 'Smoke test instructions',
        input: [{ role: 'user', content: 'Only the delta' }],
        maxOutputTokens: 32,
        token: createCancellationToken(),
        onTextDelta() {}
      });
    } catch (error) {
      rejectedError = error;
    }

    assertEqual(capturedRequest.previous_response_id, 'resp_missing_http', 'HTTP continuation request id');
    assertEqual(isResponsesContinuationMissError(rejectedError), true, 'HTTP continuation miss type guard');
    assertEqual(rejectedError?.previousResponseId, 'resp_missing_http', 'HTTP rejected response id');
    assertEqual(rejectedError?.message, backendMessage, 'HTTP continuation miss message');
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
  let sessionEvent;
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
      onTextDelta: (text) => deltas.push(text),
      onWebSocketSession: (event) => {
        sessionEvent = event;
      }
    });

    assertEqual(capturedUpgrade.url, '/backend-api/codex/responses', 'WebSocket upgrade path');
    assertEqual(capturedUpgrade.authorization, 'Bearer test-api-key', 'WebSocket authorization header');
    assertEqual(capturedUpgrade.userAgent, 'local.codex-for-copilot/1.0.1 Codex-Extension', 'WebSocket user agent');
    assertEqual(capturedUpgrade.accountId, 'acct-test', 'WebSocket ChatGPT account id header');
    assertEqual(capturedClientEvent.type, 'response.create', 'WebSocket client event type');
    assertEqual(capturedClientEvent.model, 'gpt-5.5', 'WebSocket model');
    assertEqual(capturedClientEvent.instructions, 'Smoke test instructions', 'WebSocket instructions');
    assertEqual(capturedClientEvent.store, false, 'WebSocket store flag');
    assertEqual('stream' in capturedClientEvent, false, 'WebSocket stream flag omitted');
    assertEqual('max_output_tokens' in capturedClientEvent, false, 'WebSocket max output tokens omitted for Codex account auth');
    assertEqual(JSON.stringify(capturedClientEvent.input), JSON.stringify([{ role: 'user', content: 'Ping' }]), 'WebSocket input');
    assertEqual(deltas.join(''), 'hello websocket', 'WebSocket streamed text');
    assertEqual(sessionEvent?.reused, false, 'WebSocket initial session reuse state');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

async function runWebSocketContinuationSmokeTest(streamResponseText) {
  let capturedClientEvent;
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', (data) => {
      capturedClientEvent = JSON.parse(data.toString('utf8'));
      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_ws_cont', status: 'in_progress' } }));
      webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'continued' }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_ws_cont', status: 'completed' } }));
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
      previousResponseId: 'resp_previous',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Only the delta' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => deltas.push(text)
    });

    assertEqual(capturedClientEvent.type, 'response.create', 'continuation client event type');
    assertEqual(capturedClientEvent.previous_response_id, 'resp_previous', 'continuation previous response id');
    assertEqual(JSON.stringify(capturedClientEvent.input), JSON.stringify([{ role: 'user', content: 'Only the delta' }]), 'continuation delta input');
    assertEqual(deltas.join(''), 'continued', 'continuation streamed text');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

async function runWebSocketSequentialReuseSmokeTest(streamResponseText) {
  let upgradeCount = 0;
  let connectionCount = 0;
  const receivedEvents = [];
  const sessionEvents = [];
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    upgradeCount += 1;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    connectionCount += 1;

    webSocket.on('message', (data) => {
      const event = JSON.parse(data.toString('utf8'));
      receivedEvents.push(event);

      if (receivedEvents.length === 1) {
        webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_ws_reuse_1', status: 'in_progress' } }));
        webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'first' }));
        webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_ws_reuse_1', status: 'completed' } }));
        return;
      }

      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_ws_reuse_2', status: 'in_progress' } }));
      webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: ' second' }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_ws_reuse_2', status: 'completed' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const firstDeltas = [];
    const secondDeltas = [];

    await streamResponseText({
      baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'websocket',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'First turn' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => firstDeltas.push(text),
      onWebSocketSession: (event) => {
        sessionEvents.push(event);
      }
    });

    await streamResponseText({
      baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'websocket',
      previousResponseId: 'resp_ws_reuse_1',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Second turn delta' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => secondDeltas.push(text),
      onWebSocketSession: (event) => {
        sessionEvents.push(event);
      }
    });

    assertEqual(upgradeCount, 1, 'sequential reuse upgrade count');
    assertEqual(connectionCount, 1, 'sequential reuse connection count');
    assertEqual(receivedEvents.length, 2, 'sequential reuse message count');
    assertEqual(receivedEvents[1].previous_response_id, 'resp_ws_reuse_1', 'sequential reuse previous response id');
    assertEqual(firstDeltas.join(''), 'first', 'sequential reuse first output');
    assertEqual(secondDeltas.join(''), ' second', 'sequential reuse second output');
    assertEqual(sessionEvents.length, 2, 'sequential reuse session event count');
    assertEqual(sessionEvents[0].reused, false, 'sequential reuse first session state');
    assertEqual(sessionEvents[1].reused, true, 'sequential reuse second session state');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

async function runWebSocketContinuationMissSmokeTest(
  streamResponseText,
  isResponsesContinuationMissError,
  disposeReusableResponsesWebSockets
) {
  let capturedClientEvent;
  let httpRequestCount = 0;
  const fallbackEvents = [];
  const backendMessage = 'Previous response resp_missing_ws was not found.';
  const server = createServer((_request, response) => {
    httpRequestCount += 1;
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'HTTP fallback must not be attempted.' } }));
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', (data) => {
      capturedClientEvent = JSON.parse(data.toString('utf8'));
      webSocket.send(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: backendMessage,
          param: 'previous_response_id'
        },
        status: 400
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    let rejectedError;

    try {
      await streamResponseText({
        baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
        apiKey: 'test-api-key',
        headers: createHeaders(),
        transport: 'auto',
        previousResponseId: 'resp_missing_ws',
        omitMaxOutputTokens: true,
        model: 'gpt-5.5',
        instructions: 'Smoke test instructions',
        input: [{ role: 'user', content: 'Only the delta' }],
        maxOutputTokens: 32,
        token: createCancellationToken(),
        onTextDelta() {},
        onTransportFallback: (event) => fallbackEvents.push(event)
      });
    } catch (error) {
      rejectedError = error;
    }

    assertEqual(capturedClientEvent.previous_response_id, 'resp_missing_ws', 'WebSocket continuation request id');
    assertEqual(isResponsesContinuationMissError(rejectedError), true, 'WebSocket continuation miss type guard');
    assertEqual(rejectedError?.previousResponseId, 'resp_missing_ws', 'WebSocket rejected response id');
    assertEqual(rejectedError?.message, backendMessage, 'WebSocket continuation miss message');
    assertEqual(fallbackEvents.length, 0, 'structured WebSocket error fallback event count');
    assertEqual(httpRequestCount, 0, 'structured WebSocket error HTTP fallback request count');
  } finally {
    disposeReusableResponsesWebSockets();
    webSocketServer.close();
    server.close();
  }
}

function createHeaders() {
  return {
    'User-Agent': 'local.codex-for-copilot/1.0.1 Codex-Extension',
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
  assertEqual(capturedRequest.userAgent, 'local.codex-for-copilot/1.0.1 Codex-Extension', 'user agent');
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
