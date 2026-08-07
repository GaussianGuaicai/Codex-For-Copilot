import * as vscode from 'vscode';

const VIRTUAL_TOOLS_CONFIGURATION_SECTION = 'github.copilot.chat.virtualTools';
const THRESHOLD_SETTING = 'threshold';
export const NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';

interface SavedThreshold { value: unknown; target: vscode.ConfigurationTarget }

export async function enableNativeToolSearchGroupingBridge(context: vscode.ExtensionContext): Promise<void> {
  const accepted = await vscode.window.showWarningMessage(
    'Enable Native Tool Search? This temporarily disables VS Code virtual tool grouping. It takes effect on the next Agent request.',
    { modal: true }, 'Enable'
  );
  if (accepted !== 'Enable') {
    return;
  }
  const configuration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
  const target = getEffectiveSettingTarget(inspected);
  const savedThresholds = getSavedThresholds(context);
  if (!savedThresholds.some((saved) => saved.target === target)) {
    savedThresholds.push({ value: getSettingValueAtTarget(inspected, target), target });
  }
  try {
    await configuration.update(THRESHOLD_SETTING, 0, target);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : '';
    void vscode.window.showErrorMessage(`Native Tool Search could not update github.copilot.chat.virtualTools.threshold.${reason}`);
    return;
  }
  await context.globalState.update(PREVIOUS_KEY, savedThresholds);
  await context.globalState.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, true);
  await resetToolGroups('Native Tool Search enabled. It will be used on the next Agent request.');
}

export async function restoreVSCodeToolGrouping(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY) !== true) {
    return;
  }
  const configuration = vscode.workspace.getConfiguration(VIRTUAL_TOOLS_CONFIGURATION_SECTION);
  for (const previous of getSavedThresholds(context)) {
    const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
    if (getSettingValueAtTarget(inspected, previous.target) === 0) {
      await configuration.update(THRESHOLD_SETTING, previous.value, previous.target);
    }
  }
  await context.globalState.update(NATIVE_TOOL_SEARCH_GROUPING_BRIDGE_OWNER_KEY, undefined);
  await context.globalState.update(PREVIOUS_KEY, undefined);
  await resetToolGroups('VS Code tool grouping restored. It will apply on the next Agent request.');
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

function getSavedThresholds(context: vscode.ExtensionContext): SavedThreshold[] {
  const saved = context.globalState.get<SavedThreshold | SavedThreshold[]>(PREVIOUS_KEY);
  const entries = Array.isArray(saved) ? saved : saved ? [saved] : [];
  return entries.flatMap((entry) => {
    const target = isConfigurationTarget(entry.target) ? entry.target : vscode.ConfigurationTarget.Global;
    return [{ value: entry.value, target }];
  });
}

function isConfigurationTarget(value: unknown): value is vscode.ConfigurationTarget {
  return value === vscode.ConfigurationTarget.Global
    || value === vscode.ConfigurationTarget.Workspace
    || value === vscode.ConfigurationTarget.WorkspaceFolder;
}

async function resetToolGroups(successMessage: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('github.copilot.debug.resetVirtualToolGroups');
  } catch {
    void vscode.window.showWarningMessage(`${successMessage} Copilot tool groups could not be reset. Reload Window before starting a new Agent request.`);
    return;
  }
  void vscode.window.showInformationMessage(successMessage);
}
