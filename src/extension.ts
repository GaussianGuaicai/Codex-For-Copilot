import * as vscode from 'vscode';
import { CodexAccountUsageStatusBar } from './accountUsageStatusBar';
import { CodexModelProvider } from './provider';
import { CodexAuthLock } from './auth/codexAuthLock';
import { CodexAuthManager } from './auth/codexAuthManager';
import { CodexAuthenticationProvider, CODEX_AUTHENTICATION_PROVIDER_ID } from './auth/codexAuthenticationProvider';
import { CodexSecretStore } from './auth/codexSecretStore';
import { InvalidAuthJsonError } from './auth/codexAuthTypes';
import { createCodexLogger } from './codexLogger';
import { getProviderConfig } from './config';
import { clearApiKey, setApiKey } from './secrets';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Codex Model Provider', { log: true });
  const logger = createCodexLogger(outputChannel, 'extension');
  logger.info('extension.activated', {
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    architecture: process.arch,
    logLevel: outputChannel.logLevel
  });
  const config = getProviderConfig();
  logger.debug('configuration.loaded', {
    baseURL: config.baseURL,
    credentialsSource: config.credentialsSource,
    transport: config.transport,
    websocketPrewarm: config.websocketPrewarm,
    requestCompression: config.requestCompression,
    model: config.model,
    includeHiddenModels: config.includeHiddenModels,
    defaultServiceTier: config.defaultServiceTier ?? 'auto',
    defaultReasoningEffort: config.defaultReasoningEffort ?? 'auto'
  });
  void vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const authManager = new CodexAuthManager(
    new CodexSecretStore(context.secrets),
    new CodexAuthLock(vscode.Uri.joinPath(context.globalStorageUri, 'codex-auth-refresh.lock')),
    undefined,
    logger.child('auth')
  );
  const authenticationProvider = new CodexAuthenticationProvider(authManager);
  const accountUsageStatusBar = new CodexAccountUsageStatusBar(context, logger.child('account-usage'), authManager);
  const provider = new CodexModelProvider(context, logger.child('provider'), undefined, accountUsageStatusBar, accountUsageStatusBar, authManager);

  context.subscriptions.push(authManager, authManager.onDidChangeAuth((event) => {
    logger.child('auth').info('auth.changed', { reason: event.reason });
    provider.handleAuthenticationChanged();
    void accountUsageStatusBar.refresh();
  }));

  context.subscriptions.push(
    outputChannel,
    authenticationProvider,
    accountUsageStatusBar,
    vscode.authentication.registerAuthenticationProvider(
      CODEX_AUTHENTICATION_PROVIDER_ID,
      'Codex for Copilot',
      authenticationProvider,
      { supportsMultipleAccounts: false }
    ),
    vscode.lm.registerLanguageModelChatProvider('codex-for-copilot', provider),
    vscode.commands.registerCommand('codexModelProvider.openDebugLogs', () => {
      logger.debug('command.open-logs');
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
        logger.child('command').info('api-key.saved');
        vscode.window.showInformationMessage('Responses API key saved.');
      }
    }),
    vscode.commands.registerCommand('codexModelProvider.clearApiKey', async () => {
      await clearApiKey(context);
      logger.child('command').info('api-key.cleared');
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
        logger.child('command').error('auth.import.failed', error);
        const message = error instanceof InvalidAuthJsonError ? error.message : 'Failed to import Codex auth.json.';
        vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.signOut', async () => {
      await authManager.signOut();
      logger.child('command').info('auth.sign-out.completed');
      vscode.window.showInformationMessage('Codex credentials removed.');
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.signInWithChatGPT', async () => {
      try {
        await authManager.signInWithBrowser();
        vscode.window.showInformationMessage('Signed in with ChatGPT.');
      } catch (error) {
        logger.child('command').error('auth.sign-in.failed', error);
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'ChatGPT sign-in failed.');
      }
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.showStatus', async () => {
      const status = await authManager.getStatus();
      if (!status.authenticated) {
        vscode.window.showInformationMessage('Not signed in.');
        return;
      }
      const details = [
        status.email ? `Email: ${status.email}` : undefined,
        status.accountId ? `Account: ${status.accountId}` : undefined,
        status.accessTokenExpiresAt ? `Access token expires: ${new Date(status.accessTokenExpiresAt).toLocaleString()}` : undefined,
        status.lastRefresh ? `Last refresh: ${status.lastRefresh}` : undefined
      ].filter(Boolean).join('\n');
      vscode.window.showInformationMessage(details || 'Signed in with ChatGPT.');
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.signInWithDeviceCode', async () => {
      await authManager.signInWithDeviceCode();
    }),
    vscode.commands.registerCommand('codexModelProvider.refreshAccountLimits', async () => {
      await accountUsageStatusBar.refresh();
      await accountUsageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('codexModelProvider.manage', async () => {
      const action = await vscode.window.showQuickPick(
        ['Sign in with ChatGPT', 'Sign in with Device Code', 'Show Auth Status', 'Sign Out', 'Import Codex auth.json (Legacy)', 'Refresh Account Limits', 'Open Debug Logs', 'Set API Key', 'Clear API Key', 'Open Settings'],
        { title: 'Codex' }
      );

      if (action === 'Sign in with ChatGPT') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signInWithChatGPT');
      } else if (action === 'Import Codex auth.json (Legacy)') {
        await vscode.commands.executeCommand('codexForCopilot.auth.importAuthJson');
      } else if (action === 'Show Auth Status') {
        await vscode.commands.executeCommand('codexForCopilot.auth.showStatus');
      } else if (action === 'Sign Out') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signOut');
      } else if (action === 'Sign in with Device Code') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signInWithDeviceCode');
      } else if (action === 'Refresh Account Limits') {
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
