import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const VIRTUAL_TOOLS_SECTION = 'github.copilot.chat.virtualTools';
const PROVIDER_SECTION = 'codexModelProvider';
const OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';
const RESET_COMMAND = 'github.copilot.debug.resetVirtualToolGroups';
const updates = [];
const commands = [];
const errors = [];
const informationMessages = [];
let globalThreshold = 128;
let workspaceThreshold = 64;
let nativeToolSearchGlobalValue;
let nativeToolSearchWorkspaceValue;
let resetCommandAvailable = true;
let resetCommandFails = false;
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
    getCommands: async () => resetCommandAvailable ? [RESET_COMMAND] : [],
    executeCommand: async (...args) => {
      operationSequence?.push(`reset:${args[0]}`);
      if (resetCommandFails && args[0] === RESET_COMMAND) {
        resetCommandFails = false;
        throw new Error('Copilot reset failed');
      }
      commands.push(args);
    }
  },
  workspace: {
    getConfiguration(section) {
      assertEqual(arguments.length, 1, `${section} configuration is always window-scoped`);
      if (section === PROVIDER_SECTION) {
        return {
          inspect: () => withForbiddenFolderValue({
            globalValue: nativeToolSearchGlobalValue,
            workspaceValue: nativeToolSearchWorkspaceValue
          }),
          update: async (setting, value, target) => {
            updates.push({ section, setting, value, target });
            operationSequence?.push(`setting:${section}.${setting}:${String(value)}`);
            if (target === vscode.ConfigurationTarget.Workspace) {
              nativeToolSearchWorkspaceValue = value;
            } else if (target === vscode.ConfigurationTarget.Global) {
              nativeToolSearchGlobalValue = value;
            } else {
              throw new Error('WorkspaceFolder provider update is forbidden');
            }
            if (configurationUpdateFails?.(section, setting, value, target)) {
              throw new Error(`Configuration update failed for ${section}.${setting}`);
            }
          }
        };
      }
      if (section !== VIRTUAL_TOOLS_SECTION) {
        throw new Error(`Unexpected configuration section: ${section}`);
      }
      return {
        inspect: () => withForbiddenFolderValue({
          globalValue: globalThreshold,
          workspaceValue: workspaceThreshold
        }),
        update: async (setting, value, target) => {
          updates.push({ section, setting, value, target });
          operationSequence?.push(`setting:${section}.${setting}:${String(value)}`);
          if (target === vscode.ConfigurationTarget.Workspace) {
            workspaceThreshold = value;
          } else if (target === vscode.ConfigurationTarget.Global) {
            globalThreshold = value;
          } else {
            throw new Error('WorkspaceFolder threshold update is forbidden');
          }
          if (configurationUpdateFails?.(section, setting, value, target)) {
            throw new Error(`Configuration update failed for ${section}.${setting}`);
          }
        }
      };
    }
  }
};

const loaded = await loadBundled('src/nativeToolSearch/nativeToolGroupingBridge.ts', vscode);
try {
  await runWorkspaceEnableRestoreTest();
  await runGlobalEnableRestoreAndMigrationTest();
  await runResetRollbackTest();
  await runSharedTargetAndUnsetSerializationTest();
  await runMixedOpaqueRetentionTest();
  await runMalformedMetadataTests();
  await runEnablePreservesOpaqueMetadataTest();
  await runAmbiguousOwnershipEnableTests();
  await runTransactionalFailureTests();
  await runRestoreRollbackTest();
  await runCleanupFailureTests();
  console.log('Smoke test passed: Native Tool Search grouping ownership is strict, window-scoped, and transactional.');
} finally {
  await loaded.dispose();
}

async function runWorkspaceEnableRestoreTest() {
  resetHarness();
  const globalState = createState();
  const workspaceState = createState([], { label: 'workspace' });
  const context = { globalState, workspaceState };
  operationSequence = [];

  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(JSON.stringify(operationSequence), JSON.stringify([
    `memento:workspace:${PREVIOUS_KEY}`,
    `memento:workspace:${OWNER_KEY}`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:0`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:auto`,
    `reset:${RESET_COMMAND}`
  ]), 'workspace opt-in persists recovery metadata before settings and resets last');
  assertEqual(workspaceThreshold, 0, 'workspace opt-in disables grouping at Workspace target');
  assertEqual(nativeToolSearchWorkspaceValue, 'auto', 'workspace opt-in enables provider policy at Workspace target');
  assertEqual(JSON.stringify(workspaceState.get(PREVIOUS_KEY)), JSON.stringify([
    { version: 1, target: 'workspace', previous: 'value', value: 64 }
  ]), 'workspace opt-in records an explicit Workspace target');
  assertEqual(globalState.get(OWNER_KEY), undefined, 'workspace opt-in does not create global ownership');

  operationSequence = [];
  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(workspaceThreshold, 64, 'workspace restore returns the original threshold');
  assertEqual(nativeToolSearchWorkspaceValue, 'disabled', 'workspace restore disables the provider policy');
  assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, 'workspace restore clears recovery metadata');
  assertEqual(workspaceState.get(OWNER_KEY), undefined, 'workspace restore clears ownership');
  assertEqual(updates.some((update) => update.target === vscode.ConfigurationTarget.WorkspaceFolder), false, 'bridge never writes WorkspaceFolder settings');
  assertEqual((await loaded.exports.getNativeToolGroupingBridgeStatus(context)).enabledByThisExtension, false, 'status reports completed restoration');
}

async function runGlobalEnableRestoreAndMigrationTest() {
  resetHarness({ workspaceThresholdValue: undefined });
  const globalState = createState();
  const workspaceState = createState();
  const context = { globalState, workspaceState };

  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(globalThreshold, 0, 'global opt-in disables grouping at Global target');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'global opt-in enables provider policy at Global target');
  assertEqual(globalState.get(OWNER_KEY), true, 'global opt-in stores ownership in global state');
  assertEqual(workspaceState.get(OWNER_KEY), undefined, 'global opt-in does not create workspace ownership');
  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(globalThreshold, 128, 'global restore returns the original threshold');

  globalState.set(OWNER_KEY, true);
  globalState.set(PREVIOUS_KEY, [{ value: 128, target: vscode.ConfigurationTarget.Global }]);
  nativeToolSearchGlobalValue = undefined;
  assertEqual(await loaded.exports.migrateNativeToolSearchOptIn(context), true, 'explicit legacy Global ownership can migrate policy');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'legacy migration writes only the Global policy');
  nativeToolSearchGlobalValue = 'disabled';
  assertEqual(await loaded.exports.migrateNativeToolSearchOptIn(context), false, 'migration preserves an explicit policy');
}

async function runResetRollbackTest() {
  resetHarness();
  const workspaceState = createState();
  const context = { globalState: createState(), workspaceState };
  resetCommandFails = true;

  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(workspaceThreshold, 64, 'failed reset restores the Workspace threshold');
  assertEqual(nativeToolSearchWorkspaceValue, undefined, 'failed reset restores the provider policy');
  assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, 'failed reset clears newly-created recovery metadata');
  assertEqual(workspaceState.get(OWNER_KEY), undefined, 'failed reset clears newly-created ownership');
  assertEqual(errors.at(-1).includes('no changes were left behind'), true, 'failed reset reports complete rollback');

  resetCommandAvailable = false;
  const updateCount = updates.length;
  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates.length, updateCount, 'missing reset command prevents every setting write');
}

async function runSharedTargetAndUnsetSerializationTest() {
  resetHarness({ workspaceThresholdValue: undefined });
  nativeToolSearchWorkspaceValue = 'disabled';
  const workspaceState = createState();
  const context = { globalState: createState(), workspaceState };

  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  assertEqual(updates[0].target, vscode.ConfigurationTarget.Workspace, 'an explicit Workspace provider policy aligns both bridge settings at Workspace');
  assertEqual(updates[1].target, vscode.ConfigurationTarget.Workspace, 'aligned provider update remains effective at Workspace');
  assertEqual(JSON.stringify(workspaceState.get(PREVIOUS_KEY)), JSON.stringify([
    { version: 1, target: 'workspace', previous: 'absent' }
  ]), 'an unset threshold uses a JSON-stable absence representation');

  const serialized = JSON.parse(JSON.stringify(workspaceState.get(PREVIOUS_KEY)));
  workspaceState.set(PREVIOUS_KEY, serialized);
  workspaceThreshold = 0;
  nativeToolSearchWorkspaceValue = 'auto';
  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(workspaceThreshold, undefined, 'a serialized absent threshold restores by deleting the Workspace value');
  assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, 'serialized absent-threshold metadata cleans up after restore');

  resetHarness();
  nativeToolSearchGlobalValue = 'disabled';
  const secondWorkspaceState = createState();
  await loaded.exports.enableNativeToolSearchGroupingBridge({ globalState: createState(), workspaceState: secondWorkspaceState });
  assertEqual(updates[0].target, vscode.ConfigurationTarget.Workspace, 'an explicit Workspace threshold aligns a prior Global provider policy upward');
  assertEqual(updates[1].target, vscode.ConfigurationTarget.Workspace, 'provider policy follows the effective Workspace threshold');
}

async function runMixedOpaqueRetentionTest() {
  resetHarness({ workspaceThresholdValue: undefined });
  const opaque = [
    null,
    false,
    'foreign',
    [],
    {},
    { value: 7 },
    { value: 8, target: 99 },
    { value: 9, target: vscode.ConfigurationTarget.Workspace },
    { value: 10, target: vscode.ConfigurationTarget.WorkspaceFolder, resource: 'file:///foreign' }
  ];
  const entries = [{ value: 73, target: vscode.ConfigurationTarget.Global }, ...opaque];
  const originalOpaqueJson = JSON.stringify(opaque);
  const globalState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, entries]
  ]);
  const context = { globalState, workspaceState: createState() };
  globalThreshold = 0;
  nativeToolSearchGlobalValue = 'auto';

  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(globalThreshold, 73, 'mixed metadata restores the explicit Global record');
  const retained = globalState.get(PREVIOUS_KEY);
  assertEqual(JSON.stringify(retained), originalOpaqueJson, 'mixed metadata preserves opaque values byte-for-byte');
  for (let index = 0; index < opaque.length; index += 1) {
    assertEqual(retained[index], opaque[index], `opaque entry ${index} retains its exact value/reference`);
  }
  assertEqual(globalState.get(OWNER_KEY), undefined, 'completed cleanup removes ownership even while opaque metadata is preserved');
  assertEqual(loaded.exports.hasNativeToolGroupingBridgeOwnership(context), false, 'opaque metadata cannot retain actionable ownership');
}

async function runMalformedMetadataTests() {
  const malformedCases = [
    ['null', null],
    ['boolean', false],
    ['string', 'invalid'],
    ['array record', []],
    ['empty object', {}],
    ['missing target', { value: 41 }],
    ['invalid target', { value: 42, target: 99 }],
    ['invalid version', { version: 2, target: 'global', previous: 'value', value: 42 }],
    ['extra field', { version: 1, target: 'global', previous: 'value', value: 42, resource: 'file:///foreign' }],
    ['negative value', { version: 1, target: 'global', previous: 'value', value: -1 }],
    ['infinite value', { version: 1, target: 'global', previous: 'value', value: Number.POSITIVE_INFINITY }],
    ['string value', { version: 1, target: 'global', previous: 'value', value: '42' }],
    ['object value', { version: 1, target: 'global', previous: 'value', value: {} }],
    ['wrong-store Workspace', { value: 43, target: vscode.ConfigurationTarget.Workspace }],
    ['WorkspaceFolder', { value: 44, target: vscode.ConfigurationTarget.WorkspaceFolder, resource: 'file:///workspace' }]
  ];
  for (const [label, malformed] of malformedCases) {
    resetHarness({ workspaceThresholdValue: undefined });
    const stored = [malformed];
    const globalState = createState([
      [OWNER_KEY, true],
      [PREVIOUS_KEY, stored]
    ]);
    const context = { globalState, workspaceState: createState() };
    const updateCount = updates.length;
    const commandCount = commands.length;

    assertEqual(loaded.exports.hasNativeToolGroupingBridgeOwnership(context), false, `${label} metadata does not establish ownership`);
    assertEqual(await loaded.exports.migrateNativeToolSearchOptIn(context), false, `${label} metadata cannot migrate policy`);
    await loaded.exports.restoreVSCodeToolGrouping(context);
    assertEqual(updates.length, updateCount, `${label} metadata causes no configuration writes`);
    assertEqual(commands.length, commandCount, `${label} metadata causes no reset`);
    assertEqual(globalState.get(PREVIOUS_KEY), stored, `${label} metadata is preserved without mutation`);
    assertEqual(globalState.get(OWNER_KEY), true, `${label} owner marker is preserved without being trusted`);
  }

  const workspaceWrongStore = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, [{ value: 51, target: vscode.ConfigurationTarget.Global }]]
  ]);
  const context = { globalState: createState(), workspaceState: workspaceWrongStore };
  assertEqual(loaded.exports.hasNativeToolGroupingBridgeOwnership(context), false, 'wrong-store Global record cannot establish Workspace ownership');
  const updateCount = updates.length;
  await loaded.exports.restoreVSCodeToolGrouping(context);
  assertEqual(updates.length, updateCount, 'wrong-store Global record causes no configuration writes');

  const workspaceMalformedCases = [
    null,
    false,
    'invalid',
    {},
    { version: 1, target: 'workspace', previous: 'value', value: -1 },
    { version: 1, target: 'workspace', previous: 'value', value: 12, extra: true },
    { version: 1, target: 'folder', previous: 'value', value: 12 },
    { version: 1, target: 'global', previous: 'value', value: 12 }
  ];
  for (const malformed of workspaceMalformedCases) {
    resetHarness();
    const stored = [malformed];
    const workspaceState = createState([[OWNER_KEY, true], [PREVIOUS_KEY, stored]]);
    const malformedContext = { globalState: createState(), workspaceState };
    const writesBefore = updates.length;
    const resetsBefore = commands.length;
    assertEqual(loaded.exports.hasNativeToolGroupingBridgeOwnership(malformedContext), false, 'malformed Workspace metadata does not establish ownership');
    await loaded.exports.restoreVSCodeToolGrouping(malformedContext);
    assertEqual(updates.length, writesBefore, 'malformed Workspace metadata causes no configuration writes');
    assertEqual(commands.length, resetsBefore, 'malformed Workspace metadata causes no reset');
    assertEqual(workspaceState.get(PREVIOUS_KEY), stored, 'malformed Workspace metadata remains untouched');
  }
}

async function runEnablePreservesOpaqueMetadataTest() {
  resetHarness();
  const opaque = { value: 67, target: vscode.ConfigurationTarget.WorkspaceFolder, resource: 'file:///legacy' };
  const workspaceState = createState([[PREVIOUS_KEY, [opaque]]]);
  const context = { globalState: createState(), workspaceState };

  await loaded.exports.enableNativeToolSearchGroupingBridge(context);
  const entries = workspaceState.get(PREVIOUS_KEY);
  assertEqual(entries[0], opaque, 'explicit enable preserves pre-existing opaque metadata exactly');
  assertEqual(JSON.stringify(entries[1]), JSON.stringify({
    version: 1,
    target: 'workspace',
    previous: 'value',
    value: 64
  }), 'explicit enable appends an actionable Workspace recovery record');
  assertEqual(loaded.exports.hasNativeToolGroupingBridgeOwnership(context), true, 'explicit enable creates ownership only through its valid Workspace record');
}

async function runAmbiguousOwnershipEnableTests() {
  const validRecord = { version: 1, target: 'workspace', previous: 'value', value: 37 };

  resetHarness();
  const unownedState = createState([[PREVIOUS_KEY, [validRecord]]]);
  const unownedContext = { globalState: createState(), workspaceState: unownedState };
  await loaded.exports.enableNativeToolSearchGroupingBridge(unownedContext);
  assertEqual(updates.length, 0, 'unowned valid recovery metadata blocks enable before setting writes');
  assertEqual(commands.length, 0, 'unowned valid recovery metadata blocks group reset');
  assertEqual(unownedState.get(PREVIOUS_KEY)[0], validRecord, 'unowned valid recovery metadata is preserved exactly');
  assertEqual(unownedState.get(OWNER_KEY), undefined, 'unowned valid recovery metadata never gains ownership implicitly');
  assertEqual(workspaceThreshold, 64, 'unowned valid recovery metadata cannot strand the threshold at zero');

  resetHarness();
  const duplicateRecords = [validRecord, { ...validRecord, value: 41 }];
  const duplicateState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, duplicateRecords]
  ]);
  await loaded.exports.enableNativeToolSearchGroupingBridge({
    globalState: createState(),
    workspaceState: duplicateState
  });
  assertEqual(updates.length, 0, 'duplicate owned recovery records block enable before setting writes');
  assertEqual(commands.length, 0, 'duplicate owned recovery records block group reset');
  assertEqual(duplicateState.get(PREVIOUS_KEY), duplicateRecords, 'duplicate owned recovery records are preserved for manual recovery');
  assertEqual(duplicateState.get(OWNER_KEY), true, 'duplicate owned recovery records retain their explicit owner marker');

  resetHarness();
  const ownerOnlyState = createState([[OWNER_KEY, true]]);
  await loaded.exports.enableNativeToolSearchGroupingBridge({
    globalState: createState(),
    workspaceState: ownerOnlyState
  });
  assertEqual(updates.length, 0, 'owner-only metadata blocks enable before setting writes');
  assertEqual(ownerOnlyState.get(OWNER_KEY), true, 'owner-only metadata is preserved without being trusted');
}

async function runTransactionalFailureTests() {
  for (const failureMode of ['before', 'after']) {
    resetHarness();
    const workspaceState = createState([], {
      label: 'workspace',
      failOnceBeforeUpdate: failureMode === 'before'
        ? (key) => key === PREVIOUS_KEY
        : undefined,
      failOnceAfterUpdate: failureMode === 'after'
        ? (key) => key === PREVIOUS_KEY
        : undefined
    });
    const context = { globalState: createState(), workspaceState };
    await loaded.exports.enableNativeToolSearchGroupingBridge(context);
    assertEqual(workspaceThreshold, 64, `${failureMode} persistence failure leaves the threshold untouched`);
    assertEqual(nativeToolSearchWorkspaceValue, undefined, `${failureMode} persistence failure leaves provider policy untouched`);
    assertEqual(workspaceState.get(OWNER_KEY), undefined, `${failureMode} persistence failure leaves no ownership`);
    assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, `${failureMode} persistence failure restores prior metadata`);
  }

  resetHarness();
  const settingFailureState = createState([], { label: 'workspace' });
  configurationUpdateFails = (section, setting, value) => (
    section === PROVIDER_SECTION && setting === 'nativeToolSearch' && value === 'auto'
  );
  operationSequence = [];
  await loaded.exports.enableNativeToolSearchGroupingBridge({
    globalState: createState(),
    workspaceState: settingFailureState
  });
  assertEqual(workspaceThreshold, 64, 'mutate-then-reject provider failure restores the threshold');
  assertEqual(nativeToolSearchWorkspaceValue, undefined, 'mutate-then-reject provider failure restores provider policy');
  assertEqual(settingFailureState.get(OWNER_KEY), undefined, 'setting failure restores ownership metadata');
  assertEqual(settingFailureState.get(PREVIOUS_KEY), undefined, 'setting failure restores threshold metadata');
  assertEqual(JSON.stringify(operationSequence.slice(-5)), JSON.stringify([
    `setting:${PROVIDER_SECTION}.nativeToolSearch:auto`,
    `setting:${PROVIDER_SECTION}.nativeToolSearch:undefined`,
    `setting:${VIRTUAL_TOOLS_SECTION}.threshold:64`,
    `memento:workspace:${OWNER_KEY}`,
    `memento:workspace:${PREVIOUS_KEY}`
  ]), 'setting compensation starts in reverse mutation order');
  configurationUpdateFails = undefined;
  operationSequence = undefined;
}

async function runRestoreRollbackTest() {
  resetHarness({ globalThresholdValue: 0, workspaceThresholdValue: 0 });
  nativeToolSearchGlobalValue = 'auto';
  nativeToolSearchWorkspaceValue = 'auto';
  const globalState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, [{ version: 1, target: 'global', previous: 'value', value: 91 }]]
  ]);
  const workspaceState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, [{ version: 1, target: 'workspace', previous: 'value', value: 63 }]]
  ]);
  configurationUpdateFails = (section, setting, value, target) => (
    section === VIRTUAL_TOOLS_SECTION
    && setting === 'threshold'
    && value === 91
    && target === vscode.ConfigurationTarget.Global
  );
  operationSequence = [];
  await loaded.exports.restoreVSCodeToolGrouping({ globalState, workspaceState });
  assertEqual(globalThreshold, 0, 'rejected Global restore rolls its mutation back to zero');
  assertEqual(workspaceThreshold, 0, 'earlier Workspace restore rolls back to zero');
  assertEqual(nativeToolSearchGlobalValue, 'auto', 'Global provider policy rolls back after threshold failure');
  assertEqual(nativeToolSearchWorkspaceValue, 'auto', 'Workspace provider policy rolls back after threshold failure');
  assertEqual(globalState.get(OWNER_KEY), true, 'failed restore preserves Global ownership');
  assertEqual(workspaceState.get(OWNER_KEY), true, 'failed restore preserves Workspace ownership');
  configurationUpdateFails = undefined;

  resetHarness({ workspaceThresholdValue: 0 });
  nativeToolSearchWorkspaceValue = 'auto';
  const resetState = createState([
    [OWNER_KEY, true],
    [PREVIOUS_KEY, [{ version: 1, target: 'workspace', previous: 'value', value: 64 }]]
  ]);
  resetCommandFails = true;
  operationSequence = [];
  await loaded.exports.restoreVSCodeToolGrouping({ globalState: createState(), workspaceState: resetState });
  assertEqual(workspaceThreshold, 0, 'failed restore reset returns threshold to its owned sentinel');
  assertEqual(nativeToolSearchWorkspaceValue, 'auto', 'failed restore reset returns provider policy to its prior value');
  assertEqual(operationSequence.filter((entry) => entry === `reset:${RESET_COMMAND}`).length, 2, 'failed restore reset performs a compensating reset after settings rollback');
  assertEqual(resetState.get(OWNER_KEY), true, 'failed reset preserves ownership for retry');
}

async function runCleanupFailureTests() {
  for (const failureMode of ['before', 'after']) {
    for (const failedKey of [PREVIOUS_KEY, OWNER_KEY]) {
      resetHarness({ workspaceThresholdValue: 0 });
      nativeToolSearchWorkspaceValue = 'auto';
      const saved = [{ version: 1, target: 'workspace', previous: 'value', value: 64 }];
      const failCleanup = (key, value) => key === failedKey && value === undefined;
      const workspaceState = createState([
        [OWNER_KEY, true],
        [PREVIOUS_KEY, saved]
      ], {
        label: 'workspace',
        failOnceBeforeUpdate: failureMode === 'before' ? failCleanup : undefined,
        failOnceAfterUpdate: failureMode === 'after' ? failCleanup : undefined
      });
      const context = { globalState: createState(), workspaceState };

      await loaded.exports.restoreVSCodeToolGrouping(context);
      assertEqual(workspaceThreshold, 64, `${failureMode} ${failedKey} cleanup failure leaves restored threshold in place`);
      assertEqual(nativeToolSearchWorkspaceValue, 'disabled', `${failureMode} ${failedKey} cleanup failure leaves provider disabled`);
      assertEqual(workspaceState.get(OWNER_KEY), true, `${failureMode} ${failedKey} cleanup failure restores ownership`);
      assertEqual(workspaceState.get(PREVIOUS_KEY), saved, `${failureMode} ${failedKey} cleanup failure restores metadata`);
      assertEqual(errors.at(-1).includes('Retry this command to finish cleanup'), true, `${failureMode} ${failedKey} cleanup failure provides retry guidance`);

      await loaded.exports.restoreVSCodeToolGrouping(context);
      assertEqual(workspaceState.get(OWNER_KEY), undefined, `${failureMode} ${failedKey} cleanup retry clears ownership`);
      assertEqual(workspaceState.get(PREVIOUS_KEY), undefined, `${failureMode} ${failedKey} cleanup retry clears metadata`);
    }
  }
}

function withForbiddenFolderValue(values) {
  return Object.defineProperty(values, 'workspaceFolderValue', {
    get() {
      throw new Error('WorkspaceFolder inspection is forbidden');
    }
  });
}

function resetHarness(options = {}) {
  updates.length = 0;
  commands.length = 0;
  errors.length = 0;
  informationMessages.length = 0;
  globalThreshold = Object.prototype.hasOwnProperty.call(options, 'globalThresholdValue')
    ? options.globalThresholdValue
    : 128;
  workspaceThreshold = Object.prototype.hasOwnProperty.call(options, 'workspaceThresholdValue')
    ? options.workspaceThresholdValue
    : 64;
  nativeToolSearchGlobalValue = undefined;
  nativeToolSearchWorkspaceValue = undefined;
  resetCommandAvailable = true;
  resetCommandFails = false;
  configurationUpdateFails = undefined;
  operationSequence = undefined;
}

function createState(entries = [], options = {}) {
  const values = new Map(entries);
  let failed = false;
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
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
