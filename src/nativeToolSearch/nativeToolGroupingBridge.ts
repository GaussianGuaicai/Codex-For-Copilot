import * as vscode from 'vscode';

const THRESHOLD_SETTING = 'github.copilot.chat.virtualTools.threshold';
const OWNER_KEY = 'nativeToolSearch.virtualToolsThresholdOwner';
const PREVIOUS_KEY = 'nativeToolSearch.virtualToolsThresholdPrevious';

interface SavedThreshold { value: unknown; target: vscode.ConfigurationTarget | undefined }

export async function enableNativeToolSearchGroupingBridge(context: vscode.ExtensionContext): Promise<void> {
  const accepted = await vscode.window.showWarningMessage(
    'Enable Native Tool Search? This temporarily sets VS Code virtual tool grouping to 0 so the Codex provider receives only the tools you selected. Reload Chat or start a new session afterwards.',
    { modal: true }, 'Enable'
  );
  if (accepted !== 'Enable') {
    return;
  }
  const configuration = vscode.workspace.getConfiguration();
  const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
  const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
      : inspected?.globalValue !== undefined ? vscode.ConfigurationTarget.Global : undefined;
  const previous: SavedThreshold = {
    value: target === vscode.ConfigurationTarget.WorkspaceFolder ? inspected?.workspaceFolderValue
      : target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue,
    target
  };
  await context.globalState.update(PREVIOUS_KEY, previous);
  await context.globalState.update(OWNER_KEY, true);
  await configuration.update(THRESHOLD_SETTING, 0, target);
  void vscode.window.showInformationMessage('Native Tool Search enabled. Reload Chat or start a new session to apply it.');
}

export async function restoreVSCodeToolGrouping(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(OWNER_KEY) !== true) {
    return;
  }
  const configuration = vscode.workspace.getConfiguration();
  const inspected = configuration.inspect<number>(THRESHOLD_SETTING);
  const current = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (current === 0) {
    const previous = context.globalState.get<SavedThreshold>(PREVIOUS_KEY);
    await configuration.update(THRESHOLD_SETTING, previous?.value, previous?.target);
  }
  await context.globalState.update(OWNER_KEY, undefined);
  await context.globalState.update(PREVIOUS_KEY, undefined);
}
