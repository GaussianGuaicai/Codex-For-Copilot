import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolReplay.ts', {});
try {
  const { buildCanonicalReplayInput, createCanonicalReplayRequest } = loaded.exports;
  const snapshot = { catalogHash: 'catalog', fullRequest: { input: [{ type: 'message', role: 'user', content: 'one' }] }, responseItems: [{ type: 'function_call', call_id: 'call', name: 'install', namespace: 'ext', arguments: '{}' }] };
  const replay = buildCanonicalReplayInput({ previousSnapshot: snapshot, convertedInput: [], appendedInput: [{ type: 'function_call_output', call_id: 'call', output: 'ok' }], catalogHash: 'catalog' });
  assertEqual(replay.length, 3, 'canonical replay preserves previous input, namespaced call, and output order');
  assertEqual(replay[1].namespace, 'ext', 'canonical replay preserves namespace');
  assertEqual('previous_response_id' in createCanonicalReplayRequest({ input: [], previous_response_id: 'old' }, replay), false, 'canonical replay removes prior response id');
  console.log('Smoke test passed: native continuation replay preserves Tool Search output items.');
} finally { await loaded.dispose(); }
