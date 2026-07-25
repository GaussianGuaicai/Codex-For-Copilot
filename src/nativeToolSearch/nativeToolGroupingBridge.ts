import * as vscode from 'vscode';

const VIRTUAL_TOOLS_CONFIGURATION_SECTION = 'github.copilot.chat.virtualTools';
const THRESHOLD_SETTING = 'threshold';
const RELOAD_WINDOW_COMMAND = 'workbench.action.reloadWindow';
const OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';

interface SavedThreshold { value: unknown; target: vscode.ConfigurationTarget }

export async function enableNativeToolSearchGroupingBridge(context: vscode.ExtensionContext): Promise<void> {
  const accepted = await vscode.window.showWarningMessage(
    'Enable Native Tool Search? This temporarily disables VS Code virtual tool grouping and reloads the window. The active Agent session will be reset.',
    { modal: true }, 'Enable and Reload'
  );
  if (accepted !== 'Enable and Reload') {
    return;
  }
  const configuration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
  const target = getEffectiveSettingTarget(inspected);
  const state = getStateForTarget(context, target);
  const savedThresholds = getSavedThresholds(state, target === vscode.ConfigurationTarget.Global);
  if (!savedThresholds.some((saved) => saved.target === target)) {
    savedThresholds.push({ value: getSettingValueAtTarget(inspected, target), target });
  }
  await configuration.update(THRESHOLD_SETTING, 0, target);
  if (configuration.get<number>(THRESHOLD_SETTING) !== 0) {
    void vscode.window.showErrorMessage('Native Tool Search could not disable VS Code virtual tool grouping. Check that github.copilot.chat.virtualTools.threshold can be changed in Settings.');
    return;
  }
  await state.update(PREVIOUS_KEY, savedThresholds);
  await state.update(OWNER_KEY, true);
  await resetToolGroupsAndReload('Native Tool Search enabled.');
}

export async function restoreVSCodeToolGrouping(context: vscode.ExtensionContext): Promise<void> {
  const ownedStates = [
    { state: context.globalState, global: true },
    { state: context.workspaceState, global: false }
  ].filter(({ state }) => state.get<boolean>(OWNER_KEY) === true);
  if (ownedStates.length === 0) {
    return;
  }
  const configuration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  for (const owned of ownedStates) {
    for (const previous of getSavedThresholds(owned.state, owned.global)) {
      const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
      if (getSettingValueAtTarget(inspected, previous.target) === 0) {
        await configuration.update(THRESHOLD_SETTING, previous.value, previous.target);
      }
    }
    await owned.state.update(OWNER_KEY, undefined);
    await owned.state.update(PREVIOUS_KEY, undefined);
  }
  await resetToolGroupsAndReload('VS Code tool grouping restored.');
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

function getStateForTarget(context: vscode.ExtensionContext, target: vscode.ConfigurationTarget): vscode.Memento {
  return target === vscode.ConfigurationTarget.Global ? context.globalState : context.workspaceState;
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

async function resetToolGroupsAndReload(successMessage: string): Promise<void> {
  let resetToolGroups = true;
  try {
    await vscode.commands.executeCommand('github.copilot.debug.resetVirtualToolGroups');
  } catch {
    resetToolGroups = false;
  }
  try {
    await vscode.commands.executeCommand(RELOAD_WINDOW_COMMAND);
  } catch {
    const resetStatus = resetToolGroups ? '' : ' Copilot tool groups could not be reset.';
    void vscode.window.showWarningMessage(`${successMessage}${resetStatus} Reload Window before starting a new Agent request.`);
  }
}
