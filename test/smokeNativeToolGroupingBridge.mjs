import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const updates = [];
const commands = [];
const sharedGlobalState = createState();
const workspaceStates = { A: createState(), B: createState() };
const thresholds = {
  A: { workspace: 64, folder: 32 },
  B: { workspace: 96, folder: 48 }
};
let activeWorkspace = 'A';
let globalThreshold = 128;
const vscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    showWarningMessage: async () => 'Enable and Reload',
    showErrorMessage: () => undefined
  },
  commands: { executeCommand: async (...args) => commands.push(args) },
  workspace: {
    getConfiguration: () => ({
      get: () => thresholds[activeWorkspace].folder ?? thresholds[activeWorkspace].workspace ?? globalThreshold,
      inspect: () => ({
        globalValue: globalThreshold,
        workspaceValue: thresholds[activeWorkspace].workspace,
        workspaceFolderValue: thresholds[activeWorkspace].folder
      }),
      update: async (_setting, value, target) => {
        updates.push({ workspace: activeWorkspace, value, target });
        if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
          thresholds[activeWorkspace].folder = value;
        } else if (target === vscode.ConfigurationTarget.Workspace) {
          thresholds[activeWorkspace].workspace = value;
        } else if (target === vscode.ConfigurationTarget.Global) {
          globalThreshold = value;
        }
      }
    })
  }
};

const loaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const contextA = { globalState: sharedGlobalState, workspaceState: workspaceStates.A };
  const contextB = { globalState: sharedGlobalState, workspaceState: workspaceStates.B };

  activeWorkspace = 'A';
  await loaded.exports.enableNativeToolSearchGroupingBridge(contextA);
  await loaded.exports.enableNativeToolSearchGroupingBridge(contextA);
  activeWorkspace = 'B';
  await loaded.exports.enableNativeToolSearchGroupingBridge(contextB);
  assertEqual(thresholds.A.folder, 0, 'workspace A folder target is disabled');
  assertEqual(thresholds.B.folder, 0, 'workspace B folder target is disabled independently');
  assertEqual(updates[0].target, vscode.ConfigurationTarget.WorkspaceFolder, 'bridge changes the effective workspace-folder target');
  assertEqual(commands[0][0], 'github.copilot.debug.resetVirtualToolGroups', 'bridge resets Copilot virtual tool groups after applying the threshold');
  assertEqual(commands[1][0], 'workbench.action.reloadWindow', 'bridge reloads after applying the threshold');

  activeWorkspace = 'A';
  await loaded.exports.restoreVSCodeToolGrouping(contextA);
  assertEqual(thresholds.A.folder, 32, 'workspace A restores its original folder threshold after repeated enable');
  assertEqual(thresholds.B.folder, 0, 'restoring workspace A does not consume workspace B ownership');
  activeWorkspace = 'B';
  await loaded.exports.restoreVSCodeToolGrouping(contextB);
  assertEqual(thresholds.B.folder, 48, 'workspace B restores its own folder threshold');

  thresholds.A.folder = undefined;
  thresholds.B.folder = undefined;
  thresholds.A.workspace = 64;
  thresholds.B.workspace = 96;
  activeWorkspace = 'A';
  await loaded.exports.enableNativeToolSearchGroupingBridge(contextA);
  activeWorkspace = 'B';
  await loaded.exports.enableNativeToolSearchGroupingBridge(contextB);
  activeWorkspace = 'A';
  await loaded.exports.restoreVSCodeToolGrouping(contextA);
  assertEqual(thresholds.A.workspace, 64, 'workspace A restores its workspace target');
  assertEqual(thresholds.B.workspace, 0, 'workspace target ownership stays isolated from workspace B');
  activeWorkspace = 'B';
  await loaded.exports.restoreVSCodeToolGrouping(contextB);
  assertEqual(thresholds.B.workspace, 96, 'workspace B restores its own workspace target');

  thresholds.A.workspace = undefined;
  thresholds.B.workspace = undefined;
  globalThreshold = 128;
  activeWorkspace = 'A';
  await loaded.exports.enableNativeToolSearchGroupingBridge(contextA);
  assertEqual(globalThreshold, 0, 'global target is disabled from workspace A');
  activeWorkspace = 'B';
  await loaded.exports.restoreVSCodeToolGrouping(contextB);
  assertEqual(globalThreshold, 128, 'workspace B can restore globally owned state created from workspace A');

  console.log('Smoke test passed: virtual tool grouping state is global only for Global targets and isolated per workspace otherwise.');
} finally {
  await loaded.dispose();
}

function createState() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    update: async (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }
  };
}
