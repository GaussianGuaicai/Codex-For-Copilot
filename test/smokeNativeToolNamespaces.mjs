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

  const privateTools = Array.from({ length: 30 }, (_, index) => ({
    name: `private_tool_${index}`,
    description: 'Workspace-provided tool',
    inputSchema: { type: 'object' }
  }));
  const privatePlan = resolveCodexToolPlan({
    tools: privateTools,
    model: 'gpt-5.6-luna',
    compatibilityEnabled: true,
    nativeToolSearch: 'enabled',
    extensions: []
  });
  const privateNamespaces = privatePlan.responseTools.filter((tool) => tool.type === 'namespace');
  assertEqual(privateNamespaces.length, 3, 'unattributed tools share the private namespace and are chunked');
  assertEqual(privateNamespaces.every((tool) => tool.name.startsWith('private_tools_')), true, 'private fallback keeps its namespace prefix');
  assertEqual(privateNamespaces.map((tool) => tool.tools.length).join(','), '8,8,6', 'private namespace chunks are capped at eight functions');
  console.log('Smoke test passed: native namespaces are deterministic, bounded, and deferred.');
} finally { await loaded.dispose(); }
