import * as vscode from 'vscode';
import { CodexAccountUsageStatusBar } from './accountUsageStatusBar';
import { CodexModelProvider } from './provider';
import { CodexAuthLock } from './auth/codexAuthLock';
import { CodexAuthManager } from './auth/codexAuthManager';
import { CodexSecretStore } from './auth/codexSecretStore';
import { InvalidAuthJsonError } from './auth/codexAuthTypes';
import { clearApiKey, setApiKey } from './secrets';
import { enableNativeToolSearchGroupingBridge, restoreVSCodeToolGrouping } from './nativeToolSearch/nativeToolGroupingBridge';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Codex Model Provider', { log: true });
  void vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const authManager = new CodexAuthManager(
    new CodexSecretStore(context.secrets),
    new CodexAuthLock(vscode.Uri.joinPath(context.globalStorageUri, 'codex-auth-refresh.lock'))
  );
  const accountUsageStatusBar = new CodexAccountUsageStatusBar(context, outputChannel, authManager);
  const provider = new CodexModelProvider(context, outputChannel, undefined, accountUsageStatusBar, accountUsageStatusBar, authManager);

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
    vscode.commands.registerCommand('codexForCopilot.auth.importAuthJson', async () => {
      const selected = await vscode.window.showOpenDialog({
        title: 'Import Codex auth.json',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] }
      });
      const uri = selected?.[0];
      if (!uri) {
        return;
      }
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        await authManager.importAuthJson(raw);
        const status = await authManager.getStatus();
        const suffix = status.email ? ` for ${status.email}` : '';
        vscode.window.showInformationMessage(`Codex credentials imported${suffix}.`);
      } catch (error) {
        const message = error instanceof InvalidAuthJsonError ? error.message : 'Failed to import Codex auth.json.';
        vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.signOut', async () => {
      await authManager.signOut();
      vscode.window.showInformationMessage('Codex credentials removed.');
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.showStatus', async () => {
      const status = await authManager.getStatus();
      if (!status.authenticated) {
        vscode.window.showInformationMessage('Codex credentials are not imported.');
        return;
      }
      const details = [
        status.email ? `Email: ${status.email}` : undefined,
        status.accountId ? `Account: ${status.accountId}` : undefined,
        status.accessTokenExpiresAt ? `Access token expires: ${new Date(status.accessTokenExpiresAt).toLocaleString()}` : undefined,
        status.lastRefresh ? `Last refresh: ${status.lastRefresh}` : undefined
      ].filter(Boolean).join('\n');
      vscode.window.showInformationMessage(details || 'Codex credentials are imported.');
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.signInWithDeviceCode', async () => {
      await authManager.signInWithDeviceCode();
    }),
    vscode.commands.registerCommand('codexModelProvider.refreshAccountLimits', async () => {
      await accountUsageStatusBar.refresh();
      await accountUsageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('codexModelProvider.enableNativeToolSearch', () => enableNativeToolSearchGroupingBridge(context)),
    vscode.commands.registerCommand('codexModelProvider.restoreVSCodeToolGrouping', () => restoreVSCodeToolGrouping(context)),
    vscode.commands.registerCommand('codexModelProvider.manage', async () => {
      const action = await vscode.window.showQuickPick(
        ['Import Codex auth.json', 'Show Auth Status', 'Sign Out', 'Sign in with Device Code', 'Refresh Account Limits', 'Enable Native Tool Search', 'Restore VS Code Tool Grouping', 'Open Debug Logs', 'Set API Key', 'Clear API Key', 'Open Settings'],
        { title: 'Codex' }
      );

      if (action === 'Import Codex auth.json') {
        await vscode.commands.executeCommand('codexForCopilot.auth.importAuthJson');
      } else if (action === 'Show Auth Status') {
        await vscode.commands.executeCommand('codexForCopilot.auth.showStatus');
      } else if (action === 'Sign Out') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signOut');
      } else if (action === 'Sign in with Device Code') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signInWithDeviceCode');
      } else if (action === 'Refresh Account Limits') {
        await vscode.commands.executeCommand('codexModelProvider.refreshAccountLimits');
      } else if (action === 'Enable Native Tool Search') {
        await vscode.commands.executeCommand('codexModelProvider.enableNativeToolSearch');
      } else if (action === 'Restore VS Code Tool Grouping') {
        await vscode.commands.executeCommand('codexModelProvider.restoreVSCodeToolGrouping');
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
