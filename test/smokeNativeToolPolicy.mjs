import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolPolicy.ts', {});
try {
  const { getVirtualToolPlaceholderNames, hasVirtualToolPlaceholder, supportsNativeToolSearchModel, chooseImmediateToolNames } = loaded.exports;
  assertEqual(supportsNativeToolSearchModel('gpt-5.4'), true, 'GPT-5.4 is supported');
  assertEqual(supportsNativeToolSearchModel('gpt-5.3'), false, 'older GPT-5 models are excluded');
  assertEqual(hasVirtualToolPlaceholder([{ name: 'activate_group_workspace' }]), true, 'virtual placeholders disable native search');
  assertEqual(getVirtualToolPlaceholderNames([{ name: 'read_file' }, { name: 'activate_group_terminal' }, { name: 'activate_group_workspace' }]).join(','), 'activate_group_terminal,activate_group_workspace', 'runtime fallback records the exact Virtual Tool placeholders VS Code supplied');
  assertEqual(chooseImmediateToolNames(Array.from({ length: 20 }, (_, index) => ({ name: `write_${index}` }))).size, 8, 'immediate functions are bounded');
  console.log('Smoke test passed: native Tool Search policy gates and limits are enforced.');
} finally { await loaded.dispose(); }
