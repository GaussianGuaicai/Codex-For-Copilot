import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const VIRTUAL_TOOLS_SECTION = 'github.copilot.chat.virtualTools';
const PROVIDER_SECTION = 'codexModelProvider';
const updates = [];
const commands = [];
const errors = [];
const informationMessages = [];
const state = new Map();
let globalThreshold = 128;
let workspaceThreshold = 64;
let workspaceFolderThreshold = 32;
let nativeToolSearchGlobalValue;
let resetCommandAvailable = true;
let resetCommandFails = false;

const vscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    showWarningMessage: async () => 'Enable',
    showInformationMessage: (message) => informationMessages.push(message),
    showErrorMessage: (message) => errors.push(message)
  },
  commands: {
    getCommands: async () => resetCommandAvailable ? ['github.copilot.debug.resetVirtualToolGroups'] : [],
    executeCommand: async (...args) => {
      if (resetCommandFails && args[0] === 'github.copilot.debug.resetVirtualToolGroups') {
        throw new Error('Copilot reset failed');
      }
      commands.push(args);
    }
  },
  workspace: {
    getConfiguration: (section) => section === PROVIDER_SECTION
      ? {
          get: (_setting, defaultValue) => nativeToolSearchGlobalValue ?? defaultValue,
          inspect: () => ({ globalValue: nativeToolSearchGlobalValue }),
          update: async (setting, value, target) => {
            updates.push({ section, setting, value, target });
            if (target === vscode.ConfigurationTarget.Global) {
              nativeToolSearchGlobalValue = value;
            }
          }
        }
      : {
          // Copilot owns this experimental setting and does not expose it through
          // VS Code's public configuration read API, even though update() persists it.
          get: () => undefined,
          inspect: () => ({
            globalValue: globalThreshold,
            workspaceValue: workspaceThreshold,
            workspaceFolderValue: workspaceFolderThreshold
          }),
          update: async (setting, value, target) => {
            updates.push({ section, setting, value, target });
            if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
              workspaceFolderThreshold = value;
            } else if (target === vscode.ConfigurationTarget.Workspace) {
              workspaceThreshold = value;
            } else if (target === vscode.ConfigurationTarget.Global) {
              globalThreshold = value;
            }
          }
        }
  }
};

const loaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const memento = { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) };
  const context = { globalState: memento, workspaceState: memento };
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates[0].section, VIRTUAL_TOOLS_SECTION, 'opt-in changes the VS Code Virtual Tool setting');
  assertEqual(updates[0].value, 0, 'opt-in disables VS Code Virtual Tool grouping after confirmation');
  assertEqual(updates[0].target, vscode.ConfigurationTarget.WorkspaceFolder, 'opt-in changes the effective workspace-folder setting before lower-priority settings');
  assertEqual(updates[1].section, PROVIDER_SECTION, 'opt-in also changes the Codex provider setting');
  assertEqual(updates[1].value, 'auto', 'opt-in enables the automatic Native Tool Search policy');
  assertEqual(updates[1].target, vscode.ConfigurationTarget.Global, 'opt-in stores the provider policy at its effective setting target');
  assertEqual(commands[0][0], 'github.copilot.debug.resetVirtualToolGroups', 'opt-in resets Copilot virtual tool groups after applying both settings');
  assertEqual(commands.some(([command]) => command === 'workbench.action.reloadWindow'), false, 'opt-in does not interrupt the window for a future Agent request');

  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates[2].target, vscode.ConfigurationTarget.WorkspaceFolder, 'repeated opt-in changes the same effective Virtual Tool setting');
  assertEqual(updates[3].value, 'auto', 'repeated opt-in keeps Native Tool Search automatic');

  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(updates[4].section, PROVIDER_SECTION, 'restoring VS Code discovery disables the provider feature first');
  assertEqual(updates[4].value, 'disabled', 'restoring VS Code discovery disables Native Tool Search');
  assertEqual(updates[5].section, VIRTUAL_TOOLS_SECTION, 'restoring VS Code discovery restores the saved Virtual Tool setting');
  assertEqual(updates[5].value, 32, 'restore uses the original workspace-folder threshold after repeated opt-in');
  assertEqual(updates[5].target, vscode.ConfigurationTarget.WorkspaceFolder, 'restore writes at the originally modified setting target');
  assertEqual(commands[2][0], 'github.copilot.debug.resetVirtualToolGroups', 'restore resets Copilot virtual tool groups after restoring both settings');
  assertEqual(nativeToolSearchGlobalValue, 'disabled', 'VS Code discovery remains the effective default after restore');

  const status = await loaded.exports.getNativeToolGroupingBridgeStatus(context);
  assertEqual(status.enabledByThisExtension, false, 'status reports the restored bridge state');
  assertEqual(status.resetCommandAvailable, true, 'status reports the available reset command');

  resetCommandFails = true;
  const failedEnableStart = updates.length;
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  const failedEnableUpdates = updates.slice(failedEnableStart);
  assertEqual(failedEnableUpdates[0].value, 0, 'failed opt-in attempts the Virtual Tool setting update before reset');
  assertEqual(failedEnableUpdates[1].value, 'auto', 'failed opt-in attempts to enable the provider policy before reset');
  assertEqual(failedEnableUpdates[2].value, 'disabled', 'failed opt-in rolls the provider policy back');
  assertEqual(failedEnableUpdates[3].value, 32, 'failed opt-in restores the VS Code Virtual Tool threshold');
  assertEqual(errors.at(-1).includes('no changes were left behind'), true, 'failed opt-in reports that both settings were rolled back');

  resetCommandFails = false;
  resetCommandAvailable = false;
  const updateCount = updates.length;
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates.length, updateCount, 'opt-in refuses to change either setting when Copilot cannot reset groups');

  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(informationMessages.at(-1).includes('Native Tool Search is disabled'), true, 'the default restore command explains that VS Code remains responsible for tool discovery');

  state.set('nativeToolSearch.virtualToolsThresholdOwner', true);
  nativeToolSearchGlobalValue = undefined;
  assertEqual(await loaded.exports.migrateNativeToolSearchOptIn(context), true, 'an existing opt-in without an explicit policy is migrated once');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'the migration preserves an existing Native Tool Search opt-in');
  nativeToolSearchGlobalValue = 'disabled';
  assertEqual(await loaded.exports.migrateNativeToolSearchOptIn(context), false, 'the migration never overrides an explicit user policy');
  assertEqual(nativeToolSearchGlobalValue, 'disabled', 'an explicit VS Code discovery choice remains disabled');
  console.log('Smoke test passed: Native Tool Search is opt-in and VS Code Virtual Tool Groups restore safely.');
} finally { await loaded.dispose(); }

const scopedLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const sharedGlobalState = createState();
  const contextA = { globalState: sharedGlobalState, workspaceState: createState() };
  const contextB = { globalState: sharedGlobalState, workspaceState: createState() };
  nativeToolSearchGlobalValue = 'disabled';
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 32;

  await scopedLoaded.exports.enableNativeToolSearchGroupingBridge(contextA);
  assertEqual(workspaceFolderThreshold, 0, 'workspace A folder threshold is disabled');

  workspaceFolderThreshold = 48;
  await scopedLoaded.exports.enableNativeToolSearchGroupingBridge(contextB);
  assertEqual(workspaceFolderThreshold, 0, 'workspace B folder threshold is disabled independently');

  workspaceFolderThreshold = 0;
  await scopedLoaded.exports.restoreVSCodeToolGrouping(contextA);
  assertEqual(workspaceFolderThreshold, 32, 'workspace A restores its own folder threshold');

  workspaceFolderThreshold = 0;
  await scopedLoaded.exports.restoreVSCodeToolGrouping(contextB);
  assertEqual(workspaceFolderThreshold, 48, 'workspace B restores its own folder threshold');

  console.log('Smoke test passed: Native Tool Search grouping restoration is scoped per workspace.');
} finally {
  await scopedLoaded.dispose();
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
