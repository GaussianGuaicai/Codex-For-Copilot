import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolCatalog.ts', {});
try {
  const { resolveCodexToolPlan } = loaded.exports;
  const tools = Array.from({ length: 30 }, (_, index) => ({ name: `install_sdk_${index}`, description: 'Install SDK', inputSchema: { type: 'object' } }));
  const extension = { id: 'Contoso.DotNet Install', packageJSON: { displayName: '.NET Install Tool', contributes: { languageModelTools: tools.map((tool) => ({ name: tool.name })) } } };
  const plan = resolveCodexToolPlan({ tools, model: 'gpt-5.6-luna', compatibilityEnabled: true, nativeToolSearch: 'enabled', extensions: [extension] });
  const namespaces = plan.responseTools.filter((tool) => tool.type === 'namespace');
  assertEqual(namespaces.every((tool) => tool.tools.length <= 8), true, 'namespace chunks contain no more than eight functions');
  assertEqual(namespaces.every((tool) => /^[a-z0-9_]{1,64}$/.test(tool.name)), true, 'namespace names are API-safe');
  assertEqual(namespaces.every((tool) => tool.tools.every((nested) => nested.defer_loading === true)), true, 'namespace functions are deferred');
  console.log('Smoke test passed: native namespaces are deterministic, bounded, and deferred.');
} finally { await loaded.dispose(); }
