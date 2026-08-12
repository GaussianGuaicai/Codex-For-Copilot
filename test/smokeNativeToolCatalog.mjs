import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolCatalog.ts', {});
try {
  const { resolveCodexToolPlan, resetNativeToolCatalogCache } = loaded.exports;
  const tools = Array.from({ length: 13 }, (_, index) => ({
    name: index === 0 ? 'read_file' : `contoso_tool_${String(index).padStart(2, '0')}`,
    description: `Tool ${index}: ${'schema-rich-description '.repeat(80)}`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
  }));
  resetNativeToolCatalogCache();
  const plan = resolveCodexToolPlan({ tools, model: 'gpt-5.6-luna', compatibilityEnabled: true,
    nativeToolSearch: 'auto', extensions: [] });
  const repeated = resolveCodexToolPlan({ tools: [...tools].reverse(), model: 'gpt-5.6-luna', compatibilityEnabled: true,
    nativeToolSearch: 'auto', extensions: [] });
  assertEqual(plan.mode, 'native-hosted', 'large selected catalogs use hosted Tool Search');
  assertEqual(plan.responseTools.at(-1).type, 'tool_search', 'hosted search is included once');
  assertEqual(plan.catalogHash, repeated.catalogHash, 'catalog construction is independent of incoming tool order');
  assertEqual(plan.originalToolCount, 13, 'only selected tools are catalogued');
  assertEqual(plan.deferredToolSchemaBytes >= 4096, true, 'automatic selection measures deferred schema payload size');
  const cachedPlan = resolveCodexToolPlan({ tools, model: 'gpt-5.6-luna', compatibilityEnabled: true,
    nativeToolSearch: 'auto', extensions: [] });
  assertEqual(plan.nativeToolCatalogCacheHit, false, 'first native catalog construction is not a cache hit');
  assertEqual(cachedPlan.nativeToolCatalogCacheHit, true, 'repeated native catalog construction reuses the local catalog');
  const smallSchemaPlan = resolveCodexToolPlan({
    tools: Array.from({ length: 13 }, (_, index) => ({ name: `small_tool_${index}`, description: 'Small', inputSchema: { type: 'object' } })),
    model: 'gpt-5.6-luna', compatibilityEnabled: true, nativeToolSearch: 'auto', extensions: []
  });
  assertEqual(smallSchemaPlan.mode, 'legacy', 'automatic Tool Search avoids small deferred schema payloads');
  assertEqual(smallSchemaPlan.nativeToolSearchReason, 'auto-deferred-schema-small', 'automatic schema fallback is diagnosable');
  const virtualPlan = resolveCodexToolPlan({
    tools: [...tools, { name: 'activate_group_workspace', description: 'Activate workspace tools', inputSchema: { type: 'object' } }],
    model: 'gpt-5.6-luna', compatibilityEnabled: true, nativeToolSearch: 'enabled', extensions: []
  });
  assertEqual(virtualPlan.mode, 'legacy', 'Virtual Tool placeholders take precedence and retain VS Code virtual-tool execution');
  console.log('Smoke test passed: native Tool Search catalog is selected-only and deterministic.');
} finally { await loaded.dispose(); }
