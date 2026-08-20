import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const VIRTUAL_TOOLS_SECTION = 'github.copilot.chat.virtualTools';
const PROVIDER_SECTION = 'codexModelProvider';
const updates = [];
const commands = [];
const errors = [];
const informationMessages = [];
const state = new Map();
const OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';
let globalThreshold = 128;
let workspaceThreshold = 64;
let workspaceFolderThreshold = 32;
let nativeToolSearchGlobalValue;
let resetCommandAvailable = true;
let resetCommandFails = false;
let resetCommandBlocker;
let configurationUpdateFails;
let operationSequence;

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
      operationSequence?.push(`reset:${args[0]}`);
      if (resetCommandBlocker) {
        const blocker = resetCommandBlocker;
        resetCommandBlocker = undefined;
        await blocker();
      }
      if (resetCommandFails && args[0] === 'github.copilot.debug.resetVirtualToolGroups') {
        resetCommandFails = false;
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
            operationSequence?.push(`setting:${section}.${setting}:${String(value)}`);
            if (target === vscode.ConfigurationTarget.Global) {
              nativeToolSearchGlobalValue = value;
            }
            if (configurationUpdateFails?.(section, setting, value, target)) {
              throw new Error(`Configuration update failed for ${section}.${setting}`);
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
            operationSequence?.push(`setting:${section}.${setting}:${String(value)}`);
            if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
              workspaceFolderThreshold = value;
            } else if (target === vscode.ConfigurationTarget.Workspace) {
              workspaceThreshold = value;
            } else if (target === vscode.ConfigurationTarget.Global) {
              globalThreshold = value;
            }
            if (configurationUpdateFails?.(section, setting, value, target)) {
              throw new Error(`Configuration update failed for ${section}.${setting}`);
            }
          }
        }
  }
};

const loaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const memento = createState([], { values: state, label: 'state' });
  const context = { globalState: memento, workspaceState: memento };
  operationSequence = [];
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `memento:state:${PREVIOUS_KEY}`,
    `memento:state:${OWNER_KEY}`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:0`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:auto`,
    'reset:github.copilot.debug.resetVirtualToolGroups'
  ]), 'opt-in persists recovery metadata before settings and resets groups last');
  operationSequence = undefined;
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

const serializedLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const savedThresholds = [{ value: 37, target: vscode.ConfigurationTarget.WorkspaceFolder }];
  const workspaceState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, savedThresholds]
  ]);
  const context = { globalState: createState(), workspaceState };
  nativeToolSearchGlobalValue = 'auto';
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 0;
  let releaseReset;
  let reportResetStarted;
  const resetStarted = new Promise((resolve) => {
    reportResetStarted = resolve;
  });
  const resetRelease = new Promise((resolve) => {
    releaseReset = resolve;
  });
  resetCommandBlocker = async () => {
    reportResetStarted();
    await resetRelease;
  };

  const restore = serializedLoaded.exports.restoreVSCodeToolGrouping(context);
  await resetStarted;
  const enable = serializedLoaded.exports.enableNativeToolSearchGroupingBridge(context);
  await new Promise((resolve) => setImmediate(resolve));
  assertEqual(workspaceFolderThreshold, 37, 'blocked restore applies its threshold before the queued enable starts');
  assertEqual(nativeToolSearchGlobalValue, 'disabled', 'blocked restore disables Native Tool Search before the queued enable starts');

  releaseReset();
  await Promise.all([restore, enable]);
  assertEqual(workspaceFolderThreshold, 0, 'queued enable runs after restore cleanup and reapplies the bridge sentinel');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'queued enable finishes with Native Tool Search enabled');
  assertEqual(workspaceState.get(OWNER_KEY), true, 'queued enable retains recoverable ownership after concurrent restore');
  assertEqual(
    JSON.stringify(workspaceState.get(PREVIOUS_KEY)),
    JSON.stringify(savedThresholds),
    'queued enable retains the original threshold after concurrent restore'
  );
  console.log('Smoke test passed: Native Tool Search grouping operations are serialized across restore and enable.');
} finally {
  resetCommandBlocker = undefined;
  await serializedLoaded.dispose();
}

const legacyLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const legacyGlobalState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, [
      { value: 71, target: vscode.ConfigurationTarget.Workspace },
      { value: 47, target: vscode.ConfigurationTarget.WorkspaceFolder }
    ]]
  ]);
  const legacyWorkspaceState = createState();
  const legacyContext = { globalState: legacyGlobalState, workspaceState: legacyWorkspaceState };
  nativeToolSearchGlobalValue = 'auto';
  resetCommandAvailable = true;
  resetCommandFails = true;
  workspaceThreshold = 0;
  workspaceFolderThreshold = 0;

  await legacyLoaded.exports.restoreVSCodeToolGrouping(legacyContext);
  assertEqual(workspaceThreshold, 0, 'failed legacy reset rolls the Workspace threshold back to its owned zero sentinel');
  assertEqual(workspaceFolderThreshold, 0, 'failed legacy reset rolls the WorkspaceFolder threshold back to its owned zero sentinel');
  assertEqual(legacyGlobalState.get(OWNER_KEY), true, 'legacy global ownership remains after Copilot reset fails');
  assertEqual(Array.isArray(legacyGlobalState.get(PREVIOUS_KEY)), true, 'legacy global thresholds remain after Copilot reset fails');

  resetCommandFails = false;
  await legacyLoaded.exports.restoreVSCodeToolGrouping(legacyContext);
  assertEqual(workspaceThreshold, 71, 'legacy global Workspace ownership restores its saved threshold after retry');
  assertEqual(workspaceFolderThreshold, 47, 'legacy global WorkspaceFolder ownership restores its saved threshold after retry');
  assertEqual(legacyGlobalState.get(OWNER_KEY), undefined, 'legacy global ownership clears only after restoration succeeds');
  assertEqual(legacyGlobalState.get(PREVIOUS_KEY), undefined, 'legacy global thresholds clear only after restoration succeeds');
  console.log('Smoke test passed: legacy global workspace ownership survives until restoration succeeds.');
} finally {
  await legacyLoaded.dispose();
}

const upgradedLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const upgradedGlobalState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, [{ value: 53, target: vscode.ConfigurationTarget.WorkspaceFolder }]]
  ]);
  const workspaceAState = createState();
  const workspaceBState = createState();
  const workspaceAContext = { globalState: upgradedGlobalState, workspaceState: workspaceAState };
  const workspaceBContext = { globalState: upgradedGlobalState, workspaceState: workspaceBState };
  nativeToolSearchGlobalValue = undefined;
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 48;
  const commandCountBeforeWorkspaceBRestore = commands.length;

  assertEqual(
    upgradedLoaded.exports.hasNativeToolGroupingBridgeOwnership(workspaceBContext),
    false,
    'workspace B does not claim workspace A legacy global folder ownership at a nonzero threshold'
  );
  assertEqual(
    (await upgradedLoaded.exports.getNativeToolGroupingBridgeStatus(workspaceBContext)).enabledByThisExtension,
    false,
    'workspace B status ignores workspace A legacy global folder ownership'
  );
  assertEqual(await upgradedLoaded.exports.migrateNativeToolSearchOptIn(workspaceBContext), false, 'workspace B does not migrate workspace A legacy ownership');
  assertEqual(nativeToolSearchGlobalValue, undefined, 'workspace B leaves the provider setting untouched during rejected migration');

  await upgradedLoaded.exports.restoreVSCodeToolGrouping(workspaceBContext);
  assertEqual(workspaceFolderThreshold, 48, 'workspace B restore leaves its distinct folder threshold untouched');
  assertEqual(commands.length, commandCountBeforeWorkspaceBRestore, 'workspace B restore does not reset groups for foreign ownership');
  assertEqual(
    JSON.stringify(upgradedGlobalState.get(PREVIOUS_KEY)),
    JSON.stringify([{ value: 53, target: vscode.ConfigurationTarget.WorkspaceFolder }]),
    'workspace B restore preserves workspace A legacy threshold metadata'
  );
  assertEqual(upgradedGlobalState.get(OWNER_KEY), true, 'workspace B restore preserves workspace A legacy ownership marker');

  await upgradedLoaded.exports.enableNativeToolSearchGroupingBridge(workspaceBContext);
  assertEqual(workspaceFolderThreshold, 0, 'workspace B enable applies its own bridge zero sentinel');
  assertEqual(workspaceBState.get(OWNER_KEY), true, 'workspace B enable stores independent workspace ownership');
  assertEqual(
    JSON.stringify(workspaceBState.get(PREVIOUS_KEY)),
    JSON.stringify([{ value: 48, target: vscode.ConfigurationTarget.WorkspaceFolder }]),
    'workspace B enable saves its own folder threshold'
  );
  assertEqual(
    JSON.stringify(upgradedGlobalState.get(PREVIOUS_KEY)),
    JSON.stringify([{ value: 53, target: vscode.ConfigurationTarget.WorkspaceFolder }]),
    'workspace B enable leaves workspace A legacy metadata untouched'
  );

  await upgradedLoaded.exports.restoreVSCodeToolGrouping(workspaceBContext);
  assertEqual(workspaceFolderThreshold, 48, 'workspace B restores its independent folder threshold');
  assertEqual(workspaceBState.get(OWNER_KEY), undefined, 'workspace B clears only its own ownership');
  assertEqual(workspaceBState.get(PREVIOUS_KEY), undefined, 'workspace B clears only its own saved threshold');
  assertEqual(upgradedGlobalState.get(OWNER_KEY), true, 'workspace B cleanup leaves workspace A legacy owner intact');

  workspaceFolderThreshold = 0;
  assertEqual(
    upgradedLoaded.exports.hasNativeToolGroupingBridgeOwnership(workspaceAContext),
    true,
    'workspace A recognizes its legacy ownership while the folder threshold is zero'
  );
  await upgradedLoaded.exports.enableNativeToolSearchGroupingBridge(workspaceAContext);
  assertEqual(workspaceAState.get(OWNER_KEY), undefined, 'workspace A adopts legacy ownership without splitting Mementos');
  assertEqual(
    JSON.stringify(upgradedGlobalState.get(PREVIOUS_KEY)),
    JSON.stringify([{ value: 53, target: vscode.ConfigurationTarget.WorkspaceFolder }]),
    'workspace A repeated enable preserves its original legacy threshold'
  );

  await upgradedLoaded.exports.restoreVSCodeToolGrouping(workspaceAContext);
  assertEqual(workspaceFolderThreshold, 53, 'workspace A restores its legacy folder threshold');
  assertEqual(upgradedGlobalState.get(OWNER_KEY), undefined, 'workspace A clears its legacy owner after successful restore');
  assertEqual(upgradedGlobalState.get(PREVIOUS_KEY), undefined, 'workspace A clears its legacy metadata after successful restore');
  console.log('Smoke test passed: legacy global workspace ownership cannot leak across workspaces.');
} finally {
  await upgradedLoaded.dispose();
}

const globalLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const globalState = createState();
  const workspaceState = createState();
  const context = { globalState, workspaceState };
  nativeToolSearchGlobalValue = 'disabled';
  resetCommandAvailable = true;
  resetCommandFails = false;
  globalThreshold = 91;
  workspaceThreshold = undefined;
  workspaceFolderThreshold = undefined;

  await globalLoaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(globalState.get(OWNER_KEY), true, 'Global threshold ownership is stored in globalState');
  assertEqual(workspaceState.get(OWNER_KEY), undefined, 'Global threshold ownership is not stored in workspaceState');
  assertEqual(
    JSON.stringify(globalState.get(PREVIOUS_KEY)),
    JSON.stringify([{ value: 91, target: vscode.ConfigurationTarget.Global }]),
    'Global threshold ownership preserves the prior Global value'
  );

  await globalLoaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(globalThreshold, 91, 'Global threshold ownership restores the prior Global value');
  console.log('Smoke test passed: Global grouping ownership remains global.');
} finally {
  await globalLoaded.dispose();
}

const mementoFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const previousMementoThresholds = [{ value: 67, target: vscode.ConfigurationTarget.Workspace }];
  const workspaceState = createState([
    [OWNER_KEY, false],
    [PREVIOUS_KEY, previousMementoThresholds]
  ], {
    label: 'workspace',
    failOnceAfterUpdate(key, value) {
      return key === OWNER_KEY && value === true;
    }
  });
  const context = { globalState: createState(), workspaceState };
  nativeToolSearchGlobalValue = 'disabled';
  resetCommandAvailable = true;
  resetCommandFails = false;
  globalThreshold = 128;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 39;
  configurationUpdateFails = undefined;
  operationSequence = [];
  const updateCount = updates.length;
  const commandCount = commands.length;

  await mementoFailureLoaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates.length, updateCount, 'pre-persistence Memento failure does not attempt setting updates');
  assertEqual(commands.length, commandCount, 'pre-persistence Memento failure does not reset Copilot groups');
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `memento:workspace:${PREVIOUS_KEY}`,
    `memento:workspace:${OWNER_KEY}`,
    `memento:workspace:${OWNER_KEY}`,
    `memento:workspace:${PREVIOUS_KEY}`
  ]), 'pre-persistence failure rolls back only attempted Memento writes in reverse order');
  assertEqual(workspaceFolderThreshold, 39, 'pre-persistence Memento failure leaves the Virtual Tool threshold untouched');
  assertEqual(nativeToolSearchGlobalValue, 'disabled', 'pre-persistence Memento failure leaves the Native Tool Search setting untouched');
  assertEqual(workspaceState.get(OWNER_KEY), false, 'Memento failure restores the prior ownership value');
  assertEqual(workspaceState.get(PREVIOUS_KEY), previousMementoThresholds, 'Memento failure restores the prior saved thresholds value');
  assertEqual(errors.at(-1).includes('could not save its tool-discovery ownership state'), true, 'Memento failure is reported to the user');
  operationSequence = undefined;
  console.log('Smoke test passed: pre-persistence failure compensates Memento writes without touching settings or reset.');
} finally {
  await mementoFailureLoaded.dispose();
}

const firstMementoFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const workspaceState = createState([], {
    label: 'workspace',
    failOnceAfterUpdate(key) {
      return key === PREVIOUS_KEY;
    }
  });
  const context = { globalState: createState(), workspaceState };
  nativeToolSearchGlobalValue = 'disabled';
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 37;
  operationSequence = [];
  const updateCount = updates.length;
  const commandCount = commands.length;

  await firstMementoFailureLoaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates.length, updateCount, 'first Memento failure does not attempt setting updates');
  assertEqual(commands.length, commandCount, 'first Memento failure does not reset Copilot groups');
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `memento:workspace:${PREVIOUS_KEY}`,
    `memento:workspace:${PREVIOUS_KEY}`
  ]), 'first Memento failure compensates its mutate-then-reject write');
  assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, 'first Memento failure restores the absent prior recovery metadata');
  assertEqual(workspaceState.get(OWNER_KEY), undefined, 'first Memento failure never writes ownership');
  console.log('Smoke test passed: first recovery metadata write failure stops before settings and reset.');
} finally {
  operationSequence = undefined;
  await firstMementoFailureLoaded.dispose();
}

const settingFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const previousMementoThresholds = [{ value: 73, target: vscode.ConfigurationTarget.Workspace }];
  const workspaceState = createState([
    [OWNER_KEY, false],
    [PREVIOUS_KEY, previousMementoThresholds]
  ], { label: 'workspace' });
  const context = { globalState: createState(), workspaceState };
  nativeToolSearchGlobalValue = 'disabled';
  resetCommandAvailable = true;
  resetCommandFails = false;
  globalThreshold = 128;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 41;
  configurationUpdateFails = (section, setting, value) => (
    section === PROVIDER_SECTION && setting === 'nativeToolSearch' && value === 'auto'
  );
  operationSequence = [];
  const commandCount = commands.length;

  await settingFailureLoaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `memento:workspace:${PREVIOUS_KEY}`,
    `memento:workspace:${OWNER_KEY}`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:0`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:auto`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:disabled`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:41`,
    `memento:workspace:${OWNER_KEY}`,
    `memento:workspace:${PREVIOUS_KEY}`
  ]), 'later setting failure compensates settings and then restores pre-persistence Memento values');
  assertEqual(commands.length, commandCount, 'setting failure before reset does not reset Copilot groups');
  assertEqual(workspaceFolderThreshold, 41, 'later setting failure restores the prior Virtual Tool threshold');
  assertEqual(nativeToolSearchGlobalValue, 'disabled', 'later setting failure restores the prior Native Tool Search setting');
  assertEqual(workspaceState.get(OWNER_KEY), false, 'later setting failure restores the prior ownership value');
  assertEqual(workspaceState.get(PREVIOUS_KEY), previousMementoThresholds, 'later setting failure restores the prior recovery metadata');
  assertEqual(errors.at(-1).includes('could not update its tool-discovery settings'), true, 'later setting failure is reported to the user');
  console.log('Smoke test passed: later setting failure rolls back pre-persisted recovery metadata.');
} finally {
  configurationUpdateFails = undefined;
  operationSequence = undefined;
  await settingFailureLoaded.dispose();
}

const compensationFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const workspaceState = createState([], { label: 'workspace' });
  const context = { globalState: createState(), workspaceState };
  nativeToolSearchGlobalValue = 'disabled';
  resetCommandAvailable = true;
  resetCommandFails = false;
  globalThreshold = 128;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 43;
  configurationUpdateFails = (section, setting, value) => (
    (section === PROVIDER_SECTION && setting === 'nativeToolSearch')
    || (section === VIRTUAL_TOOLS_SECTION && setting === 'threshold' && value === 43)
  );
  operationSequence = [];

  await compensationFailureLoaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(workspaceState.get(OWNER_KEY), true, 'failed setting compensation retains ownership for later recovery');
  assertEqual(
    JSON.stringify(workspaceState.get(PREVIOUS_KEY)),
    JSON.stringify([{ value: 43, target: vscode.ConfigurationTarget.WorkspaceFolder }]),
    'failed setting compensation retains the recovery threshold for later restoration'
  );
  assertEqual(
    errors.at(-1).includes(
      `Rollback also failed: Configuration update failed for ${PROVIDER_SECTION}.nativeToolSearch; Configuration update failed for ${VIRTUAL_TOOLS_SECTION}.threshold`
    ),
    true,
    'failed setting compensations are all retained and reported in execution order'
  );
  assertEqual(JSON.stringify(operationSequence.slice(-4)), JSON.stringify([
    `memento:workspace:${OWNER_KEY}`,
    `memento:workspace:${PREVIOUS_KEY}`,
    `memento:workspace:${PREVIOUS_KEY}`,
    `memento:workspace:${OWNER_KEY}`
  ]), 'compensation failure restores prior Memento values before retaining recovery metadata');
  console.log('Smoke test passed: compensation failures remain recoverable and observable.');
} finally {
  configurationUpdateFails = undefined;
  operationSequence = undefined;
  await compensationFailureLoaded.dispose();
}

const restoreNativeSettingFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const savedThresholds = [{ value: 59, target: vscode.ConfigurationTarget.WorkspaceFolder }];
  const workspaceState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, savedThresholds]
  ]);
  const context = { globalState: createState(), workspaceState };
  nativeToolSearchGlobalValue = 'auto';
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 64;
  workspaceFolderThreshold = 0;
  configurationUpdateFails = (section, setting, value) => (
    section === PROVIDER_SECTION && setting === 'nativeToolSearch' && value === 'disabled'
  );
  operationSequence = [];
  const commandCount = commands.length;

  await restoreNativeSettingFailureLoaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `setting:${PROVIDER_SECTION}.nativeToolSearch:disabled`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:auto`
  ]), 'restore compensates a Native Tool Search setting that mutates then rejects');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'restore returns the rejected Native Tool Search update to its pre-restore value');
  assertEqual(workspaceFolderThreshold, 0, 'Native Tool Search restore failure stops before threshold restoration');
  assertEqual(commands.length, commandCount, 'Native Tool Search restore failure does not reset Copilot groups');
  assertEqual(workspaceState.get(OWNER_KEY), true, 'Native Tool Search restore failure preserves ownership');
  assertEqual(workspaceState.get(PREVIOUS_KEY), savedThresholds, 'Native Tool Search restore failure preserves recovery metadata');
  assertEqual(errors.at(-1).includes('VS Code Virtual Tool Groups could not be restored'), true, 'Native Tool Search restore failure is reported');
  console.log('Smoke test passed: restore compensates a mutate-then-reject Native Tool Search setting.');
} finally {
  configurationUpdateFails = undefined;
  operationSequence = undefined;
  await restoreNativeSettingFailureLoaded.dispose();
}

const restoreThresholdFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const savedThresholds = [
    { value: 71, target: vscode.ConfigurationTarget.Workspace },
    { value: 47, target: vscode.ConfigurationTarget.WorkspaceFolder }
  ];
  const globalState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, savedThresholds]
  ]);
  const context = { globalState, workspaceState: createState() };
  nativeToolSearchGlobalValue = 'auto';
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 0;
  workspaceFolderThreshold = 0;
  configurationUpdateFails = (section, setting, value, target) => (
    section === VIRTUAL_TOOLS_SECTION
    && setting === 'threshold'
    && value === 47
    && target === vscode.ConfigurationTarget.WorkspaceFolder
  );
  operationSequence = [];
  const commandCount = commands.length;

  await restoreThresholdFailureLoaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `setting:${PROVIDER_SECTION}.nativeToolSearch:disabled`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:71`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:47`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:0`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:0`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:auto`
  ]), 'restore rolls back a rejected later threshold and an earlier successful threshold in reverse order');
  assertEqual(workspaceThreshold, 0, 'restore rolls the earlier successful Workspace threshold back to its pre-restore value');
  assertEqual(workspaceFolderThreshold, 0, 'restore rolls the mutate-then-reject WorkspaceFolder threshold back to its pre-restore value');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'restore rolls Native Tool Search back after a later threshold failure');
  assertEqual(commands.length, commandCount, 'threshold restore failure does not reset Copilot groups');
  assertEqual(globalState.get(OWNER_KEY), true, 'threshold restore failure preserves legacy global ownership');
  assertEqual(globalState.get(PREVIOUS_KEY), savedThresholds, 'threshold restore failure preserves all legacy recovery metadata');
  assertEqual(errors.at(-1).includes('VS Code Virtual Tool Groups could not be restored'), true, 'threshold restore failure is reported');
  console.log('Smoke test passed: restore compensates successful and mutate-then-reject thresholds in reverse order.');
} finally {
  configurationUpdateFails = undefined;
  operationSequence = undefined;
  await restoreThresholdFailureLoaded.dispose();
}

const restoreCompensationFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  const savedThresholds = [
    { value: 79, target: vscode.ConfigurationTarget.Workspace },
    { value: 49, target: vscode.ConfigurationTarget.WorkspaceFolder }
  ];
  const globalState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, savedThresholds]
  ]);
  const context = { globalState, workspaceState: createState() };
  nativeToolSearchGlobalValue = 'auto';
  resetCommandAvailable = true;
  resetCommandFails = false;
  workspaceThreshold = 0;
  workspaceFolderThreshold = 0;
  configurationUpdateFails = (section, setting, value) => (
    (section === VIRTUAL_TOOLS_SECTION && setting === 'threshold' && (value === 49 || value === 0))
    || (section === PROVIDER_SECTION && setting === 'nativeToolSearch' && value === 'auto')
  );

  await restoreCompensationFailureLoaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(
    errors.at(-1).includes(
      `Rollback also failed: Configuration update failed for ${VIRTUAL_TOOLS_SECTION}.threshold; Configuration update failed for ${VIRTUAL_TOOLS_SECTION}.threshold; Configuration update failed for ${PROVIDER_SECTION}.nativeToolSearch`
    ),
    true,
    'restore reports every threshold and Native Tool Search compensation failure in rollback order'
  );
  assertEqual(globalState.get(OWNER_KEY), true, 'restore compensation failure preserves ownership for retry');
  assertEqual(globalState.get(PREVIOUS_KEY), savedThresholds, 'restore compensation failure preserves complete recovery metadata');
  console.log('Smoke test passed: restore reports all compensation failures and preserves recoverability.');
} finally {
  configurationUpdateFails = undefined;
  await restoreCompensationFailureLoaded.dispose();
}

const restoreCleanupFailureLoaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  for (const failureMode of ['before', 'after']) {
    for (const failedKey of [PREVIOUS_KEY, OWNER_KEY]) {
      const savedThresholds = [{ value: 61, target: vscode.ConfigurationTarget.WorkspaceFolder }];
      const failCleanupWrite = (key, value) => key === failedKey && value === undefined;
      const workspaceState = createState([
        [OWNER_KEY, true],
        [PREVIOUS_KEY, savedThresholds]
      ], {
        label: 'workspace',
        failOnceBeforeUpdate: failureMode === 'before' ? failCleanupWrite : undefined,
        failOnceAfterUpdate: failureMode === 'after' ? failCleanupWrite : undefined
      });
      const context = { globalState: createState(), workspaceState };
      nativeToolSearchGlobalValue = 'auto';
      resetCommandAvailable = true;
      resetCommandFails = false;
      workspaceThreshold = 64;
      workspaceFolderThreshold = 0;
      configurationUpdateFails = undefined;
      operationSequence = [];

      await restoreCleanupFailureLoaded.exports.restoreVSCodeToolGrouping(context);
      assertEqual(workspaceFolderThreshold, 61, `${failureMode} ${failedKey} cleanup failure leaves the restored threshold in place`);
      assertEqual(nativeToolSearchGlobalValue, 'disabled', `${failureMode} ${failedKey} cleanup failure leaves Native Tool Search disabled`);
      assertEqual(workspaceState.get(OWNER_KEY), true, `${failureMode} ${failedKey} cleanup failure restores ownership for retry`);
      assertEqual(workspaceState.get(PREVIOUS_KEY), savedThresholds, `${failureMode} ${failedKey} cleanup failure restores saved threshold metadata`);
      assertEqual(errors.at(-1).includes('Retry this command to finish cleanup'), true, `${failureMode} ${failedKey} cleanup failure gives retry guidance`);

      operationSequence = [];
      await restoreCleanupFailureLoaded.exports.restoreVSCodeToolGrouping(context);
      assertEqual(workspaceState.get(OWNER_KEY), undefined, `${failureMode} ${failedKey} cleanup retry clears ownership`);
      assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, `${failureMode} ${failedKey} cleanup retry clears saved threshold metadata`);
      assertEqual(
        JSON.stringify(operationSequence.slice(-2)),
        JSON.stringify([
          `memento:workspace:${PREVIOUS_KEY}`,
          `memento:workspace:${OWNER_KEY}`
        ]),
        `${failureMode} ${failedKey} cleanup retry commits ownership removal last`
      );
    }
  }
  console.log('Smoke test passed: restore cleanup persistence failures retain retryable ownership metadata.');
} finally {
  operationSequence = undefined;
  await restoreCleanupFailureLoaded.dispose();
}

function createState(entries = [], options = {}) {
  const values = options.values ?? new Map(entries);
  let failed = false;
  return {
    get: (key) => values.get(key),
    update: async (key, value) => {
      if (options.label) {
        operationSequence?.push(`memento:${options.label}:${key}`);
      }
      if (!failed && options.failOnceBeforeUpdate?.(key, value)) {
        failed = true;
        throw new Error(`Memento update failed before mutation for ${key}`);
      }
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      if (!failed && options.failOnceAfterUpdate?.(key, value)) {
        failed = true;
        throw new Error(`Memento update failed for ${key}`);
      }
    }
  };
}
