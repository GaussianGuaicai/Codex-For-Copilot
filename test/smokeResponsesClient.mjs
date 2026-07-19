import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-provider-'));
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
  isResponsesContinuationMissPayload,
  shouldBypassProxy,
  streamResponseText
} = require(bundlePath);

try {
  runContinuationMissClassifierSmokeTest(isResponsesContinuationMissPayload);
  await runHttpTransportSmokeTest(streamResponseText);
  await runHttpContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
  await runFunctionCallArgumentsDoneSmokeTest(streamResponseText);
  await runAutoFallbackSmokeTest(streamResponseText);
  await runManagedAutoFallbackVisibilitySmokeTest(streamResponseText);
  await runAutoModelNotFoundDoesNotFallbackSmokeTest(streamResponseText);
  await runWebSocketTransportSmokeTest(streamResponseText);
  await runWebSocketLowercaseNoProxySmokeTest(streamResponseText, shouldBypassProxy);
  await runWebSocketContinuationSmokeTest(streamResponseText);
  await runWebSocketContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
  await runManagedWebSocketContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
  await runWebSocketToolOutputContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError);
  await runWebSocketSequentialReuseSmokeTest(streamResponseText);

  console.log('Smoke tests passed: HTTP, auto fallback, and WebSocket transports are correct.');
} finally {
  disposeReusableResponsesWebSockets();
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function runContinuationMissClassifierSmokeTest(isContinuationMissPayload) {
  const exactPayload = {
    code: 'previous_response_not_found',
    param: 'previous_response_id'
  };
  assertEqual(isContinuationMissPayload(exactPayload), true, 'exact continuation code and param classify');
  assertEqual(
    isContinuationMissPayload({ code: 'previous_response_not_found' }),
    true,
    'missing continuation param classifies'
  );
  assertEqual(
    isContinuationMissPayload({ code: 'previous_response_not_found', param: 'input' }),
    false,
    'conflicting continuation param does not classify'
  );
  assertEqual(
    isContinuationMissPayload(new Error('Backend prose mentioned previous_response_not_found during diagnostics.')),
    false,
    'unstructured prose does not classify'
  );
  assertEqual(
    isContinuationMissPayload(new Error(JSON.stringify({ error: exactPayload }))),
    true,
    'bounded JSON Error.message envelope classifies'
  );
  assertEqual(
    isContinuationMissPayload(new Error(JSON.stringify({ message: 'previous_response_not_found' }))),
    false,
    'JSON prose without an exact code does not classify'
  );

  const customErrorWrapper = new Error('Generic SDK rejection');
  customErrorWrapper.error = { error: exactPayload };
  assertEqual(isContinuationMissPayload(customErrorWrapper), true, 'custom Error.error wrapper classifies');

  const causedError = new Error('Outer SDK rejection', {
    cause: Object.assign(new Error('APIError-like rejection'), {
      status: 400,
      error: exactPayload
    })
  });
  assertEqual(isContinuationMissPayload(causedError), true, 'nested Error.cause APIError-like wrapper classifies');

  const cyclic = {};
  cyclic.cause = cyclic;
  assertEqual(isContinuationMissPayload(cyclic), false, 'cyclic wrapper terminates without classifying');

  let getterInvocationCount = 0;
  const unreadableWrapper = new Error('Unreadable custom wrapper');
  Object.defineProperty(unreadableWrapper, 'error', {
    get() {
      getterInvocationCount += 1;
      return { error: exactPayload };
    }
  });
  unreadableWrapper.cause = { error: exactPayload };
  assertEqual(isContinuationMissPayload(unreadableWrapper), true, 'accessor is skipped while data-descriptor cause classifies');
  assertEqual(getterInvocationCount, 0, 'error envelope getter is never invoked');

  let overlyDeep = exactPayload;
  for (let depth = 0; depth < 9; depth += 1) {
    overlyDeep = { cause: overlyDeep };
  }
  assertEqual(isContinuationMissPayload(overlyDeep), false, 'payload beyond traversal depth does not classify');

  const overlyWide = createErrorEnvelopeTree(4);
  let lastLeaf = overlyWide;
  for (let depth = 0; depth < 4; depth += 1) {
    lastLeaf = lastLeaf.message;
  }
  lastLeaf.code = 'previous_response_not_found';
  lastLeaf.param = 'previous_response_id';
  assertEqual(isContinuationMissPayload(overlyWide), false, 'payload beyond traversal node budget does not classify');

  const oversizedMessage = JSON.stringify({
    error: exactPayload,
    padding: 'x'.repeat(17 * 1024)
  });
  assertEqual(
    isContinuationMissPayload(new Error(oversizedMessage)),
    false,
    'oversized JSON Error.message is not parsed'
  );
}

function createErrorEnvelopeTree(depth) {
  if (depth === 0) {
    return {};
  }
  return {
    error: createErrorEnvelopeTree(depth - 1),
    cause: createErrorEnvelopeTree(depth - 1),
    message: createErrorEnvelopeTree(depth - 1)
  };
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
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    requestCount += 1;
    for await (const _chunk of request) {
      // Consume the request before returning the structured SDK APIError response.
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'previous_response_not_found',
        message: 'Remote continuation details must not control classification.',
        param: 'previous_response_id'
      }
    }));
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
        transport: 'http',
        previousResponseId: 'resp_http_missing',
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

    assertEqual(isResponsesContinuationMissError(capturedError), true, 'structured HTTP APIError classifies');
    assertEqual(capturedError.previousResponseId, 'resp_http_missing', 'structured HTTP response id');
    assertEqual(capturedError.message, 'Responses API could not find previous_response_id.', 'structured HTTP message is fixed');
    assertEqual(requestCount, 1, 'structured HTTP miss is not retried by the client');
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
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      sequence_number: 3,
      delta: '{"number":'
    });
    send({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_1',
      output_index: 1,
      sequence_number: 4,
      name: '',
      arguments: '{"number":10}'
    });
    send({ type: 'response.output_text.delta', delta: 'After tool.' });
    send({
      type: 'response.output_item.done',
      output_index: 1,
      sequence_number: 6,
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
      onToolCallAdded: (callId, name) => progress.push({ type: 'tool-added', callId, name }),
      onToolCallArgumentsDelta: (callId, name) => progress.push({ type: 'tool-arguments-delta', callId, name }),
      onToolCallArgumentsDone: (callId, name) => progress.push({ type: 'tool-arguments-done', callId, name }),
      onToolCall: (callId, name, input) => progress.push({ type: 'tool', callId, name, input })
    });

    assertEqual(JSON.stringify(progress), JSON.stringify([
      { type: 'text', text: 'Before tool.' },
      { type: 'tool-added', callId: 'call_1', name: 'read_pull_request' },
      { type: 'tool-arguments-delta', callId: 'call_1', name: 'read_pull_request' },
      { type: 'tool-arguments-done', callId: 'call_1', name: 'read_pull_request' },
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

async function runManagedAutoFallbackVisibilitySmokeTest(streamResponseText) {
  let httpRequestCount = 0;
  const fallbackEvents = [];
  const server = createServer(async (request, response) => {
    httpRequestCount += 1;
    for await (const _chunk of request) {
      // Consume the request before sending the fallback response.
    }
    writeSseResponse(response, ['http fallback']);
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket, request) => {
    const sessionId = request.headers['session-id'];
    webSocket.once('message', () => {
      if (sessionId === 'managed-pre-visible') {
        webSocket.close(1011, 'WebSocket connection closed before output');
        return;
      }

      const responseId = sessionId === 'managed-text-visible' ? 'resp_visible_text' : 'resp_visible_tool';
      webSocket.send(JSON.stringify({
        type: 'response.created',
        response: { id: responseId, status: 'in_progress' }
      }));

      if (sessionId === 'managed-text-visible') {
        webSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'visible text' }));
        webSocket.close(1011, 'WebSocket closed after visible text');
        return;
      }

      webSocket.send(JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: {
          id: 'fc_visible',
          type: 'function_call',
          call_id: 'call_visible',
          name: 'read_pull_request',
          arguments: ''
        }
      }));
      webSocket.send(JSON.stringify({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_visible',
        output_index: 0,
        sequence_number: 2,
        name: '',
        arguments: '{"number":10}'
      }));
      webSocket.close(1011, 'WebSocket closed after visible tool call');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
    const requestOptions = (sessionId, callbacks) => ({
      baseURL,
      apiKey: 'test-api-key',
      headers: createHeaders(),
      transport: 'auto',
      compatibilityProfile: { enabled: true, endpointKey: baseURL },
      authIdentity: 'codexAuth:acct-test',
      identity: {
        installationId: '11111111-1111-4111-8111-111111111111',
        sessionId,
        threadId: `${sessionId}-thread`,
        turnId: `${sessionId}-turn`,
        windowId: '55555555-5555-4555-8555-555555555555'
      },
      extensionVersion: '1.2.3',
      websocketPrewarm: 'disabled',
      requestCompression: 'disabled',
      omitMaxOutputTokens: true,
      model: 'gpt-5.5',
      instructions: 'Smoke test instructions',
      input: [{ role: 'user', content: 'Ping' }],
      maxOutputTokens: 32,
      token: createCancellationToken(),
      onTransportFallback: (event) => fallbackEvents.push(event),
      ...callbacks
    });

    const preVisibleDeltas = [];
    await streamResponseText(requestOptions('managed-pre-visible', {
      onTextDelta: (text) => preVisibleDeltas.push(text)
    }));

    const textDeltas = [];
    let textError;
    try {
      await streamResponseText(requestOptions('managed-text-visible', {
        onTextDelta: (text) => textDeltas.push(text)
      }));
    } catch (error) {
      textError = error;
    }

    const toolCalls = [];
    let toolError;
    try {
      await streamResponseText(requestOptions('managed-tool-visible', {
        onTextDelta() {},
        onToolCall: (callId, name, input) => toolCalls.push({ callId, name, input })
      }));
    } catch (error) {
      toolError = error;
    }

    assertEqual(preVisibleDeltas.join(''), 'http fallback', 'managed pre-visible failure falls back to HTTP');
    assertEqual(textDeltas.join(''), 'visible text', 'managed visible text is emitted once');
    assertEqual(JSON.stringify(toolCalls), JSON.stringify([{
      callId: 'call_visible',
      name: 'read_pull_request',
      input: { number: 10 }
    }]), 'managed visible tool call is emitted once');
    assertEqual(textError instanceof Error, true, 'managed failure after visible text surfaces');
    assertEqual(toolError instanceof Error, true, 'managed failure after visible tool call surfaces');
    assertEqual(httpRequestCount, 1, 'only pre-visible managed failure uses HTTP fallback');
    assertEqual(fallbackEvents.length, 1, 'only pre-visible managed failure reports fallback');
  } finally {
    webSocketServer.close();
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
  let httpRequestCount = 0;
  const fallbackEvents = [];
  const server = createServer(async (request, response) => {
    httpRequestCount += 1;
    for await (const _chunk of request) {
      // Consume any unexpected fallback request before failing the test path.
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'HTTP fallback must not run.' } }));
  });
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
        transport: 'auto',
        previousResponseId: 'resp_missing',
        omitMaxOutputTokens: true,
        model: 'gpt-5.5',
        instructions: 'Smoke test instructions',
        input: [{ role: 'user', content: 'Continue.' }],
        maxOutputTokens: 32,
        token: createCancellationToken(),
        onTextDelta() {},
        onTransportFallback: (event) => fallbackEvents.push(event)
      });
    } catch (error) {
      capturedError = error;
    }

    assertEqual(isResponsesContinuationMissError(capturedError), true, 'continuation miss classification');
    assertEqual(capturedError.previousResponseId, 'resp_missing', 'continuation miss response id');
    assertEqual(capturedError.cause?.error?.type, 'error', 'continuation miss retains actual SDK WebSocket wrapper');
    assertEqual(httpRequestCount, 0, 'structured WebSocket API miss never falls back to HTTP');
    assertEqual(fallbackEvents.length, 0, 'structured WebSocket API miss reports no fallback');
  } finally {
    webSocketServer.close();
    server.close();
  }
}

async function runManagedWebSocketContinuationMissSmokeTest(streamResponseText, isResponsesContinuationMissError) {
  let httpRequestCount = 0;
  const fallbackEvents = [];
  const server = createServer(async (request, response) => {
    httpRequestCount += 1;
    for await (const _chunk of request) {
      // Consume any unexpected fallback request before failing the test path.
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Managed HTTP fallback must not run.' } }));
  });
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket, request) => {
    webSocket.once('message', () => {
      if (request.headers['session-id'] === 'managed-error-event') {
        webSocket.send(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'previous_response_not_found',
            message: 'Managed WebSocket error event.',
            param: 'previous_response_id'
          },
          status: 400
        }));
        return;
      }

      webSocket.send(JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'resp_managed_missing',
          status: 'failed',
          error: {
            type: 'invalid_request_error',
            message: JSON.stringify({
              error: {
                code: 'previous_response_not_found',
                param: 'previous_response_id'
              }
            })
          }
        }
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
    const runManagedRequest = async (sessionId, previousResponseId) => {
      try {
        await streamResponseText({
          baseURL,
          apiKey: 'test-api-key',
          headers: createHeaders(),
          transport: 'auto',
          compatibilityProfile: { enabled: true, endpointKey: baseURL },
          authIdentity: 'codexAuth:acct-test',
          identity: {
            installationId: '11111111-1111-4111-8111-111111111111',
            sessionId,
            threadId: `${sessionId}-thread`,
            turnId: `${sessionId}-turn`,
            windowId: '55555555-5555-4555-8555-555555555555'
          },
          websocketPrewarm: 'disabled',
          requestCompression: 'disabled',
          previousResponseId,
          omitMaxOutputTokens: true,
          model: 'gpt-5.5',
          instructions: 'Smoke test instructions',
          input: [{ role: 'user', content: 'Continue managed session.' }],
          maxOutputTokens: 32,
          token: createCancellationToken(),
          onTextDelta() {},
          onTransportFallback: (event) => fallbackEvents.push(event)
        });
      } catch (error) {
        return error;
      }
      return undefined;
    };

    const managedErrorEvent = await runManagedRequest('managed-error-event', 'resp_managed_error_previous');
    const managedFailedEvent = await runManagedRequest('managed-failed-event', 'resp_managed_failed_previous');

    assertEqual(isResponsesContinuationMissError(managedErrorEvent), true, 'managed WebSocket error miss classification');
    assertEqual(managedErrorEvent.previousResponseId, 'resp_managed_error_previous', 'managed WebSocket error response id');
    assertEqual(isResponsesContinuationMissError(managedFailedEvent), true, 'managed response.failed miss classification');
    assertEqual(managedFailedEvent.previousResponseId, 'resp_managed_failed_previous', 'managed response.failed response id');
    assertEqual(httpRequestCount, 0, 'managed structured API misses never fall back to HTTP');
    assertEqual(fallbackEvents.length, 0, 'managed structured API misses report no fallback');
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
