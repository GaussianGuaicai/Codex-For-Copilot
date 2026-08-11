import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolCapabilities.ts', {});
try {
  const { canUseNativeToolSearch, isNativeToolSearchUnsupportedError, markNativeToolSearchUnsupported } = loaded.exports;
  const key = 'endpoint-account-model';
  assertEqual(canUseNativeToolSearch('gpt-5.6-luna', key), true, 'GPT-5.6 supports native Tool Search');
  assertEqual(isNativeToolSearchUnsupportedError(new Error('unsupported tool type: namespace')), true, 'only explicit protocol rejection is recognized');
  assertEqual(isNativeToolSearchUnsupportedError(new Error('rate limit')), false, 'ordinary errors do not disable native Tool Search');
  markNativeToolSearchUnsupported(key);
  assertEqual(canUseNativeToolSearch('gpt-5.6-luna', key), false, 'explicit rejection is cached');
  console.log('Smoke test passed: native Tool Search fallback is narrowly classified.');
} finally { await loaded.dispose(); }
