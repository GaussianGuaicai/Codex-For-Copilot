import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolPolicy.ts', {});
try {
  const { getVirtualToolPlaceholderNames, hasVirtualToolPlaceholder, supportsNativeToolSearchModel, chooseImmediateToolNames, shouldAutoEnableNativeToolSearch } = loaded.exports;
  assertEqual(supportsNativeToolSearchModel('gpt-5.4'), true, 'GPT-5.4 is supported');
  assertEqual(supportsNativeToolSearchModel('gpt-5.3'), false, 'older GPT-5 models are excluded');
  assertEqual(hasVirtualToolPlaceholder([{ name: 'activate_group_workspace' }]), true, 'virtual placeholders disable native search');
  assertEqual(getVirtualToolPlaceholderNames([{ name: 'read_file' }, { name: 'activate_group_terminal' }, { name: 'activate_group_workspace' }]).join(','), 'activate_group_terminal,activate_group_workspace', 'runtime fallback records the exact Virtual Tool placeholders VS Code supplied');
  assertEqual(chooseImmediateToolNames(Array.from({ length: 20 }, (_, index) => ({ name: `write_${index}` }))).size, 8, 'immediate functions are bounded');
  assertEqual(shouldAutoEnableNativeToolSearch(12, 4096), true, 'automatic Tool Search enables for a sufficiently large deferred schema payload');
  assertEqual(shouldAutoEnableNativeToolSearch(12, 128), false, 'automatic Tool Search avoids a small deferred schema payload');
  assertEqual(shouldAutoEnableNativeToolSearch(24, 128), true, 'very large catalogs still use automatic Tool Search even when individual schemas are small');
  console.log('Smoke test passed: native Tool Search policy gates and limits are enforced.');
} finally { await loaded.dispose(); }
