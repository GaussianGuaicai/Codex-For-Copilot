import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolCatalog.ts', {});
try {
  const { resolveCodexToolPlan } = loaded.exports;
  const tools = Array.from({ length: 13 }, (_, index) => ({
    name: index === 0 ? 'read_file' : `contoso_tool_${String(index).padStart(2, '0')}`,
    description: `Tool ${index}`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
  }));
  const plan = resolveCodexToolPlan({ tools, model: 'gpt-5.6-luna', compatibilityEnabled: true,
    nativeToolSearch: 'auto', extensions: [] });
  const repeated = resolveCodexToolPlan({ tools: [...tools].reverse(), model: 'gpt-5.6-luna', compatibilityEnabled: true,
    nativeToolSearch: 'auto', extensions: [] });
  assertEqual(plan.mode, 'native-hosted', 'large selected catalogs use hosted Tool Search');
  assertEqual(plan.responseTools.at(-1).type, 'tool_search', 'hosted search is included once');
  assertEqual(plan.catalogHash, repeated.catalogHash, 'catalog construction is independent of incoming tool order');
  assertEqual(plan.originalToolCount, 13, 'only selected tools are catalogued');
  console.log('Smoke test passed: native Tool Search catalog is selected-only and deterministic.');
} finally { await loaded.dispose(); }
