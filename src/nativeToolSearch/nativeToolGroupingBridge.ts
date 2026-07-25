import * as vscode from 'vscode';

const VIRTUAL_TOOLS_CONFIGURATION_SECTION = 'github.copilot.chat.virtualTools';
const THRESHOLD_SETTING = 'threshold';
const PROVIDER_CONFIGURATION_SECTION = 'codexModelProvider';
const NATIVE_TOOL_SEARCH_SETTING = 'nativeToolSearch';
const RESET_VIRTUAL_TOOL_GROUPS_COMMAND = 'github.copilot.debug.resetVirtualToolGroups';
export const NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';

interface SavedThreshold { value: unknown; target: vscode.ConfigurationTarget }

export interface NativeToolGroupingBridgeStatus {
  enabledByThisExtension: boolean;
  effectiveThreshold: unknown;
  resetCommandAvailable: boolean;
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
  const thresholdState = getStateForTarget(context, thresholdTarget);
  const savedThresholds = getSavedThresholds(
    thresholdState,
    thresholdTarget === vscode.ConfigurationTarget.Global
  );
  if (!savedThresholds.some((saved) => saved.target === thresholdTarget)) {
    savedThresholds.push({
      value: getSettingValueAtTarget(inspectedThreshold, thresholdTarget),
      target: thresholdTarget
    });
  }

  const previousThreshold = getSettingValueAtTarget(inspectedThreshold, thresholdTarget);
  const previousNativeToolSearch = getSettingValueAtTarget(inspectedNativeToolSearch, nativeToolSearchTarget);
  let thresholdUpdated = false;
  let nativeToolSearchUpdated = false;
  try {
    await virtualToolsConfiguration.update(THRESHOLD_SETTING, 0, thresholdTarget);
    thresholdUpdated = true;
    await nativeToolSearchConfiguration.update(NATIVE_TOOL_SEARCH_SETTING, 'auto', nativeToolSearchTarget);
    nativeToolSearchUpdated = true;
  } catch (error) {
    const rollbackError = await rollbackNativeToolSearchEnable({
      virtualToolsConfiguration,
      nativeToolSearchConfiguration,
      thresholdTarget,
      nativeToolSearchTarget,
      previousThreshold,
      previousNativeToolSearch,
      thresholdUpdated,
      nativeToolSearchUpdated
    });
    const reason = error instanceof Error ? ` ${error.message}` : '';
    const rollbackReason = rollbackError instanceof Error ? ` Rollback also failed: ${rollbackError.message}` : '';
    void vscode.window.showErrorMessage(`Native Tool Search could not update its tool-discovery settings.${reason}${rollbackReason}`);
    return;
  }
  if (!await resetToolGroups()) {
    const rollbackError = await rollbackNativeToolSearchEnable({
      virtualToolsConfiguration,
      nativeToolSearchConfiguration,
      thresholdTarget,
      nativeToolSearchTarget,
      previousThreshold,
      previousNativeToolSearch,
      thresholdUpdated,
      nativeToolSearchUpdated
    });
    if (rollbackError) {
      const reason = rollbackError instanceof Error ? ` ${rollbackError.message}` : '';
      void vscode.window.showErrorMessage(
        `Native Tool Search could not reset Copilot tool groups, and restoring its tool-discovery settings also failed.${reason}`
      );
      return;
    }
    void vscode.window.showErrorMessage(
      'Native Tool Search could not reset Copilot virtual tool groups. Its settings were rolled back and no changes were left behind.'
    );
    return;
  }
  await thresholdState.update(PREVIOUS_KEY, savedThresholds);
  await thresholdState.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, true);
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
  let nativeToolSearchUpdated = false;
  try {
    if (nativeToolSearchConfiguration.get<string>(NATIVE_TOOL_SEARCH_SETTING, 'disabled') !== 'disabled') {
      await nativeToolSearchConfiguration.update(NATIVE_TOOL_SEARCH_SETTING, 'disabled', nativeToolSearchTarget);
      nativeToolSearchUpdated = true;
    }
    if (bridgeEnabled) {
      for (const owned of ownedStates) {
        for (const previous of getSavedThresholds(owned.state, owned.global)) {
          const inspectedThreshold = virtualToolsConfiguration.inspect<number>(THRESHOLD_SETTING);
          const currentValue = getSettingValueAtTarget(inspectedThreshold, previous.target);
          if (currentValue === 0) {
            await virtualToolsConfiguration.update(THRESHOLD_SETTING, previous.value, previous.target);
            restoredThresholds.push({ ...previous, currentValue });
          }
        }
      }
    }
  } catch (error) {
    const rollbackError = await rollbackVSCodeToolGroupingRestore({
      virtualToolsConfiguration,
      nativeToolSearchConfiguration,
      nativeToolSearchTarget,
      previousNativeToolSearch,
      nativeToolSearchUpdated,
      restoredThresholds
    });
    const reason = error instanceof Error ? ` ${error.message}` : '';
    const rollbackReason = rollbackError instanceof Error ? ` Rollback also failed: ${rollbackError.message}` : '';
    void vscode.window.showErrorMessage(`VS Code Virtual Tool Groups could not be restored.${reason}${rollbackReason}`);
    return;
  }

  if (!bridgeEnabled) {
    void vscode.window.showInformationMessage('VS Code remains responsible for tool discovery. Native Tool Search is disabled.');
    return;
  }
  for (const owned of ownedStates) {
    await owned.state.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, undefined);
    await owned.state.update(PREVIOUS_KEY, undefined);
  }
  if (!await resetToolGroups()) {
    void vscode.window.showWarningMessage('VS Code Virtual Tool Groups were restored, but Copilot tool groups could not be reset. Reload Window before starting a new Agent request.');
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

function getStateForTarget(context: vscode.ExtensionContext, target: vscode.ConfigurationTarget): vscode.Memento {
  return target === vscode.ConfigurationTarget.Global ? context.globalState : context.workspaceState;
}

function getOwnedThresholdStates(context: vscode.ExtensionContext): Array<{ state: vscode.Memento; global: boolean }> {
  return [
    { state: context.globalState, global: true },
    { state: context.workspaceState, global: false }
  ].filter(({ state }) => state.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) === true);
}

function getSavedThresholds(state: vscode.Memento, global: boolean): SavedThreshold[] {
  const saved = state.get<SavedThreshold | SavedThreshold[]>(PREVIOUS_KEY);
  const entries = Array.isArray(saved) ? saved : saved ? [saved] : [];
  return entries.flatMap((entry) => {
    const target = isConfigurationTarget(entry.target) ? entry.target : vscode.ConfigurationTarget.Global;
    const isGlobalTarget = target === vscode.ConfigurationTarget.Global;
    return isGlobalTarget === global ? [{ value: entry.value, target }] : [];
  });
}

function isConfigurationTarget(value: unknown): value is vscode.ConfigurationTarget {
  return value === vscode.ConfigurationTarget.Global
    || value === vscode.ConfigurationTarget.Workspace
    || value === vscode.ConfigurationTarget.WorkspaceFolder;
}

interface NativeToolSearchEnableRollbackOptions {
  virtualToolsConfiguration: vscode.WorkspaceConfiguration;
  nativeToolSearchConfiguration: vscode.WorkspaceConfiguration;
  thresholdTarget: vscode.ConfigurationTarget;
  nativeToolSearchTarget: vscode.ConfigurationTarget;
  previousThreshold: unknown;
  previousNativeToolSearch: unknown;
  thresholdUpdated: boolean;
  nativeToolSearchUpdated: boolean;
}

async function rollbackNativeToolSearchEnable(options: NativeToolSearchEnableRollbackOptions): Promise<unknown> {
  let rollbackError: unknown;
  if (options.nativeToolSearchUpdated) {
    try {
      await options.nativeToolSearchConfiguration.update(
        NATIVE_TOOL_SEARCH_SETTING,
        options.previousNativeToolSearch,
        options.nativeToolSearchTarget
      );
    } catch (error) {
      rollbackError = error;
    }
  }
  if (options.thresholdUpdated) {
    try {
      await options.virtualToolsConfiguration.update(
        THRESHOLD_SETTING,
        options.previousThreshold,
        options.thresholdTarget
      );
    } catch (error) {
      rollbackError ??= error;
    }
  }
  return rollbackError;
}

interface VSCodeToolGroupingRestoreRollbackOptions {
  virtualToolsConfiguration: vscode.WorkspaceConfiguration;
  nativeToolSearchConfiguration: vscode.WorkspaceConfiguration;
  nativeToolSearchTarget: vscode.ConfigurationTarget;
  previousNativeToolSearch: unknown;
  nativeToolSearchUpdated: boolean;
  restoredThresholds: ReadonlyArray<SavedThreshold & { currentValue: unknown }>;
}

async function rollbackVSCodeToolGroupingRestore(options: VSCodeToolGroupingRestoreRollbackOptions): Promise<unknown> {
  let rollbackError: unknown;
  for (const restored of [...options.restoredThresholds].reverse()) {
    try {
      await options.virtualToolsConfiguration.update(THRESHOLD_SETTING, restored.currentValue, restored.target);
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (options.nativeToolSearchUpdated) {
    try {
      await options.nativeToolSearchConfiguration.update(
        NATIVE_TOOL_SEARCH_SETTING,
        options.previousNativeToolSearch,
        options.nativeToolSearchTarget
      );
    } catch (error) {
      rollbackError ??= error;
    }
  }
  return rollbackError;
}

async function resetToolGroups(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(RESET_VIRTUAL_TOOL_GROUPS_COMMAND);
  } catch {
    return false;
  }
  return true;
}

async function isVirtualToolGroupResetCommandAvailable(): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes(RESET_VIRTUAL_TOOL_GROUPS_COMMAND);
  } catch {
    return false;
  }
}
