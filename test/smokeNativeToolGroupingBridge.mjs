import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const updates = [];
const commands = [];
const state = new Map();
let globalThreshold = 128;
let workspaceThreshold = 64;
let workspaceFolderThreshold = 32;
const vscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: { showWarningMessage: async () => 'Enable and Reload', showInformationMessage: () => undefined },
  commands: { executeCommand: async (...args) => commands.push(args) },
  workspace: {
    getConfiguration: () => ({
      get: () => workspaceFolderThreshold ?? workspaceThreshold ?? globalThreshold,
      inspect: () => ({
        globalValue: globalThreshold,
        workspaceValue: workspaceThreshold,
        workspaceFolderValue: workspaceFolderThreshold
      }),
      update: async (...args) => {
        updates.push(args);
        if (args[2] === vscode.ConfigurationTarget.WorkspaceFolder) {
          workspaceFolderThreshold = args[1];
        } else if (args[2] === vscode.ConfigurationTarget.Workspace) {
          workspaceThreshold = args[1];
        } else if (args[2] === vscode.ConfigurationTarget.Global) {
          globalThreshold = args[1];
        }
      }
    })
  }
};
const loaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const context = { globalState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) } };
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates[0][1], 0, 'bridge only changes the virtual-tools threshold after confirmation');
  assertEqual(updates[0][2], vscode.ConfigurationTarget.WorkspaceFolder, 'bridge changes the effective workspace-folder setting before lower-priority settings');
  assertEqual(commands[0][0], 'github.copilot.debug.resetVirtualToolGroups', 'bridge resets Copilot virtual tool groups after applying the threshold');
  assertEqual(commands[1][0], 'workbench.action.reloadWindow', 'bridge reloads the window so the active chat rebuilds its virtual tool tree');
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates[1][2], vscode.ConfigurationTarget.WorkspaceFolder, 'repeated enable changes the same effective setting');
  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(updates[2][1], 32, 'bridge restores the original workspace-folder threshold after repeated enable');
  assertEqual(updates[2][2], vscode.ConfigurationTarget.WorkspaceFolder, 'bridge restores at the originally modified setting target');
  assertEqual(commands[4][0], 'github.copilot.debug.resetVirtualToolGroups', 'restore resets Copilot virtual tool groups after restoring the threshold');
  assertEqual(commands[5][0], 'workbench.action.reloadWindow', 'restore reloads the window so the active chat rebuilds its virtual tool tree');
  console.log('Smoke test passed: virtual tool grouping bridge saves and restores user settings safely.');
} finally { await loaded.dispose(); }
