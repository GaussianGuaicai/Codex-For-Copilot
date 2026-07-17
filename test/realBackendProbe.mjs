import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const requestedModel = process.env.CODEX_TEST_MODEL || 'gpt-5.5';
const requestedServiceTier = process.env.CODEX_TEST_SERVICE_TIER;
const requestedTransport = process.env.CODEX_TEST_TRANSPORT === 'websocket'
  ? 'websocket'
  : process.env.CODEX_TEST_TRANSPORT === 'auto'
    ? 'auto'
    : 'http';
const runContinuationProbe = process.env.CODEX_TEST_CONTINUATION === '1';
const runPreconnectionProbe = process.env.CODEX_TEST_PRECONNECT === '1';
const shouldRunToolContinuationProbe = process.env.CODEX_TEST_TOOL_CONTINUATION === '1';
const requestStore = process.env.CODEX_TEST_STORE === '1';
const requestedPrewarm = parsePrewarmSetting(process.env.CODEX_TEST_PREWARM);
const requestedReasoningEffort = parseReasoningEffort(process.env.CODEX_TEST_REASONING_EFFORT);
const requestTimeoutMs = parsePositiveInteger(process.env.CODEX_TEST_TIMEOUT_MS, 60_000);
const requestServiceTier = requestedServiceTier === 'fast'
  ? 'priority'
  : requestedServiceTier === 'auto' || requestedServiceTier === undefined
    ? undefined
    : requestedServiceTier;

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-real-'));
const secretsBundlePath = join(tempDir, 'secrets.cjs');
const responsesBundlePath = join(tempDir, 'responsesClient.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: ['src/secrets.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: secretsBundlePath,
    external: ['vscode']
  });

  await build({
    entryPoints: ['src/responsesClient.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: responsesBundlePath,
    external: ['vscode']
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        LanguageModelChatToolMode: { Required: 2 },
        workspace: {
          getConfiguration() {
            return {
              get(_key, defaultValue) {
                return defaultValue;
              }
            };
          }
        }
      };
    }

    return moduleLoad.call(this, request, parent, isMain);
  };

  const { getApiCredentials, DEFAULT_USER_AGENT } = require(secretsBundlePath);
  const {
    disposeReusableResponsesWebSockets,
    isResponsesContinuationMissError,
    preconnectCodexResponsesWebSocket,
    streamResponseText
  } = require(responsesBundlePath);
  const auth = JSON.parse(await readFile(process.env.CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json'), 'utf8'));
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  globalThis.fetch = (input, init = {}) => undiciFetch(input, proxyUrl
    ? {
        ...init,
        dispatcher: init.dispatcher ?? new ProxyAgent(proxyUrl)
      }
    : init);

  const credentials = await getApiCredentials({
    secrets: {
      async get() {
        return 'sk-stored-key-should-not-win';
      }
    }
  });

  if (!credentials) {
    throw new Error('No credentials were resolved from ~/.codex/auth.json.');
  }

  assertEqual(credentials.source, 'codexAuth', 'credential source');
  assertEqual(credentials.apiKey, auth.tokens.access_token, 'resolved access token');
  assertEqual(credentials.headers['User-Agent'], DEFAULT_USER_AGENT, 'default user agent');
  if (typeof auth.tokens.account_id === 'string' && auth.tokens.account_id) {
    assertEqual(credentials.headers['ChatGPT-Account-ID'], auth.tokens.account_id, 'account id header');
  }
  assertEqual(credentials.omitMaxOutputTokens, true, 'omit max_output_tokens');

  const deltas = [];
  const sessionEvents = [];
  const transportMetrics = [];
  let createdServiceTier = null;
  let completedServiceTier = null;
  let transportFallback = null;
  let previousResponseId = null;
  const identity = {
    installationId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
    turnId: randomUUID(),
    windowId: randomUUID()
  };
  let preconnection = null;
  if (runPreconnectionProbe) {
    if (requestedTransport === 'http') {
      throw new Error('CODEX_TEST_PRECONNECT=1 requires CODEX_TEST_TRANSPORT=websocket or auto.');
    }

    let resolveHandshake;
    let rejectHandshake;
    const handshakeCompleted = new Promise((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    const started = preconnectCodexResponsesWebSocket({
      baseURL: 'https://chatgpt.com/backend-api/codex/responses',
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      compatibilityProfile: {
        enabled: true,
        endpointKey: 'https://chatgpt.com/backend-api/codex/responses'
      },
      authIdentity: `real-probe:${auth.tokens.account_id ?? 'default'}`,
      extensionVersion: 'real-backend-probe',
      userAgent: 'codex-for-copilot/real-backend-probe',
      onConnected: resolveHandshake,
      onError: rejectHandshake
    });
    assertEqual(started, true, 'preconnection starts');
    await waitForEvent(handshakeCompleted, 15_000, 'preconnection handshake');
    preconnection = { handshakeCompleted: true };
  }
  await runWithRequestTimeout('initial response', (token) => streamResponseText({
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    apiKey: credentials.apiKey,
    headers: credentials.headers,
    transport: requestedTransport,
    compatibilityProfile: {
      enabled: true,
      endpointKey: 'https://chatgpt.com/backend-api/codex/responses'
    },
    identity,
    authIdentity: `real-probe:${auth.tokens.account_id ?? 'default'}`,
    extensionVersion: 'real-backend-probe',
    userAgent: 'codex-for-copilot/real-backend-probe',
    websocketPrewarm: requestedPrewarm,
    requestCompression: process.env.CODEX_TEST_COMPRESSION === '1' ? 'enabled' : 'auto',
    store: requestStore,
    omitMaxOutputTokens: credentials.omitMaxOutputTokens,
    model: requestedModel,
    instructions: 'You are a test assistant.',
    ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
    ...(requestedReasoningEffort ? { reasoning: { effort: requestedReasoningEffort } } : {}),
    input: [{ role: 'user', content: 'Reply with OK only.' }],
    maxOutputTokens: 32,
    token,
    onTextDelta: (text) => deltas.push(text),
    onResponseCreated: (response) => {
      createdServiceTier = response.service_tier ?? null;
      previousResponseId = response.id ?? previousResponseId;
    },
    onResponseCompleted: (response) => {
      completedServiceTier = response.service_tier ?? null;
      previousResponseId = response.id ?? previousResponseId;
    },
    onTransportFallback: (event) => {
      transportFallback = event;
    },
    onWebSocketSession: (event) => {
      sessionEvents.push(event);
    },
    onTransportMetrics: (metrics) => {
      recordTransportMetrics(transportMetrics, metrics);
    }
  }));

  assertEqual(deltas.join('').trim(), 'OK', 'real backend output');
  if (runPreconnectionProbe) {
    assertEqual(sessionEvents[0]?.origin, 'preconnected', 'real backend preconnection origin');
    preconnection = { ...preconnection, formalConnectionOrigin: sessionEvents[0].origin };
  }
  let continuationOutput = null;
  let continuationRecovered = false;
  let toolContinuation = null;

  if (runContinuationProbe) {
    if (!previousResponseId) {
      throw new Error('Continuation probe requires the initial response id.');
    }

    const continuationDeltas = [];
    const continuationOptions = {
      baseURL: 'https://chatgpt.com/backend-api/codex/responses',
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      transport: requestedTransport,
      compatibilityProfile: {
        enabled: true,
        endpointKey: 'https://chatgpt.com/backend-api/codex/responses'
      },
      identity: { ...identity, turnId: randomUUID() },
      authIdentity: `real-probe:${auth.tokens.account_id ?? 'default'}`,
      extensionVersion: 'real-backend-probe',
      userAgent: 'codex-for-copilot/real-backend-probe',
      websocketPrewarm: requestedPrewarm,
      requestCompression: process.env.CODEX_TEST_COMPRESSION === '1' ? 'enabled' : 'auto',
      store: requestStore,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      model: requestedModel,
      instructions: 'You are a test assistant.',
      ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
      ...(requestedReasoningEffort ? { reasoning: { effort: requestedReasoningEffort } } : {}),
      input: [{ role: 'user', content: 'Reply with PONG only.' }],
      maxOutputTokens: 32,
      token: undefined,
      onTextDelta: (text) => continuationDeltas.push(text),
      onTransportFallback: (event) => {
        transportFallback = event;
      },
      onWebSocketSession: (event) => {
        sessionEvents.push(event);
      },
      onTransportMetrics: (metrics) => {
        recordTransportMetrics(transportMetrics, metrics);
      }
    };
    try {
      await runWithRequestTimeout('continuation response', (token) => streamResponseText({
        ...continuationOptions,
        previousResponseId,
        token
      }));
    } catch (error) {
      if (!isResponsesContinuationMissError(error)) {
        throw error;
      }
      continuationRecovered = true;
      continuationDeltas.length = 0;
      await runWithRequestTimeout('continuation recovery response', (token) => streamResponseText({
        ...continuationOptions,
        token
      }));
    }

    continuationOutput = continuationDeltas.join('').trim();
    assertEqual(continuationOutput, 'PONG', 'continuation output');
  }

  if (shouldRunToolContinuationProbe) {
    toolContinuation = await runToolContinuationProbe({
      streamResponseText,
      isResponsesContinuationMissError,
      credentials,
      authIdentity: `real-probe:${auth.tokens.account_id ?? 'default'}`,
      requestedModel,
      requestServiceTier,
      requestStore
    });
  }

  console.log(JSON.stringify({
    model: requestedModel,
    transport: requestedTransport,
    continuationProbe: runContinuationProbe,
    preconnectionProbe: preconnection,
    requestStore,
    requestedPrewarm,
    requestedReasoningEffort: requestedReasoningEffort ?? null,
    requestedServiceTier: requestedServiceTier ?? null,
    requestServiceTier: requestServiceTier ?? null,
    createdServiceTier,
    completedServiceTier,
    transportFallback,
    webSocketSessionReuse: sessionEvents.map((event) => event.reused),
    webSocketConnectionOrigins: sessionEvents.map((event) => event.origin ?? null),
    transportMetrics,
    output: deltas.join('').trim(),
    continuationOutput,
    continuationRecovered,
    toolContinuation
  }));

  disposeReusableResponsesWebSockets();
} finally {
  Module._load = moduleLoad;
  delete globalThis.fetch;
  await rm(tempDir, { recursive: true, force: true });
}

async function runToolContinuationProbe({
  streamResponseText,
  isResponsesContinuationMissError,
  credentials,
  authIdentity,
  requestedModel,
  requestServiceTier,
  requestStore
}) {
  const identity = {
    installationId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
    turnId: randomUUID(),
    windowId: randomUUID()
  };
  const tool = {
    name: 'test_echo',
    description: 'Returns the value supplied by the caller.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'string' }
      },
      required: ['value']
    }
  };
  const initialInput = [{
    type: 'message',
    role: 'user',
    content: 'Call test_echo exactly once with value "ping". After receiving its result, reply with TOOL_CONTINUATION_OK only.'
  }];
  const baseOptions = {
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    apiKey: credentials.apiKey,
    headers: credentials.headers,
    transport: 'websocket',
    compatibilityProfile: {
      enabled: true,
      endpointKey: 'https://chatgpt.com/backend-api/codex/responses'
    },
    identity,
    authIdentity,
    extensionVersion: 'real-backend-tool-continuation-probe',
    userAgent: 'codex-for-copilot/real-backend-tool-continuation-probe',
    websocketPrewarm: 'disabled',
    requestCompression: 'disabled',
    store: requestStore,
    omitMaxOutputTokens: credentials.omitMaxOutputTokens,
    model: requestedModel,
    instructions: 'You are a deterministic test assistant. Follow the user request exactly.',
    ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
    tools: [tool],
    toolMode: 2,
    maxOutputTokens: 64,
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    }
  };

  const toolCalls = [];
  const rawResponseItems = [];
  let initialResponseId = null;
  await runWithRequestTimeout('tool-call response', (token) => streamResponseText({
    ...baseOptions,
    token,
    input: initialInput,
    onTextDelta() {},
    onToolCall: (callId, name, input) => toolCalls.push({ callId, name, input }),
    onRawResponseItem: (item) => rawResponseItems.push(item),
    onResponseCreated: (response) => {
      initialResponseId = response.id ?? initialResponseId;
    },
    onResponseCompleted: (response) => {
      initialResponseId = response.id ?? initialResponseId;
    }
  }));

  assertEqual(toolCalls.length, 1, 'tool continuation initial call count');
  assertEqual(toolCalls[0].name, 'test_echo', 'tool continuation initial tool name');
  if (!initialResponseId) {
    throw new Error('Tool continuation probe requires an initial response id.');
  }

  const toolOutput = {
    type: 'function_call_output',
    call_id: toolCalls[0].callId,
    output: 'ping'
  };
  const output = [];
  const metrics = [];
  let recovered = false;

  const continuationOptions = {
    ...baseOptions,
    input: [toolOutput],
    previousResponseId: initialResponseId,
    toolMode: undefined,
    onTextDelta: (text) => output.push(text),
    onTransportMetrics: (metric) => metrics.push(metric)
  };

  try {
    await runWithRequestTimeout('tool-output continuation response', (token) => streamResponseText({
      ...continuationOptions,
      token
    }));
  } catch (error) {
    if (!isResponsesContinuationMissError(error)) {
      throw error;
    }
    recovered = true;
    output.length = 0;
    metrics.length = 0;
    await runWithRequestTimeout('tool-output recovery response', (token) => streamResponseText({
      ...baseOptions,
      input: [...initialInput, ...rawResponseItems, toolOutput],
      toolMode: undefined,
      token,
      onTextDelta: (text) => output.push(text),
      onTransportMetrics: (metric) => metrics.push(metric)
    }));
  }

  const responseText = output.join('').trim();
  assertEqual(responseText.includes('TOOL_CONTINUATION_OK'), true, 'tool continuation response');

  return {
    attempted: true,
    incrementalAccepted: !recovered,
    recovered,
    initialToolCallCount: toolCalls.length,
    rawResponseItemCount: rawResponseItems.length,
    incrementalInputCount: metrics.find((metric) => typeof metric.incrementalInputCount === 'number')?.incrementalInputCount ?? null,
    previousResponseIdUsed: metrics.some((metric) => metric.previousResponseIdUsed === true)
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function parsePrewarmSetting(value) {
  switch (value) {
    case 'disabled':
    case '0':
      return 'disabled';
    case 'enabled':
    case '1':
      return 'enabled';
    case undefined:
    case 'auto':
      return 'auto';
    default:
      throw new Error(`Unsupported CODEX_TEST_PREWARM value: ${value}.`);
  }
}

function parseReasoningEffort(value) {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
    return value;
  }
  throw new Error(`Unsupported CODEX_TEST_REASONING_EFFORT value: ${value}.`);
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`CODEX_TEST_TIMEOUT_MS must be a positive integer, got ${value}.`);
}

function summarizeTransportMetrics(metrics) {
  const summary = {};
  for (const key of [
    'transportActual',
    'connectionReused',
    'previousResponseIdUsed',
    'incrementalInputCount',
    'requestBodyBytes',
    'requestBuildMs',
    'toolSchemaBytes',
    'toolSchemaCacheHit',
    'prewarmEnabled',
    'prewarmResult',
    'prewarmTimedOut',
    'prewarmBudgetMs',
    'prewarmLatencyMs',
    'turnStateReceived',
    'modelsEtagPresent'
  ]) {
    if (metrics[key] !== undefined) {
      summary[key] = metrics[key];
    }
  }
  return summary;
}

function recordTransportMetrics(target, metrics) {
  const summary = summarizeTransportMetrics(metrics);
  if (Object.keys(summary).length > 0) {
    target.push(summary);
  }
}

async function runWithRequestTimeout(label, operation) {
  let timedOut = false;
  const listeners = new Set();
  const timer = setTimeout(() => {
    timedOut = true;
    for (const listener of listeners) {
      listener();
    }
  }, requestTimeoutMs);
  timer.unref?.();
  const token = {
    get isCancellationRequested() {
      return timedOut;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    }
  };
  try {
    await operation(token);
    if (timedOut) {
      throw new Error(`${label} timed out after ${requestTimeoutMs}ms.`);
    }
  } finally {
    clearTimeout(timer);
    listeners.clear();
  }
}

async function waitForEvent(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
