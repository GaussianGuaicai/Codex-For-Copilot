import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responsesClient.ts', { workspace: { getConfiguration: () => ({ get: () => undefined }) } });
try {
  const { createResponsesServerEventHandler } = loaded.exports;
  const calls = [];
  const handler = createResponsesServerEventHandler({ onToolCall: (call) => calls.push(call), onRawResponseItem: () => {} });
  handler({ type: 'response.output_item.added', item: { id: 'item', type: 'function_call', call_id: 'call', name: 'install', namespace: 'ext_dotnet_01', arguments: '' } });
  handler({ type: 'response.function_call_arguments.done', item_id: 'item', name: 'install', arguments: '{"version":"9"}' });
  assertEqual(calls[0].namespace, 'ext_dotnet_01', 'function call namespace is preserved');
  assertEqual(calls[0].input.version, '9', 'function arguments are parsed once');
  console.log('Smoke test passed: hosted Tool Search internal items stay hidden and calls keep namespaces.');
} finally { await loaded.dispose(); }
