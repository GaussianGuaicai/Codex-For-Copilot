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

const { disposeReusableResponsesWebSockets, isResponsesContinuationMissError, shouldBypassProxy, streamResponseText } = require(bundlePath);

try {
  await runHttpTransportSmokeTest(streamResponseText);
  await runFunctionCallArgumentsDoneSmokeTest(streamResponseText);
  await runAutoFallbackSmokeTest(streamResponseText);
  await runAutoModelNotFoundDoesNotFallbackSmokeTest(streamResponseText);
  await runWebSocketTransportSmokeTest(streamResponseText);
  await runWebSocketLowercaseNoProxySmokeTest(streamResponseText, shouldBypassProxy);
  await runWebSocketContinuationSmokeTest(streamResponseText);
  await runWebSocketContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
  await runWebSocketToolOutputContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
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

async function runFunctionCallArgumentsDoneSmokeTest(streamResponseText) {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before sending the deterministic event sequence.
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.output_text.delta', delta: 'Before tool.' });
    send({
      type: 'response.output_item.added',
      output_index: 1,
      sequence_number: 2,
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_pull_request',
        arguments: ''
      }
    });
    send({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_1',
      output_index: 1,
      sequence_number: 3,
      name: '',
      arguments: '{"number":10}'
    });
    send({ type: 'response.output_text.delta', delta: 'After tool.' });
    send({
      type: 'response.output_item.done',
      output_index: 1,
      sequence_number: 5,
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_pull_request',
        arguments: '{"number":10}'
      }
    });
    send({ type: 'response.completed', response: { id: 'resp_function_call', status: 'completed' } });
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const progress = [];

    await streamResponseText({
      baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'http',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Read the current pull request.' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTextDelta: (text) => progress.push({ type: 'text', text }),
      onToolCall: (callId, name, input) => progress.push({ type: 'tool', callId, name, input })
    });

    assertEqual(JSON.stringify(progress), JSON.stringify([
      { type: 'text', text: 'Before tool.' },
      { type: 'tool', callId: 'call_1', name: 'read_pull_request', input: { number: 10 } },
      { type: 'text', text: 'After tool.' }
    ]), 'complete function call is reported before later stream content without duplication');
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

async function runAutoModelNotFoundDoesNotFallbackSmokeTest(streamResponseText) {
  let httpRequestCount = 0;
  let upgradeCount = 0;
  let fallbackEvent;
  const server = createServer((request, response) => {
    httpRequestCount += 1;
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'HTTP fallback must not run.' } }));
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    upgradeCount += 1;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', () => {
      webSocket.send(JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_missing_model',
          status: 'failed',
          error: {
            code: 'model_not_found',
            message: 'Model not found gpt-5.5'
          }
        }
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    let capturedError;

    try {
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
        onTextDelta() {},
        onTransportFallback: (event) => {
          fallbackEvent = event;
        }
      });
    } catch (error) {
      capturedError = error;
    }

    assertEqual(capturedError?.message, 'Model not found gpt-5.5', 'requested model rejection surfaces directly');
    assertEqual(upgradeCount, 1, 'requested model rejection uses one WebSocket attempt');
    assertEqual(httpRequestCount, 0, 'requested model rejection does not fall back to HTTP');
    assertEqual(fallbackEvent, undefined, 'requested model rejection does not report transport fallback');
  } finally {
    webSocketServer.close();
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
      webSocket.send(JSON.stringify({
        type: 'response.reasoning_text.delta',
        item_id: 'rs_ws',
        output_index: 0,
        content_index: 0,
        delta: 'Planning',
        sequence_number: 1
      }));
      webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }));
      webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: ' websocket' }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_ws', status: 'completed' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const deltas = [];
    const reasoningDeltas = [];

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
      onReasoningTextDelta: (delta) => reasoningDeltas.push(delta),
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
    assertEqual(JSON.stringify(reasoningDeltas), JSON.stringify([{
      text: 'Planning',
      itemId: 'rs_ws',
      contentIndex: 0,
      outputIndex: 0
    }]), 'WebSocket reasoning item identity');
    assertEqual(sessionEvent?.reused, false, 'WebSocket initial session reuse state');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

async function runWebSocketLowercaseNoProxySmokeTest(streamResponseText, shouldBypassProxy) {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const environment = captureEnvironment(['NO_PROXY', 'no_proxy', 'HTTPS_PROXY']);

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', () => {
      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_no_proxy', status: 'in_progress' } }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_no_proxy', status: 'completed' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    process.env.NO_PROXY = 'example.invalid';
    process.env.no_proxy = '127.0.0.1';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    const address = server.address();

    assertEqual(
      shouldBypassProxy(`http://127.0.0.1:${address.port}/backend-api/codex/responses`, {
        NO_PROXY: 'example.invalid',
        no_proxy: '127.0.0.1'
      }),
      true,
      'lowercase no_proxy bypasses proxy when NO_PROXY is also set'
    );

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
      onTextDelta() {}
    });
  } finally {
    restoreEnvironment(environment);
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

async function runWebSocketContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError) {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', () => {
      webSocket.send(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: 'Previous response with id \'resp_missing\' not found.',
          param: 'previous_response_id'
        },
        status: 400
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    let capturedError;

    try {
      await streamResponseText({
        baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
        apiKey: 'test-api-key',
        headers: createHeaders(),
        transport: 'websocket',
        previousResponseId: 'resp_missing',
        omitMaxOutputTokens: true,
        model: 'gpt-5.5',
        instructions: 'Smoke test instructions',
        input: [{ role: 'user', content: 'Continue.' }],
        maxOutputTokens: 32,
        token: createCancellationToken(),
        onTextDelta() {}
      });
    } catch (error) {
      capturedError = error;
    }

    assertEqual(isResponsesContinuationMissError(capturedError), true, 'continuation miss classification');
    assertEqual(capturedError.previousResponseId, 'resp_missing', 'continuation miss response id');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

async function runWebSocketToolOutputContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError) {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    webSocket.once('message', () => {
      webSocket.send(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'No tool call found for function call output with call_id call_missing.',
          param: 'input'
        },
        status: 400
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    let capturedError;

    try {
      await streamResponseText({
        baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
        apiKey: 'test-api-key',
        headers: createHeaders(),
        transport: 'websocket',
        previousResponseId: 'resp_missing_tool_call',
        omitMaxOutputTokens: true,
        model: 'gpt-5.5',
        instructions: 'Smoke test instructions',
        input: [{ type: 'function_call_output', call_id: 'call_missing', output: 'result' }],
        maxOutputTokens: 32,
        token: createCancellationToken(),
        onTextDelta() {}
      });
    } catch (error) {
      capturedError = error;
    }

    assertEqual(isResponsesContinuationMissError(capturedError), true, 'tool output continuation miss classification');
    assertEqual(capturedError.previousResponseId, 'resp_missing_tool_call', 'tool output continuation miss response id');
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

function captureEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
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
