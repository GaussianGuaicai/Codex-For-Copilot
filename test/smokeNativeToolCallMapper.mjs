import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolCallMapper.ts', {});
try {
  const { mapNativeToolCall, UnknownNativeToolCallError } = loaded.exports;
  const plan = { callMappings: new Map([[JSON.stringify(['ext_a_123_01', 'install']), { namespace: 'ext_a_123_01', backendName: 'install', vscodeName: 'contoso.install' }]]) };
  const mapped = mapNativeToolCall(plan, { itemId: 'item', callId: 'call', namespace: 'ext_a_123_01', name: 'install', input: {} });
  assertEqual(mapped.vscodeName, 'contoso.install', 'namespaced functions retain the original VS Code tool name');
  let rejected = false;
  try { mapNativeToolCall(plan, { itemId: 'item', callId: 'call', namespace: 'unknown', name: 'install', input: {} }); } catch (error) { rejected = error instanceof UnknownNativeToolCallError; }
  assertEqual(rejected, true, 'unknown native function calls are rejected');
  console.log('Smoke test passed: namespaced calls map only to selected VS Code tools.');
} finally { await loaded.dispose(); }
