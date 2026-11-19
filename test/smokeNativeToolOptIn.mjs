import { readFile } from 'node:fs/promises';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
assertEqual(
  manifest.contributes.configuration.properties['codexModelProvider.nativeToolSearch'].default,
  'disabled',
  'the extension manifest leaves tool discovery to VS Code by default'
);
assertEqual(
  manifest.contributes.configuration.properties['codexModelProvider.webSearchStatusDetail'].default,
  'actionsAndSources',
  'the extension manifest shows Web Search actions and sources by default'
);

const configValues = {};
const loaded = await loadBundled('src/config.ts', {
  workspace: {
    getConfiguration: () => ({
      get: (setting, defaultValue) => setting in configValues ? configValues[setting] : defaultValue
    })
  }
});
try {
  const contextSettings = manifest.contributes.configuration.properties;
  assertEqual(contextSettings['codexModelProvider.contextWindowMode'].default, 'standard', 'manifest defaults to the standard context window');
  assertEqual(contextSettings['codexModelProvider.effectiveContextWindowPercent'].default, null, 'manifest defaults to the catalog percentage');
  assertEqual(loaded.exports.getProviderConfig().contextWindowMode, 'standard', 'runtime defaults to the standard context window');
  assertEqual(loaded.exports.getProviderConfig().effectiveContextWindowPercent, undefined, 'runtime preserves the catalog percentage by default');
  for (const value of [1, 80.5, 100]) {
    configValues.effectiveContextWindowPercent = value;
    assertEqual(loaded.exports.getProviderConfig().effectiveContextWindowPercent, value, `percentage ${value} is accepted`);
  }
  for (const value of [0, -1, 100.1, '80', NaN, Infinity]) {
    configValues.effectiveContextWindowPercent = value;
    let error;
    try {
      loaded.exports.getProviderConfig();
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof Error) || !error.message.includes('effectiveContextWindowPercent')) {
      throw new Error(`Invalid percentage ${String(value)} must surface a configuration error.`);
    }
  }
  delete configValues.effectiveContextWindowPercent;
  assertEqual(
    loaded.exports.getProviderConfig().nativeToolSearch,
    'disabled',
    'the runtime configuration keeps Native Tool Search disabled until the user opts in'
  );
  assertEqual(
    loaded.exports.getProviderConfig().webSearch.statusDetail,
    'actionsAndSources',
    'the runtime shows detailed Web Search activity by default'
  );
  Object.assign(configValues, {
    webSearchExternalAccess: false,
    webSearchContextSize: 'high',
    webSearchAllowedDomains: ['OpenAI.com', 'https://invalid.example/path', 'openai.com'],
    webSearchStatusDetail: 'actions',
    webSearchStatusMaxSources: 99
  });
  const webSearch = loaded.exports.getProviderConfig().webSearch;
  assertEqual(webSearch.externalWebAccess, false, 'Web Search live access is configurable');
  assertEqual(webSearch.contextSize, 'high', 'Web Search context size is normalized');
  assertEqual(JSON.stringify(webSearch.allowedDomains), JSON.stringify(['openai.com']), 'Web Search domains are normalized and validated');
  assertEqual(webSearch.statusDetail, 'actions', 'Web Search status detail is configurable');
  assertEqual(webSearch.statusMaxSources, 10, 'Web Search status source count is bounded');
  console.log('Smoke test passed: Native Tool Search is disabled by default in the manifest and runtime.');
} finally { await loaded.dispose(); }
