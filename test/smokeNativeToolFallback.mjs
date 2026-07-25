import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const TTL_MS = 10 * 60 * 1000;
const MAX_CAPABILITIES = 64;
const originalDateNow = Date.now;
let now = 1_000;
Date.now = () => now;

try {
  const loaded = await loadBundled('src/nativeToolSearch/nativeToolCapabilities.ts', {});
  try {
    const { canUseNativeToolSearch, isNativeToolSearchUnsupportedError, markNativeToolSearchUnsupported } = loaded.exports;
    const key = 'endpoint-account-model';
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', key), true, 'GPT-5.6 supports native Tool Search');
    assertEqual(isNativeToolSearchUnsupportedError(new Error('unsupported tool type: namespace')), true, 'only explicit protocol rejection is recognized');
    assertEqual(isNativeToolSearchUnsupportedError(new Error('rate limit')), false, 'ordinary errors do not disable native Tool Search');
    markNativeToolSearchUnsupported(key);
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', key), false, 'explicit rejection is cached');
    now += TTL_MS + 1;
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', key), true, 'unsupported capability expires after its TTL');

    for (let index = 0; index < MAX_CAPABILITIES; index += 1) {
      now += 1;
      markNativeToolSearchUnsupported(`overflow-${index}`);
    }
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', 'overflow-0'), false, 'cache hit refreshes deterministic recency');
    now += 1;
    markNativeToolSearchUnsupported(`overflow-${MAX_CAPABILITIES}`);
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', 'overflow-0'), false, 'recently used capability survives overflow');
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', 'overflow-1'), true, 'overflow evicts the deterministic oldest capability');
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', 'overflow-2'), false, 'overflow retains newer unsupported capabilities');
  } finally {
    await loaded.dispose();
  }

  now = 1_000;
  const expiryLoaded = await loadBundled('src/nativeToolSearch/nativeToolCapabilities.ts', {});
  try {
    const { canUseNativeToolSearch, markNativeToolSearchUnsupported } = expiryLoaded.exports;
    markNativeToolSearchUnsupported('expired-recent');
    now += TTL_MS - 2;
    for (let index = 0; index < MAX_CAPABILITIES - 1; index += 1) {
      markNativeToolSearchUnsupported(`current-${index}`);
    }
    now += 1;
    assertEqual(canUseNativeToolSearch('gpt-5.6-luna', 'expired-recent'), false, 'active rejection can become most recently used');
    now += 2;
    markNativeToolSearchUnsupported(`current-${MAX_CAPABILITIES - 1}`);
    assertEqual(
      canUseNativeToolSearch('gpt-5.6-luna', 'current-0'),
      false,
      'global TTL pruning removes an expired recent entry before bounded eviction'
    );
  } finally {
    await expiryLoaded.dispose();
  }

  console.log('Smoke test passed: native Tool Search fallback cache is narrow, globally pruned, and deterministically bounded.');
} finally {
  Date.now = originalDateNow;
}
