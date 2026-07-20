import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { loadBundled } from './testBundleHelper.mjs';

if (process.env.CODEX_BENCHMARK_BACKEND !== '1') {
  throw new Error('Set CODEX_BENCHMARK_BACKEND=1 to run the opt-in real-backend benchmark.');
}

const iterations = Math.max(1, Number.parseInt(process.env.CODEX_BENCHMARK_ITERATIONS ?? '10', 10));
const model = process.env.CODEX_TEST_MODEL ?? 'gpt-5.5';
const authPath = process.env.CODEX_AUTH_FILE ?? join(homedir(), '.codex', 'auth.json');
const auth = JSON.parse(await readFile(authPath, 'utf8'));
const accessToken = process.env.CODEX_ACCESS_TOKEN ?? auth.tokens?.access_token;
const accountId = process.env.CODEX_ACCOUNT_ID ?? auth.tokens?.account_id;
if (!accessToken) {
  throw new Error('A Codex access token is required from the environment or auth.json.');
}
const originalFetch = globalThis.fetch;
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
globalThis.fetch = (input, init = {}) => undiciFetch(input, proxyUrl
  ? { ...init, dispatcher: init.dispatcher ?? new ProxyAgent(proxyUrl) }
  : init);

const loaded = await loadBundled(process.env.CODEX_BENCHMARK_RESPONSES_ENTRY ?? 'src/responsesClient.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
const { streamResponseText, disposeReusableResponsesWebSockets } = loaded.exports;
const rows = [];

try {
  await benchmark('http-short', async () => runRequest({ transport: 'http', input: shortInput() }));
  if (process.env.CODEX_BENCHMARK_HTTP_ONLY !== '1') {
    await benchmark('websocket-fresh', async () => {
      disposeReusableResponsesWebSockets();
      return runRequest({ transport: 'websocket', input: shortInput(), websocketPrewarm: 'disabled' });
    });
    await benchmark('websocket-prewarm', async () => {
      disposeReusableResponsesWebSockets();
      return runRequest({ transport: 'websocket', input: shortInput(), websocketPrewarm: 'enabled' });
    });
    await benchmark('websocket-reused', async () => {
      disposeReusableResponsesWebSockets();
      return runReusedWebSocketPair();
    });
  }
  await benchmark('http-long-history', async () => runRequest({ transport: 'http', input: longInput() }));
  if (process.env.CODEX_BENCHMARK_HTTP_ONLY !== '1') {
    await benchmark('http-large-compressed', async () => runRequest({
      transport: 'http',
      input: [{ type: 'message', role: 'user', content: `Reply OK.\n${'context '.repeat(20_000)}` }],
      requestCompression: 'enabled'
    }));
  }

  console.table(rows);
  console.log(JSON.stringify({
    label: process.env.CODEX_BENCHMARK_LABEL ?? 'current',
    model,
    iterations,
    rows
  }, null, 2));
} finally {
  disposeReusableResponsesWebSockets();
  globalThis.fetch = originalFetch;
  await loaded.dispose();
}

async function benchmark(scenario, operation) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await operation());
  }
  rows.push({
    scenario,
    firstVisibleMedianMs: percentile(samples.map((sample) => sample.firstVisibleMs), 0.5),
    firstVisibleP95Ms: percentile(samples.map((sample) => sample.firstVisibleMs), 0.95),
    totalMedianMs: percentile(samples.map((sample) => sample.totalMs), 0.5),
    totalP95Ms: percentile(samples.map((sample) => sample.totalMs), 0.95),
    requestBytesMedian: percentile(samples.map((sample) => sample.requestBytes), 0.5),
    compressedBytesMedian: percentile(samples.map((sample) => sample.compressedBytes), 0.5),
    requestBuildMedianMs: percentile(samples.map((sample) => sample.requestBuildMs), 0.5),
    toolSchemaBytesMedian: percentile(samples.map((sample) => sample.toolSchemaBytes), 0.5),
    toolSchemaCacheHitRate: samples.filter((sample) => sample.toolSchemaCacheHit).length / samples.length,
    reuseRate: samples.filter((sample) => sample.connectionReused).length / samples.length,
    fallbackRate: samples.filter((sample) => sample.fallback).length / samples.length
  });
}

async function runRequest({
  transport,
  input,
  websocketPrewarm = 'disabled',
  requestCompression = 'disabled',
  identity: providedIdentity
}) {
  const startedAt = Date.now();
  let firstVisibleMs;
  let requestBytes = 0;
  let compressedBytes = 0;
  let requestBuildMs = 0;
  let toolSchemaBytes = 0;
  let toolSchemaCacheHit = false;
  let connectionReused = false;
  let fallback = false;
  const identity = providedIdentity ?? {
    installationId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
    turnId: randomUUID(),
    windowId: randomUUID()
  };
  await streamResponseText({
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    apiKey: accessToken,
    headers: accountId ? { 'ChatGPT-Account-ID': accountId } : {},
    transport,
    compatibilityProfile: { enabled: true, endpointKey: 'https://chatgpt.com/backend-api/codex/responses' },
    authIdentity: `benchmark:${accountId ?? 'default'}`,
    identity,
    extensionVersion: 'benchmark',
    userAgent: 'codex-for-copilot/benchmark',
    websocketPrewarm,
    requestCompression,
    omitMaxOutputTokens: true,
    model,
    instructions: 'Reply with OK only.',
    input,
    maxOutputTokens: 32,
    token: cancellationToken(),
    onTextDelta() {
      firstVisibleMs ??= Date.now() - startedAt;
    },
    onWebSocketSession(event) {
      connectionReused ||= event.reused;
    },
    onTransportFallback() {
      fallback = true;
    },
    onTransportMetrics(metrics) {
      requestBytes = Number(metrics.requestBodyBytes ?? requestBytes);
      compressedBytes = Number(metrics.compressedBodyBytes ?? compressedBytes);
      requestBuildMs = Number(metrics.requestBuildMs ?? requestBuildMs);
      toolSchemaBytes = Number(metrics.toolSchemaBytes ?? toolSchemaBytes);
      toolSchemaCacheHit ||= metrics.toolSchemaCacheHit === true;
      connectionReused ||= metrics.connectionReused === true;
    }
  });
  return {
    firstVisibleMs: firstVisibleMs ?? Date.now() - startedAt,
    totalMs: Date.now() - startedAt,
    requestBytes,
    compressedBytes,
    requestBuildMs,
    toolSchemaBytes,
    toolSchemaCacheHit,
    connectionReused,
    fallback
  };
}

async function runReusedWebSocketPair() {
  const identity = {
    installationId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
    turnId: randomUUID(),
    windowId: randomUUID()
  };
  const first = shortInput();
  await runRequest({ transport: 'websocket', input: first, identity });
  return runRequest({
    transport: 'websocket',
    input: [...first, { type: 'message', role: 'user', content: 'Reply OK again.' }],
    identity: { ...identity, turnId: randomUUID() }
  });
}

function shortInput() {
  return [{ type: 'message', role: 'user', content: 'Reply OK.' }];
}

function longInput() {
  return Array.from({ length: 40 }, (_, index) => ({
    type: 'message',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `History item ${index}: ${'context '.repeat(100)}`
  }));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() { return { dispose() {} }; }
  };
}
