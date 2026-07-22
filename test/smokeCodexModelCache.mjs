import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-model-cache-'));
const bundlePath = join(tempDir, 'codexModelCache.cjs');
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/codexModelCache.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath
});

try {
  const { CodexModelCache } = require(bundlePath);
  await runStaleWhileRevalidateSmokeTest(CodexModelCache);
  console.log('Smoke test passed: model cache serves stale entries immediately and refreshes them once in the background.');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runStaleWhileRevalidateSmokeTest(CodexModelCache) {
  let now = 1_000;
  const cache = new CodexModelCache({
    freshTtlMs: 100,
    staleTtlMs: 1_000,
    now: () => now
  });
  let loadCount = 0;
  const first = await cache.get('scope', async () => {
    loadCount += 1;
    return ['gpt-first'];
  });

  assertEqual(first.state, 'cold', 'cold cache state');
  assertEqual(first.value.join(','), 'gpt-first', 'cold cache value');
  assertEqual(loadCount, 1, 'cold cache load count');
  assertEqual(cache.peek('scope').join(','), 'gpt-first', 'peek returns the cached value');

  now += 50;
  const fresh = await cache.get('scope', async () => {
    loadCount += 1;
    return ['gpt-unexpected'];
  });
  assertEqual(fresh.state, 'fresh', 'fresh cache state');
  assertEqual(fresh.value.join(','), 'gpt-first', 'fresh cache value');
  assertEqual(loadCount, 1, 'fresh cache avoids reload');

  now += 100;
  let resolveRefresh;
  const refreshValue = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const stale = await cache.get('scope', async () => {
    loadCount += 1;
    return refreshValue;
  });
  const joinedStale = await cache.get('scope', async () => {
    loadCount += 1;
    return ['gpt-unexpected'];
  });

  assertEqual(stale.state, 'stale', 'stale cache state');
  assertEqual(stale.value.join(','), 'gpt-first', 'stale cache returns existing value');
  assertEqual(stale.refreshStarted, true, 'stale cache starts refresh');
  assertEqual(joinedStale.refreshStarted, false, 'stale cache joins in-flight refresh');
  assertEqual(loadCount, 2, 'stale cache uses one refresh');

  resolveRefresh(['gpt-refreshed']);
  await stale.refresh;
  now += 1;
  const refreshed = await cache.get('scope', async () => {
    loadCount += 1;
    return ['gpt-unexpected'];
  });
  assertEqual(refreshed.state, 'fresh', 'refreshed cache state');
  assertEqual(refreshed.value.join(','), 'gpt-refreshed', 'refreshed cache value');
  assertEqual(loadCount, 2, 'refreshed cache avoids second load');

  now += 101;
  const failedRefresh = await cache.get('scope', async () => {
    loadCount += 1;
    throw new Error('models unavailable');
  });
  assertEqual(failedRefresh.state, 'stale', 'failed refresh serves stale cache');
  await assertRejects(failedRefresh.refresh, 'failed refresh error');

  now += 1_000;
  let resolveCold;
  const coldValue = new Promise((resolve) => {
    resolveCold = resolve;
  });
  let coldSettled = false;
  const cold = cache.get('scope', async () => {
    loadCount += 1;
    return coldValue;
  }).then((value) => {
    coldSettled = true;
    return value;
  });
  await Promise.resolve();
  assertEqual(coldSettled, false, 'expired cache waits for a cold refresh');
  assertEqual(cache.peek('scope').join(','), 'gpt-refreshed', 'peek retains an expired value during cold refresh');
  resolveCold(['gpt-cold']);
  const coldResult = await cold;
  assertEqual(coldResult.state, 'cold', 'expired cache returns cold state');
  assertEqual(coldResult.value.join(','), 'gpt-cold', 'expired cache returns refreshed value');

  cache.invalidate('scope');
  assertEqual(cache.peek('scope'), undefined, 'invalidating a key removes its peek value');

  const versionedCache = new CodexModelCache({
    freshTtlMs: 100,
    staleTtlMs: 1_000,
    now: () => now
  });
  versionedCache.set('scope', ['gpt-original']);
  now += 101;
  let resolveSupersededRefresh;
  const supersededRefreshValue = new Promise((resolve) => {
    resolveSupersededRefresh = resolve;
  });
  const supersededRefresh = await versionedCache.get('scope', async () => supersededRefreshValue);
  versionedCache.invalidate('scope');
  versionedCache.set('scope', ['gpt-filtered']);
  resolveSupersededRefresh(['gpt-original']);
  await supersededRefresh.refresh;
  assertEqual(
    versionedCache.peek('scope').join(','),
    'gpt-filtered',
    'invalidated in-flight refresh cannot overwrite a replacement value'
  );

  const boundedCache = new CodexModelCache({
    freshTtlMs: 100,
    staleTtlMs: 1_000,
    maxEntries: 1,
    now: () => now
  });
  boundedCache.set('first', ['gpt-first']);
  now += 1;
  boundedCache.set('second', ['gpt-second']);
  assertEqual(boundedCache.peek('first'), undefined, 'eviction removes the oldest peek value');
  assertEqual(boundedCache.peek('second').join(','), 'gpt-second', 'peek retains the bounded cache entry');
}

async function assertRejects(promise, label) {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`${label}: expected promise rejection`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
