import * as vscode from 'vscode';

const VIRTUAL_TOOLS_CONFIGURATION_SECTION = 'github.copilot.chat.virtualTools';
const THRESHOLD_SETTING = 'threshold';
const PROVIDER_CONFIGURATION_SECTION = 'codexModelProvider';
const NATIVE_TOOL_SEARCH_SETTING = 'nativeToolSearch';
const RESET_VIRTUAL_TOOL_GROUPS_COMMAND = 'github.copilot.debug.resetVirtualToolGroups';
export const NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';

interface SavedThreshold { value: unknown; target: vscode.ConfigurationTarget }

type ThresholdStateScope = 'legacy-global' | 'workspace';

interface ThresholdState {
  state: vscode.Memento;
  scope: ThresholdStateScope;
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
  return context.globalState?.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true
    || context.workspaceState?.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true;
}

export async function migrateNativeToolSearchOptIn(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) !== true) {
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

export async function enableNativeToolSearchGroupingBridge(context: vscode.ExtensionContext): Promise<void> {
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
  const thresholdTarget = getEffectiveSettingTarget(inspectedThreshold);
  const nativeToolSearchTarget = getEffectiveSettingTarget(inspectedNativeToolSearch);
  const thresholdStore = getStateForTarget(context, thresholdTarget);
  const thresholdState = thresholdStore.state;
  const savedThresholds = getSavedThresholds(
    thresholdState,
    thresholdStore.scope
  );
  if (!savedThresholds.some((saved) => saved.target === thresholdTarget)) {
    savedThresholds.push({
      value: getSettingValueAtTarget(inspectedThreshold, thresholdTarget),
      target: thresholdTarget
    });
  }

  const previousThreshold = getSettingValueAtTarget(inspectedThreshold, thresholdTarget);
  const previousNativeToolSearch = getSettingValueAtTarget(inspectedNativeToolSearch, nativeToolSearchTarget);
  const previousSavedThresholds = thresholdState.get<unknown>(PREVIOUS_KEY);
  const previousOwner = thresholdState.get<unknown>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY);
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

export async function restoreVSCodeToolGrouping(context: vscode.ExtensionContext): Promise<void> {
  const ownedStates = getOwnedThresholdStates(context);
  const bridgeEnabled = ownedStates.length > 0;
  const virtualToolsConfiguration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  const nativeToolSearchConfiguration = vscode.workspace.getConfiguration(PROVIDER_CONFIGURATION_SECTION);
  const inspectedNativeToolSearch = nativeToolSearchConfiguration.inspect<string>(NATIVE_TOOL_SEARCH_SETTING);
  const nativeToolSearchTarget = getEffectiveSettingTarget(inspectedNativeToolSearch);
  const previousNativeToolSearch = getSettingValueAtTarget(inspectedNativeToolSearch, nativeToolSearchTarget);
  const restoredThresholds: Array<SavedThreshold & { currentValue: unknown }> = [];
  let nativeToolSearchUpdateAttempted = false;
  try {
    if (nativeToolSearchConfiguration.get<string>(NATIVE_TOOL_SEARCH_SETTING, 'disabled') !== 'disabled') {
      nativeToolSearchUpdateAttempted = true;
      await nativeToolSearchConfiguration.update(NATIVE_TOOL_SEARCH_SETTING, 'disabled', nativeToolSearchTarget);
    }
    if (bridgeEnabled) {
      for (const owned of ownedStates) {
        for (const previous of getSavedThresholds(owned.state, owned.scope)) {
          const inspectedThreshold = virtualToolsConfiguration.inspect<number>(THRESHOLD_SETTING);
          const currentValue = getSettingValueAtTarget(inspectedThreshold, previous.target);
          if (currentValue === 0) {
            restoredThresholds.push({ ...previous, currentValue });
            await virtualToolsConfiguration.update(THRESHOLD_SETTING, previous.value, previous.target);
          }
        }
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackVSCodeToolGroupingRestore({
      virtualToolsConfiguration,
      nativeToolSearchConfiguration,
      nativeToolSearchTarget,
      previousNativeToolSearch,
      nativeToolSearchUpdateAttempted,
      restoredThresholds
    });
    const reason = formatErrorReason(error);
    const rollbackReason = formatRollbackErrors(rollbackErrors);
    void vscode.window.showErrorMessage(`VS Code Virtual Tool Groups could not be restored.${reason}${rollbackReason}`);
    return;
  }

  if (!bridgeEnabled) {
    void vscode.window.showInformationMessage('VS Code remains responsible for tool discovery. Native Tool Search is disabled.');
    return;
  }
  if (await resetToolGroups() !== undefined) {
    void vscode.window.showWarningMessage('VS Code Virtual Tool Groups were restored, but Copilot tool groups could not be reset. Reload Window before starting a new Agent request.');
    return;
  }
  const cleanupErrors = await clearRestoredGroupingOwnership(ownedStates);
  if (cleanupErrors.length > 0) {
    void vscode.window.showErrorMessage(
      `VS Code Virtual Tool Groups were restored, but saving the completed restoration failed. Retry this command to finish cleanup.${formatRollbackErrors(cleanupErrors)}`
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
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
    return inspected.workspaceFolderValue;
  }
  if (target === vscode.ConfigurationTarget.Workspace) {
    return inspected.workspaceValue;
  }
  return inspected.globalValue;
}

function getEffectiveSettingTarget(
  inspected: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never
): vscode.ConfigurationTarget {
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

function getEffectiveSettingValue(
  inspected: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never
): unknown {
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

function hasExplicitSettingValue(
  inspected: vscode.WorkspaceConfiguration['inspect'] extends (section: string) => infer Result ? Result : never
): boolean {
  return inspected?.workspaceFolderValue !== undefined
    || inspected?.workspaceValue !== undefined
    || inspected?.globalValue !== undefined;
}

function getStateForTarget(context: vscode.ExtensionContext, target: vscode.ConfigurationTarget): ThresholdState {
  if (target === vscode.ConfigurationTarget.Global) {
    return { state: context.globalState, scope: 'legacy-global' };
  }
  const legacyGlobalThresholds = context.globalState.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true
    ? getSavedThresholds(context.globalState, 'legacy-global')
    : [];
  if (legacyGlobalThresholds.some((saved) => saved.target === target)) {
    return { state: context.globalState, scope: 'legacy-global' };
  }
  return { state: context.workspaceState, scope: 'workspace' };
}

function getOwnedThresholdStates(context: vscode.ExtensionContext): ThresholdState[] {
  return [
    { state: context.globalState, scope: 'legacy-global' as const },
    { state: context.workspaceState, scope: 'workspace' as const }
  ].filter(({ state }) => state.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true);
}

function getSavedThresholds(state: vscode.Memento, scope: ThresholdStateScope): SavedThreshold[] {
  const saved = state.get<SavedThreshold | SavedThreshold[]>(PREVIOUS_KEY);
  const entries = Array.isArray(saved) ? saved : saved ? [saved] : [];
  return entries.flatMap((entry) => {
    const target = isConfigurationTarget(entry.target) ? entry.target : vscode.ConfigurationTarget.Global;
    const accepted = scope === 'legacy-global' || target !== vscode.ConfigurationTarget.Global;
    return accepted ? [{ value: entry.value, target }] : [];
  });
}

async function clearRestoredGroupingOwnership(ownedStates: readonly ThresholdState[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const owned of ownedStates) {
    const previousOwner = owned.state.get<unknown>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY);
    const previousThresholds = owned.state.get<unknown>(PREVIOUS_KEY);
    try {
      await owned.state.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, undefined);
      await owned.state.update(PREVIOUS_KEY, undefined);
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

function isConfigurationTarget(value: unknown): value is vscode.ConfigurationTarget {
  return value === vscode.ConfigurationTarget.Global
    || value === vscode.ConfigurationTarget.Workspace
    || value === vscode.ConfigurationTarget.WorkspaceFolder;
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
  savedThresholds: SavedThreshold[];
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
  virtualToolsConfiguration: vscode.WorkspaceConfiguration;
  nativeToolSearchConfiguration: vscode.WorkspaceConfiguration;
  nativeToolSearchTarget: vscode.ConfigurationTarget;
  previousNativeToolSearch: unknown;
  nativeToolSearchUpdateAttempted: boolean;
  restoredThresholds: ReadonlyArray<SavedThreshold & { currentValue: unknown }>;
}

async function rollbackVSCodeToolGroupingRestore(options: VSCodeToolGroupingRestoreRollbackOptions): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  for (const restored of [...options.restoredThresholds].reverse()) {
    try {
      await options.virtualToolsConfiguration.update(THRESHOLD_SETTING, restored.currentValue, restored.target);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
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
