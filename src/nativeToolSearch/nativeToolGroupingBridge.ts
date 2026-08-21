import * as vscode from 'vscode';

const VIRTUAL_TOOLS_CONFIGURATION_SECTION = 'github.copilot.chat.virtualTools';
const THRESHOLD_SETTING = 'threshold';
const PROVIDER_CONFIGURATION_SECTION = 'codexModelProvider';
const NATIVE_TOOL_SEARCH_SETTING = 'nativeToolSearch';
const RESET_VIRTUAL_TOOL_GROUPS_COMMAND = 'github.copilot.debug.resetVirtualToolGroups';
export const NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';
const SAVED_THRESHOLD_VERSION = 1;
let groupingBridgeOperation: Promise<void> = Promise.resolve();

type WindowConfigurationTarget = vscode.ConfigurationTarget.Global | vscode.ConfigurationTarget.Workspace;
type StoredThresholdTarget = 'global' | 'workspace';

type SavedThresholdRecordV1 = {
  version: 1;
  target: StoredThresholdTarget;
  previous: 'absent';
} | {
  version: 1;
  target: StoredThresholdTarget;
  previous: 'value';
  value: number;
};

interface SavedThreshold {
  value?: number;
  target: WindowConfigurationTarget;
}

interface SettingSnapshot {
  value: unknown;
  target: WindowConfigurationTarget;
}

type ThresholdStateScope = 'legacy-global' | 'workspace';

interface ThresholdState {
  state: vscode.Memento;
  scope: ThresholdStateScope;
}

interface OwnedThresholdState extends ThresholdState {
  thresholds: SavedThreshold[];
  retainedThresholds: unknown[];
  policyTargets: WindowConfigurationTarget[];
}

interface ParsedThresholdEntries {
  entries: unknown[];
  actionable: SavedThreshold[];
  opaque: unknown[];
}

interface NativeToolGroupingBridgeOwnershipContext {
  globalState?: Pick<vscode.Memento, 'get'>;
  workspaceState?: Pick<vscode.Memento, 'get'>;
}

export interface NativeToolGroupingBridgeStatus {
  enabledByThisExtension: boolean;
  effectiveThreshold: unknown;
  resetCommandAvailable: boolean;
}

export function hasNativeToolGroupingBridgeOwnership(context: NativeToolGroupingBridgeOwnershipContext): boolean {
  if (context.workspaceState?.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true
    && parseThresholdEntries(context.workspaceState, 'workspace').actionable.length > 0) {
    return true;
  }
  if (context.globalState?.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) !== true) {
    return false;
  }
  return parseThresholdEntries(context.globalState, 'legacy-global').actionable.length > 0;
}

export async function migrateNativeToolSearchOptIn(context: vscode.ExtensionContext): Promise<boolean> {
  if (!hasEligibleLegacyGlobalOwnership(context)) {
    return false;
  }
  const configuration = vscode.workspace.getConfiguration(PROVIDER_CONFIGURATION_SECTION);
  const inspected = configuration.inspect<string>(NATIVE_TOOL_SEARCH_SETTING);
  if (hasExplicitSettingValue(inspected)) {
    return false;
  }
  await configuration.update(NATIVE_TOOL_SEARCH_SETTING, 'auto', vscode.ConfigurationTarget.Global);
  return true;
}

export function enableNativeToolSearchGroupingBridge(context: vscode.ExtensionContext): Promise<void> {
  return runGroupingBridgeOperation(() => enableNativeToolSearchGroupingBridgeImpl(context));
}

async function enableNativeToolSearchGroupingBridgeImpl(context: vscode.ExtensionContext): Promise<void> {
  if (!await isVirtualToolGroupResetCommandAvailable()) {
    void vscode.window.showErrorMessage(
      'Native Tool Search could not enable its VS Code grouping bridge because Copilot cannot reset virtual tool groups in this VS Code session. No settings were changed.'
    );
    return;
  }
  const accepted = await vscode.window.showWarningMessage(
    'Enable Native Tool Search? VS Code Virtual Tool Groups let VS Code reveal tools group by group. Native Tool Search instead lets Codex search selected tools on demand. Enabling it temporarily disables VS Code Virtual Tool Groups; your previous setting will be saved and can be restored.',
    { modal: true }, 'Enable'
  );
  if (accepted !== 'Enable') {
    return;
  }
  const virtualToolsConfiguration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  const nativeToolSearchConfiguration = vscode.workspace.getConfiguration(PROVIDER_CONFIGURATION_SECTION);
  const inspectedThreshold = virtualToolsConfiguration.inspect<number>(THRESHOLD_SETTING);
  const inspectedNativeToolSearch = nativeToolSearchConfiguration.inspect<string>(NATIVE_TOOL_SEARCH_SETTING);
  const thresholdTarget = getSharedEffectiveSettingTarget(inspectedThreshold, inspectedNativeToolSearch);
  const nativeToolSearchTarget = thresholdTarget;
  const thresholdStore = getStateForTarget(context, thresholdTarget);
  const thresholdState = thresholdStore.state;
  const parsedThresholds = parseThresholdEntries(thresholdState, thresholdStore.scope);
  const previousThreshold = getSettingValueAtTarget(inspectedThreshold, thresholdTarget);
  if (!isValidThresholdValue(previousThreshold)) {
    void vscode.window.showErrorMessage(
      'Native Tool Search could not enable its VS Code grouping bridge because the current Virtual Tool threshold is invalid. No settings were changed.'
    );
    return;
  }
  const previousNativeToolSearch = getSettingValueAtTarget(inspectedNativeToolSearch, nativeToolSearchTarget);
  const previousSavedThresholds = thresholdState.get<unknown>(PREVIOUS_KEY);
  const previousOwner = thresholdState.get<unknown>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY);
  const recognizedThresholds = parsedThresholds.entries.filter((entry) => (
    isRecognizedThresholdRecord(entry, thresholdTarget)
  ));
  if ((previousOwner !== true && recognizedThresholds.length > 0)
    || (previousOwner === true && parsedThresholds.actionable.length !== 1)) {
    void vscode.window.showErrorMessage(
      'Native Tool Search found ambiguous grouping recovery metadata. No settings were changed; restore or clear the previous ownership state before enabling it again.'
    );
    return;
  }
  const ownedThresholds = previousOwner === true ? parsedThresholds.actionable : [];
  const ownedThreshold = ownedThresholds.length === 1 ? ownedThresholds[0] : undefined;
  const savedThresholds = previousOwner === true
    ? parsedThresholds.entries.filter((entry) => !isRecognizedThresholdRecord(entry, thresholdTarget))
    : [...parsedThresholds.entries];
  savedThresholds.push(createSavedThreshold(
    ownedThreshold ? ownedThreshold.value : previousThreshold,
    thresholdTarget
  ));
  let phase: 'persistence' | 'settings' | 'reset' = 'persistence';
  let thresholdUpdateAttempted = false;
  let nativeToolSearchUpdateAttempted = false;
  let resetAttempted = false;
  let savedThresholdsUpdateAttempted = false;
  let ownerUpdateAttempted = false;
  try {
    savedThresholdsUpdateAttempted = true;
    await thresholdState.update(PREVIOUS_KEY, savedThresholds);
    ownerUpdateAttempted = true;
    await thresholdState.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, true);
    phase = 'settings';
    thresholdUpdateAttempted = true;
    await virtualToolsConfiguration.update(THRESHOLD_SETTING, 0, thresholdTarget);
    nativeToolSearchUpdateAttempted = true;
    await nativeToolSearchConfiguration.update(NATIVE_TOOL_SEARCH_SETTING, 'auto', nativeToolSearchTarget);
    phase = 'reset';
    resetAttempted = true;
    const resetError = await resetToolGroups();
    if (resetError !== undefined) {
      throw resetError;
    }
  } catch (error) {
    const rollbackErrors = await rollbackNativeToolSearchEnable({
      virtualToolsConfiguration,
      nativeToolSearchConfiguration,
      thresholdState,
      thresholdTarget,
      nativeToolSearchTarget,
      previousThreshold,
      previousNativeToolSearch,
      previousSavedThresholds,
      previousOwner,
      savedThresholds,
      thresholdUpdateAttempted,
      nativeToolSearchUpdateAttempted,
      resetAttempted,
      savedThresholdsUpdateAttempted,
      ownerUpdateAttempted
    });
    const reason = formatErrorReason(error);
    const rollbackReason = formatRollbackErrors(rollbackErrors);
    if (phase === 'reset') {
      if (rollbackErrors.length > 0) {
        void vscode.window.showErrorMessage(
          `Native Tool Search could not reset Copilot tool groups, and restoring its tool-discovery settings also failed.${reason}${rollbackReason}`
        );
        return;
      }
      void vscode.window.showErrorMessage(
        'Native Tool Search could not reset Copilot virtual tool groups. Its settings were rolled back and no changes were left behind.'
      );
      return;
    }
    const failure = phase === 'persistence'
      ? 'Native Tool Search could not save its tool-discovery ownership state.'
      : 'Native Tool Search could not update its tool-discovery settings.';
    void vscode.window.showErrorMessage(`${failure}${reason}${rollbackReason}`);
    return;
  }
  void vscode.window.showInformationMessage('Native Tool Search enabled. Codex will use it automatically when it is beneficial and supported.');
}

export function restoreVSCodeToolGrouping(context: vscode.ExtensionContext): Promise<void> {
  return runGroupingBridgeOperation(() => restoreVSCodeToolGroupingImpl(context));
}

async function restoreVSCodeToolGroupingImpl(context: vscode.ExtensionContext): Promise<void> {
  const ownedStates = getOwnedThresholdStates(context);
  const bridgeEnabled = ownedStates.length > 0;
  if (!bridgeEnabled) {
    void vscode.window.showInformationMessage(
      'No Native Tool Search grouping bridge is owned by this workspace. No settings were changed.'
    );
    return;
  }
  const nativeToolSearchTargets = [...new Set(ownedStates.flatMap((owned) => owned.policyTargets))];
  const updatedNativeToolSearchSettings: SettingSnapshot[] = [];
  const restoredThresholds: Array<SavedThreshold & { currentValue: unknown }> = [];
  try {
    for (const target of nativeToolSearchTargets) {
      const nativeToolSearchConfiguration = vscode.workspace.getConfiguration(PROVIDER_CONFIGURATION_SECTION);
      const inspectedNativeToolSearch = nativeToolSearchConfiguration.inspect<string>(NATIVE_TOOL_SEARCH_SETTING);
      const previousValue = getSettingValueAtTarget(inspectedNativeToolSearch, target);
      if (previousValue !== 'disabled') {
        updatedNativeToolSearchSettings.push({ target, value: previousValue });
        await nativeToolSearchConfiguration.update(NATIVE_TOOL_SEARCH_SETTING, 'disabled', target);
      }
    }
    for (const owned of ownedStates) {
      for (const previous of owned.thresholds) {
        const virtualToolsConfiguration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
        const currentInspection = virtualToolsConfiguration.inspect<number>(THRESHOLD_SETTING);
        const currentValue = getSettingValueAtTarget(currentInspection, previous.target);
        if (currentValue === 0) {
          restoredThresholds.push({ ...previous, currentValue });
          await virtualToolsConfiguration.update(THRESHOLD_SETTING, previous.value, previous.target);
        }
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackVSCodeToolGroupingRestore({
      updatedNativeToolSearchSettings,
      restoredThresholds
    });
    const reason = formatErrorReason(error);
    const rollbackReason = formatRollbackErrors(rollbackErrors);
    void vscode.window.showErrorMessage(`VS Code Virtual Tool Groups could not be restored.${reason}${rollbackReason}`);
    return;
  }

  const resetError = await resetToolGroups();
  if (resetError !== undefined) {
    const rollbackErrors = await rollbackVSCodeToolGroupingRestore({
      updatedNativeToolSearchSettings,
      restoredThresholds
    });
    const compensationResetError = await resetToolGroups();
    if (compensationResetError !== undefined) {
      rollbackErrors.push(compensationResetError);
    }
    if (rollbackErrors.length > 0) {
      void vscode.window.showErrorMessage(
        `VS Code Virtual Tool Groups were restored, but Copilot tool groups could not be reset and the restoration could not be rolled back.${formatErrorReason(resetError)}${formatRollbackErrors(rollbackErrors)}`
      );
      return;
    }
    void vscode.window.showWarningMessage('VS Code Virtual Tool Groups could not be reset. The restoration was rolled back; retry this command before starting a new Agent request.');
    return;
  }
  const cleanupErrors = await clearRestoredGroupingOwnership(ownedStates);
  if (cleanupErrors.length > 0) {
    void vscode.window.showErrorMessage(
      `VS Code Virtual Tool Groups were restored, but saving the completed restoration failed. Retry this command to finish cleanup.${formatPersistenceErrors(cleanupErrors)}`
    );
    return;
  }
  void vscode.window.showInformationMessage('VS Code Virtual Tool Groups restored as the default tool-discovery method.');
}

export async function getNativeToolGroupingBridgeStatus(context: vscode.ExtensionContext): Promise<NativeToolGroupingBridgeStatus> {
  const configuration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
  return {
    enabledByThisExtension: getOwnedThresholdStates(context).length > 0,
    effectiveThreshold: getEffectiveSettingValue(inspected),
    resetCommandAvailable: await isVirtualToolGroupResetCommandAvailable()
  };
}

function getSettingValueAtTarget(
  inspected: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never,
  target: vscode.ConfigurationTarget
): unknown {
  if (!inspected) {
    return undefined;
  }
  if (target === vscode.ConfigurationTarget.Workspace) {
    return inspected.workspaceValue;
  }
  return inspected.globalValue;
}

function getSharedEffectiveSettingTarget(
  threshold: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never,
  nativeToolSearch: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never
): WindowConfigurationTarget {
  if (threshold?.workspaceValue !== undefined || nativeToolSearch?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

function getEffectiveSettingValue(
  inspected: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never
): unknown {
  return inspected?.workspaceValue ?? inspected?.globalValue;
}

function hasExplicitSettingValue(
  inspected: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never
): boolean {
  return inspected?.workspaceValue !== undefined
    || inspected?.globalValue !== undefined;
}

function getStateForTarget(
  context: vscode.ExtensionContext,
  target: WindowConfigurationTarget
): ThresholdState {
  if (target === vscode.ConfigurationTarget.Global) {
    return { state: context.globalState, scope: 'legacy-global' };
  }
  return { state: context.workspaceState, scope: 'workspace' };
}

function getOwnedThresholdStates(
  context: vscode.ExtensionContext
): OwnedThresholdState[] {
  const ownedStates: OwnedThresholdState[] = [];
  const workspaceEntries = parseThresholdEntries(context.workspaceState, 'workspace');
  const workspaceThresholds = workspaceEntries.actionable;
  if (context.workspaceState.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true
    && workspaceThresholds.length > 0) {
    ownedStates.push({
      state: context.workspaceState,
      scope: 'workspace',
      thresholds: workspaceThresholds,
      retainedThresholds: workspaceEntries.opaque,
      policyTargets: [vscode.ConfigurationTarget.Workspace]
    });
  }
  if (context.globalState === context.workspaceState
    || context.globalState.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) !== true) {
    return ownedStates;
  }
  const globalEntries = parseThresholdEntries(context.globalState, 'legacy-global');
  const eligibleThresholds = globalEntries.actionable;
  if (eligibleThresholds.length > 0) {
    ownedStates.push({
      state: context.globalState,
      scope: 'legacy-global',
      thresholds: eligibleThresholds,
      retainedThresholds: globalEntries.opaque,
      policyTargets: [vscode.ConfigurationTarget.Global]
    });
  }
  return ownedStates;
}

function hasEligibleLegacyGlobalOwnership(
  context: NativeToolGroupingBridgeOwnershipContext
): boolean {
  if (context.globalState?.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) !== true) {
    return false;
  }
  return parseThresholdEntries(context.globalState, 'legacy-global').actionable.length > 0;
}

function parseThresholdEntries(
  state: Pick<vscode.Memento, 'get'>,
  scope: ThresholdStateScope
): ParsedThresholdEntries {
  const saved = state.get<unknown>(PREVIOUS_KEY);
  const entries = Array.isArray(saved) ? [...saved] : saved === undefined ? [] : [saved];
  const expectedTarget = scope === 'legacy-global'
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;
  const parsed = entries.map((entry) => parseSavedThresholdRecord(entry, expectedTarget));
  const useVersionedRecords = entries.some((entry) => typeof entry === 'object'
    && entry !== null
    && !Array.isArray(entry)
    && Object.prototype.hasOwnProperty.call(entry, 'version'));
  const actionableCandidates: Array<{ threshold: SavedThreshold; index: number }> = [];
  const opaque: unknown[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsedEntry = parsed[index];
    if (!parsedEntry || parsedEntry.versioned !== useVersionedRecords) {
      opaque.push(entries[index]);
      continue;
    }
    actionableCandidates.push({ threshold: parsedEntry.threshold, index });
  }
  if (actionableCandidates.length !== 1) {
    return { entries, actionable: [], opaque: [...entries] };
  }
  return { entries, actionable: [actionableCandidates[0].threshold], opaque };
}

function parseSavedThresholdRecord(
  value: unknown,
  expectedTarget: WindowConfigurationTarget
): { threshold: SavedThreshold; versioned: boolean } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'version')) {
    const storedTarget = toStoredThresholdTarget(expectedTarget);
    if (record.version !== SAVED_THRESHOLD_VERSION || record.target !== storedTarget) {
      return undefined;
    }
    if (record.previous === 'absent' && hasExactKeys(record, ['version', 'target', 'previous'])) {
      return { threshold: { target: expectedTarget }, versioned: true };
    }
    if (record.previous === 'value'
      && hasExactKeys(record, ['version', 'target', 'previous', 'value'])
      && isFiniteThreshold(record.value)) {
      return { threshold: { target: expectedTarget, value: record.value }, versioned: true };
    }
    return undefined;
  }
  if ((hasExactKeys(record, ['target']) || hasExactKeys(record, ['target', 'value']))
    && record.target === expectedTarget
    && isValidThresholdValue(record.value)) {
    return {
      threshold: createThresholdValue(record.value, expectedTarget),
      versioned: false
    };
  }
  return undefined;
}

function createSavedThreshold(
  value: number | undefined,
  target: WindowConfigurationTarget
): SavedThresholdRecordV1 {
  if (value === undefined) {
    return {
      version: SAVED_THRESHOLD_VERSION,
      target: toStoredThresholdTarget(target),
      previous: 'absent'
    };
  }
  return {
    version: SAVED_THRESHOLD_VERSION,
    target: toStoredThresholdTarget(target),
    previous: 'value',
    value
  };
}

function isRecognizedThresholdRecord(value: unknown, expectedTarget: WindowConfigurationTarget): boolean {
  return parseSavedThresholdRecord(value, expectedTarget) !== undefined;
}

function toStoredThresholdTarget(target: WindowConfigurationTarget): StoredThresholdTarget {
  return target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global';
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(record, key)
  ));
}

function createThresholdValue(value: unknown, target: WindowConfigurationTarget): SavedThreshold {
  return {
    target,
    ...(typeof value === 'number' ? { value } : {})
  };
}

function isValidThresholdValue(value: unknown): value is number | undefined {
  return value === undefined || isFiniteThreshold(value);
}

function isFiniteThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function clearRestoredGroupingOwnership(ownedStates: readonly OwnedThresholdState[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const owned of ownedStates) {
    const previousOwner = owned.state.get<unknown>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY);
    const previousThresholds = owned.state.get<unknown>(PREVIOUS_KEY);
    const retainedThresholds = owned.retainedThresholds.length > 0 ? owned.retainedThresholds : undefined;
    try {
      await owned.state.update(PREVIOUS_KEY, retainedThresholds);
      await owned.state.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, undefined);
    } catch (error) {
      errors.push(error);
      try {
        await owned.state.update(PREVIOUS_KEY, previousThresholds);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
      try {
        await owned.state.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, previousOwner);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
  }
  return errors;
}

interface NativeToolSearchEnableRollbackOptions {
  virtualToolsConfiguration: vscode.WorkspaceConfiguration;
  nativeToolSearchConfiguration: vscode.WorkspaceConfiguration;
  thresholdState: vscode.Memento;
  thresholdTarget: vscode.ConfigurationTarget;
  nativeToolSearchTarget: vscode.ConfigurationTarget;
  previousThreshold: unknown;
  previousNativeToolSearch: unknown;
  previousSavedThresholds: unknown;
  previousOwner: unknown;
  savedThresholds: unknown[];
  thresholdUpdateAttempted: boolean;
  nativeToolSearchUpdateAttempted: boolean;
  resetAttempted: boolean;
  savedThresholdsUpdateAttempted: boolean;
  ownerUpdateAttempted: boolean;
}

async function rollbackNativeToolSearchEnable(options: NativeToolSearchEnableRollbackOptions): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  if (options.nativeToolSearchUpdateAttempted) {
    try {
      await options.nativeToolSearchConfiguration.update(
        NATIVE_TOOL_SEARCH_SETTING,
        options.previousNativeToolSearch,
        options.nativeToolSearchTarget
      );
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (options.thresholdUpdateAttempted) {
    try {
      await options.virtualToolsConfiguration.update(
        THRESHOLD_SETTING,
        options.previousThreshold,
        options.thresholdTarget
      );
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (options.resetAttempted) {
    const resetError = await resetToolGroups();
    if (resetError !== undefined) {
      rollbackErrors.push(resetError);
    }
  }
  if (options.ownerUpdateAttempted) {
    try {
      await options.thresholdState.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, options.previousOwner);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (options.savedThresholdsUpdateAttempted) {
    try {
      await options.thresholdState.update(PREVIOUS_KEY, options.previousSavedThresholds);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if ((options.thresholdUpdateAttempted || options.nativeToolSearchUpdateAttempted || options.resetAttempted)
    && rollbackErrors.length > 0) {
    try {
      await options.thresholdState.update(PREVIOUS_KEY, options.savedThresholds);
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await options.thresholdState.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, true);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

interface VSCodeToolGroupingRestoreRollbackOptions {
  updatedNativeToolSearchSettings: SettingSnapshot[];
  restoredThresholds: ReadonlyArray<SavedThreshold & { currentValue: unknown }>;
}

async function rollbackVSCodeToolGroupingRestore(options: VSCodeToolGroupingRestoreRollbackOptions): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  for (const restored of [...options.restoredThresholds].reverse()) {
    try {
      const virtualToolsConfiguration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
      await virtualToolsConfiguration.update(THRESHOLD_SETTING, restored.currentValue, restored.target);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const previous of [...options.updatedNativeToolSearchSettings].reverse()) {
    try {
      const nativeToolSearchConfiguration = vscode.workspace.getConfiguration(PROVIDER_CONFIGURATION_SECTION);
      await nativeToolSearchConfiguration.update(
        NATIVE_TOOL_SEARCH_SETTING,
        previous.value,
        previous.target
      );
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

function formatErrorReason(error: unknown): string {
  return error instanceof Error ? ` ${error.message}` : '';
}

function formatRollbackErrors(errors: readonly unknown[]): string {
  if (errors.length === 0) {
    return '';
  }
  const messages = errors.map((error) => error instanceof Error ? error.message : String(error));
  return ` Rollback also failed: ${messages.join('; ')}`;
}

function formatPersistenceErrors(errors: readonly unknown[]): string {
  if (errors.length === 0) {
    return '';
  }
  const messages = errors.map((error) => error instanceof Error ? error.message : String(error));
  return ` Persistence errors: ${messages.join('; ')}`;
}

function runGroupingBridgeOperation(operation: () => Promise<void>): Promise<void> {
  const result = groupingBridgeOperation.then(operation, operation);
  groupingBridgeOperation = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function resetToolGroups(): Promise<Error | undefined> {
  try {
    await vscode.commands.executeCommand(RESET_VIRTUAL_TOOL_GROUPS_COMMAND);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

async function isVirtualToolGroupResetCommandAvailable(): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes(RESET_VIRTUAL_TOOL_GROUPS_COMMAND);
  } catch {
    return false;
  }
}
