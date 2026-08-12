import { readFile } from 'node:fs/promises';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
assertEqual(
  manifest.contributes.configuration.properties['codexModelProvider.nativeToolSearch'].default,
  'disabled',
  'the extension manifest leaves tool discovery to VS Code by default'
);

const loaded = await loadBundled('src/config.ts', {
  workspace: {
    getConfiguration: () => ({ get: (_setting, defaultValue) => defaultValue })
  }
});
try {
  assertEqual(
    loaded.exports.getProviderConfig().nativeToolSearch,
    'disabled',
    'the runtime configuration keeps Native Tool Search disabled until the user opts in'
  );
  console.log('Smoke test passed: Native Tool Search is disabled by default in the manifest and runtime.');
} finally { await loaded.dispose(); }
