import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolSearchStatus.ts', {});
try {
  const { getNativeToolSearchRuntimeStatus, recordNativeToolSearchRuntimeStatus } = loaded.exports;
  const plan = {
    mode: 'native-hosted',
    originalToolCount: 18,
    immediateToolCount: 8,
    deferredToolCount: 10,
    namespaceCount: 2,
    deferredToolSchemaBytes: 6144,
    nativeToolSearchReason: 'native-enabled'
  };
  recordNativeToolSearchRuntimeStatus({
    model: 'gpt-5.6',
    setting: 'auto',
    plan,
    virtualToolPlaceholderCount: 0
  });
  const status = getNativeToolSearchRuntimeStatus();
  assertEqual(status.mode, 'native-hosted', 'status preserves the last native Tool Search mode');
  assertEqual(status.reason, 'native-enabled', 'status preserves the decision reason');
  assertEqual(status.deferredToolSchemaBytes, 6144, 'status exposes deferred schema bytes without schemas themselves');
  recordNativeToolSearchRuntimeStatus({
    model: 'gpt-5.6',
    setting: 'enabled',
    plan: { ...plan, mode: 'legacy', nativeToolSearchReason: 'backend-unsupported' },
    virtualToolPlaceholderCount: 2,
    reason: 'backend-rejected'
  });
  assertEqual(getNativeToolSearchRuntimeStatus().reason, 'backend-rejected', 'status records an explicit backend fallback');
  console.log('Smoke test passed: native Tool Search runtime status is safe and diagnostic.');
} finally { await loaded.dispose(); }
