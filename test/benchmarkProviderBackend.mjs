import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

if (process.env.CODEX_BENCHMARK_BACKEND !== '1') {
  throw new Error('Set CODEX_BENCHMARK_BACKEND=1 to run the opt-in real-backend provider benchmark.');
}

const iterations = Math.max(1, Number.parseInt(process.env.CODEX_BENCHMARK_ITERATIONS ?? '10', 10));
const model = process.env.CODEX_TEST_MODEL ?? 'gpt-5.5';
const baseURL = 'https://chatgpt.com/backend-api/codex/responses';
const authPath = process.env.CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json');
const auth = JSON.parse(await readFile(authPath, 'utf8'));
const accessToken = process.env.CODEX_ACCESS_TOKEN ?? auth.tokens?.access_token;
const accountId = process.env.CODEX_ACCOUNT_ID ?? auth.tokens?.account_id;
if (!accessToken) {
  throw new Error('A Codex access token is required from the environment or auth.json.');
}

const configValues = {
  baseURL,
  clientVersion: 'provider-benchmark',
  credentialsSource: 'codexAuth',
  transport: 'http',
  websocketPrewarm: 'auto',
  requestCompression: 'auto',
  model,
  instructions: 'Reply with OK only.',
  defaultServiceTier: 'auto',
  defaultReasoningEffort: 'auto',
  maxOutputTokens: 32,
  disabledModels: [],
  modelAliases: {},
  modelPricingUsdPerMTok: {}
};

class Disposable {
  constructor(dispose = () => {}) {
    this.disposeCallback = dispose;
  }

  dispose() {
    this.disposeCallback();
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }

  static json(data, mimeType) {
    return new LanguageModelDataPart(data, mimeType);
  }
}

class LanguageModelThinkingPart {
  constructor(value, id, metadata) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

const vscodeMock = {
  Disposable,
  EventEmitter,
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelChatMessageRole: { User: 'user', Assistant: 'assistant' },
  LanguageModelChatToolMode: { Required: 2 },
  version: 'provider-benchmark',
  workspace: {
    getConfiguration(section) {
      if (section === 'http') {
        return { get() { return undefined; } };
      }
      if (section !== 'codexModelProvider') {
        throw new Error(`Unexpected configuration section: ${section}`);
      }
      return {
        get(key, defaultValue) {
          return key in configValues ? configValues[key] : defaultValue;
        }
      };
    },
    onDidChangeConfiguration() {
      return new Disposable();
    }
  }
};

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-provider-benchmark-'));
const bundlePath = join(tempDir, 'provider.cjs');
const responsesBundlePath = join(tempDir, 'responsesClient.js');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const rows = [];

try {
  globalThis.fetch = (input, init = {}) => undiciFetch(input, proxyUrl
    ? { ...init, dispatcher: init.dispatcher ?? new ProxyAgent(proxyUrl) }
    : init);
  await build({
    entryPoints: ['src/provider.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    external: ['vscode', './responsesClient']
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
    return request === 'vscode' ? vscodeMock : moduleLoad.call(this, request, parent, isMain);
  };
  const { CodexModelProvider } = require(bundlePath);
  const { preconnectCodexResponsesWebSocket } = require(responsesBundlePath);

  await benchmark('provider-first-http', () => runProviderRequest(CodexModelProvider, 'http', false));
  await benchmark('provider-direct-selected-model-http', () => runProviderRequest(CodexModelProvider, 'http', true));
  if (process.env.CODEX_BENCHMARK_HTTP_ONLY !== '1') {
    await benchmark('provider-websocket-preconnected', () => runPreconnectedProviderWebSocket(CodexModelProvider, preconnectCodexResponsesWebSocket));
    await benchmark('provider-websocket-reused', () => runProviderReusedWebSocket(CodexModelProvider));
  }

  console.table(rows);
  console.log(JSON.stringify({
    label: process.env.CODEX_BENCHMARK_LABEL ?? 'current',
    model,
    iterations,
    rows
  }, null, 2));
} finally {
  Module._load = moduleLoad;
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
}

async function benchmark(scenario, operation) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await operation());
  }
  rows.push({
    scenario,
    providerToFirstVisibleMedianMs: percentile(samples.map((sample) => sample.trace.providerToFirstVisibleMs), 0.5),
    providerToFirstVisibleP95Ms: percentile(samples.map((sample) => sample.trace.providerToFirstVisibleMs), 0.95),
    requestToCreatedMedianMs: percentile(samples.map((sample) => sample.trace.requestToCreatedMs), 0.5),
    createdToFirstVisibleMedianMs: percentile(samples.map((sample) => sample.trace.createdToFirstVisibleMs), 0.5),
    modelResolutionMedianMs: percentile(samples.map((sample) => sample.trace.modelResolutionMs), 0.5),
    requestBuildMedianMs: percentile(samples.map((sample) => sample.context.requestBuildMs), 0.5),
    requestBytesMedian: percentile(samples.map((sample) => sample.context.requestBodyBytes), 0.5),
    totalMedianMs: percentile(samples.map((sample) => sample.trace.totalMs), 0.5),
    totalP95Ms: percentile(samples.map((sample) => sample.trace.totalMs), 0.95),
    connectionReuseRate: samples.filter((sample) => sample.context.connectionReused === true).length / samples.length,
    toolSchemaCacheHitRate: samples.filter((sample) => sample.context.toolSchemaCacheHit === true).length / samples.length
  });
}

async function runProviderRequest(CodexModelProvider, transport, directModel) {
  configValues.transport = transport;
  const harness = createProviderHarness(CodexModelProvider);
  try {
    await runProviderTurn(harness, directModel);
    return harness.latestLatency();
  } finally {
    harness.dispose();
  }
}

async function runPreconnectedProviderWebSocket(CodexModelProvider, preconnectCodexResponsesWebSocket) {
  configValues.transport = 'websocket';
  const harness = createProviderHarness(CodexModelProvider);
  try {
    await establishIdlePreconnection(preconnectCodexResponsesWebSocket);
    await runProviderTurn(harness, true);
    const latency = harness.latestLatency();
    if (latency.context.connectionOrigin !== 'preconnected') {
      throw new Error(`Expected an idle WebSocket preconnection, got ${latency.context.connectionOrigin ?? 'none'}.`);
    }
    return latency;
  } finally {
    harness.dispose();
  }
}

async function runProviderTurn(harness, directModel) {
  await harness.provider.provideLanguageModelChatResponse(
    modelInfo(directModel),
    [message('Reply with OK only.')],
    {},
    { report() {} },
    cancellationToken()
  );
}

async function runProviderReusedWebSocket(CodexModelProvider) {
  configValues.transport = 'websocket';
  const harness = createProviderHarness(CodexModelProvider);
  try {
    const selectedModel = modelInfo(true);
    await harness.provider.provideLanguageModelChatResponse(
      selectedModel,
      [message('Reply with OK only.')],
      {},
      { report() {} },
      cancellationToken()
    );
    await harness.provider.provideLanguageModelChatResponse(
      selectedModel,
      [
        message('Reply with OK only.'),
        message('OK', vscodeMock.LanguageModelChatMessageRole.Assistant),
        message('Reply with OK only again.')
      ],
      {},
      { report() {} },
      cancellationToken()
    );
    return harness.latestLatency();
  } finally {
    harness.dispose();
  }
}

function createProviderHarness(CodexModelProvider) {
  const traces = [];
  const context = {
    secrets: {
      async get() {
        return undefined;
      }
    },
    subscriptions: [],
    extension: { packageJSON: { version: 'provider-benchmark' } }
  };
  const outputChannel = {
    debug() {},
    info(message, payload) {
      if (message === 'response latency') {
        traces.push(payload);
      }
    },
    warn() {},
    error() {}
  };
  const authManager = {
    async getStatus() {
      return { accountId };
    },
    async getAccessToken() {
      return accessToken;
    }
  };
  const provider = new CodexModelProvider(context, outputChannel, undefined, undefined, undefined, authManager);
  return {
    provider,
    latestLatency() {
      const latency = traces.at(-1);
      if (!latency?.trace || !latency.context) {
        throw new Error('Provider benchmark did not receive a completed latency trace.');
      }
      return latency;
    },
    dispose() {
      for (const subscription of context.subscriptions) {
        subscription.dispose?.();
      }
    }
  };
}

function modelInfo(directModel) {
  return {
    id: directModel ? `codex::${model}` : model,
    name: model,
    family: model,
    version: 'provider-benchmark',
    maxInputTokens: 272000,
    maxOutputTokens: 32
  };
}

function message(text, role = vscodeMock.LanguageModelChatMessageRole.User) {
  return {
    role,
    content: [new LanguageModelTextPart(text)]
  };
}

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return new Disposable();
    }
  };
}

async function establishIdlePreconnection(preconnectCodexResponsesWebSocket) {
  let resolveHandshake;
  let rejectHandshake;
  const handshake = new Promise((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });
  const started = preconnectCodexResponsesWebSocket({
    baseURL,
    apiKey: accessToken,
    headers: {
      'User-Agent': 'local.codex-for-copilot Codex for Copilot',
      ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {})
    },
    compatibilityProfile: { enabled: true, endpointKey: baseURL },
    authIdentity: createBenchmarkAuthIdentity(),
    extensionVersion: 'provider-benchmark',
    userAgent: `codex-for-copilot/provider-benchmark (${process.platform}; ${process.arch}; vscode/${vscodeMock.version})`,
    onConnected: resolveHandshake,
    onError: rejectHandshake
  });
  if (!started) {
    throw new Error('Provider benchmark could not start an idle WebSocket preconnection.');
  }
  await waitForHandshake(handshake);
}

function createBenchmarkAuthIdentity() {
  const credentialHash = createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
  return accountId ? `codexAuth:${accountId}:${credentialHash}` : `codexAuth:${credentialHash}`;
}

async function waitForHandshake(handshake) {
  let timeout;
  try {
    await Promise.race([
      handshake,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Idle WebSocket preconnection timed out after 15 seconds.')), 15_000);
        timeout.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(values, quantile) {
  const populated = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  const sorted = [...populated].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}