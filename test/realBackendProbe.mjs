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
const requestStore = process.env.CODEX_TEST_STORE === '1';
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
  const { disposeReusableResponsesWebSockets, isResponsesContinuationMissError, streamResponseText } = require(responsesBundlePath);
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
  await streamResponseText({
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
    websocketPrewarm: process.env.CODEX_TEST_PREWARM === '0' ? 'disabled' : 'auto',
    requestCompression: process.env.CODEX_TEST_COMPRESSION === '1' ? 'enabled' : 'auto',
    store: requestStore,
    omitMaxOutputTokens: credentials.omitMaxOutputTokens,
    model: requestedModel,
    instructions: 'You are a test assistant.',
    ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
    input: [{ role: 'user', content: 'Reply with OK only.' }],
    maxOutputTokens: 32,
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
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
    }
  });

  assertEqual(deltas.join('').trim(), 'OK', 'real backend output');
  let continuationOutput = null;
  let continuationRecovered = false;

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
      websocketPrewarm: 'disabled',
      requestCompression: process.env.CODEX_TEST_COMPRESSION === '1' ? 'enabled' : 'auto',
      store: requestStore,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      model: requestedModel,
      instructions: 'You are a test assistant.',
      ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
      input: [{ role: 'user', content: 'Reply with PONG only.' }],
      maxOutputTokens: 32,
      token: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} })
      },
      onTextDelta: (text) => continuationDeltas.push(text),
      onTransportFallback: (event) => {
        transportFallback = event;
      },
      onWebSocketSession: (event) => {
        sessionEvents.push(event);
      }
    };
    try {
      await streamResponseText({ ...continuationOptions, previousResponseId });
    } catch (error) {
      if (!isResponsesContinuationMissError(error)) {
        throw error;
      }
      continuationRecovered = true;
      continuationDeltas.length = 0;
      await streamResponseText(continuationOptions);
    }

    continuationOutput = continuationDeltas.join('').trim();
    assertEqual(continuationOutput, 'PONG', 'continuation output');
  }

  console.log(JSON.stringify({
    model: requestedModel,
    transport: requestedTransport,
    continuationProbe: runContinuationProbe,
    requestStore,
    requestedServiceTier: requestedServiceTier ?? null,
    requestServiceTier: requestServiceTier ?? null,
    createdServiceTier,
    completedServiceTier,
    transportFallback,
    webSocketSessionReuse: sessionEvents.map((event) => event.reused),
    output: deltas.join('').trim(),
    continuationOutput,
    continuationRecovered
  }));

  disposeReusableResponsesWebSockets();
} finally {
  Module._load = moduleLoad;
  delete globalThis.fetch;
  await rm(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
