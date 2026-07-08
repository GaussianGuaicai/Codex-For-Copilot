import * as vscode from 'vscode';
import { CodexAccountUsageStatusBar } from './accountUsageStatusBar';
import { CodexModelProvider } from './provider';
import { clearApiKey, setApiKey } from './secrets';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Codex Model Provider', { log: true });
  const accountUsageStatusBar = new CodexAccountUsageStatusBar(context, outputChannel);
  const provider = new CodexModelProvider(context, outputChannel, undefined, accountUsageStatusBar);

  context.subscriptions.push(
    outputChannel,
    accountUsageStatusBar,
    vscode.lm.registerLanguageModelChatProvider('codex-for-copilot', provider),
    vscode.commands.registerCommand('codexModelProvider.openDebugLogs', () => {
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand('codexModelProvider.openSettings', () => {
      return vscode.commands.executeCommand('workbench.action.openSettings', 'codexModelProvider');
    }),
    vscode.commands.registerCommand('codexModelProvider.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'Set Responses API Key',
        prompt: 'Enter your API key',
        password: true,
        ignoreFocusOut: true
      });

      if (apiKey?.trim()) {
        await setApiKey(context, apiKey.trim());
        vscode.window.showInformationMessage('Responses API key saved.');
      }
    }),
    vscode.commands.registerCommand('codexModelProvider.clearApiKey', async () => {
      await clearApiKey(context);
      vscode.window.showInformationMessage('Responses API key cleared.');
    }),
    vscode.commands.registerCommand('codexModelProvider.refreshAccountLimits', async () => {
      await accountUsageStatusBar.refresh();
      await accountUsageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('codexModelProvider.manage', async () => {
      const action = await vscode.window.showQuickPick(
        ['Refresh Account Limits', 'Open Debug Logs', 'Set API Key', 'Clear API Key', 'Open Settings'],
        { title: 'Codex' }
      );

      if (action === 'Refresh Account Limits') {
        await vscode.commands.executeCommand('codexModelProvider.refreshAccountLimits');
      } else if (action === 'Open Debug Logs') {
        await vscode.commands.executeCommand('codexModelProvider.openDebugLogs');
      } else if (action === 'Set API Key') {
        await vscode.commands.executeCommand('codexModelProvider.setApiKey');
      } else if (action === 'Clear API Key') {
        await vscode.commands.executeCommand('codexModelProvider.clearApiKey');
      } else if (action === 'Open Settings') {
        await vscode.commands.executeCommand('codexModelProvider.openSettings');
      }
    })
  );
}

export function deactivate(): void {}
