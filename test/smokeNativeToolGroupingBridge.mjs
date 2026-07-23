import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const updates = [];
const state = new Map();
let threshold = 9;
const vscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: { showWarningMessage: async () => 'Enable', showInformationMessage: () => undefined },
  workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: threshold }), update: async (...args) => { updates.push(args); threshold = args[1]; } }) }
};
const loaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const context = { globalState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) } };
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates[0][1], 0, 'bridge only changes the virtual-tools threshold after confirmation');
  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(updates[1][1], 9, 'bridge restores its saved value when still owner');
  console.log('Smoke test passed: virtual tool grouping bridge saves and restores user settings safely.');
} finally { await loaded.dispose(); }
