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
import {
  enableNativeToolSearchGroupingBridge,
  getNativeToolGroupingBridgeStatus,
  restoreVSCodeToolGrouping
} from './nativeToolSearch/nativeToolGroupingBridge';
import { getNativeToolSearchRuntimeStatus } from './nativeToolSearch/nativeToolSearchStatus';

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
    vscode.commands.registerCommand('codexModelProvider.enableNativeToolSearch', () => enableNativeToolSearchGroupingBridge(context)),
    vscode.commands.registerCommand('codexModelProvider.restoreVSCodeToolGrouping', () => restoreVSCodeToolGrouping(context)),
    vscode.commands.registerCommand('codexModelProvider.showNativeToolSearchStatus', async () => {
      const runtime = getNativeToolSearchRuntimeStatus();
      const bridge = await getNativeToolGroupingBridgeStatus(context);
      const status = {
        setting: getProviderConfig().nativeToolSearch,
        bridge,
        runtime: runtime ?? null
      };
      logger.info('native-tool-search.status', status);
      const runtimeSummary = runtime
        ? `${runtime.mode === 'native-hosted' ? 'Active' : 'Fallback'}: ${formatNativeToolSearchReason(runtime.reason)}; ${runtime.selectedToolCount} selected, ${runtime.deferredToolCount} deferred, ${runtime.deferredToolSchemaBytes} deferred schema bytes.`
        : 'No Agent request has run since this extension activated.';
      const bridgeSummary = bridge.enabledByThisExtension
        ? `VS Code Virtual Tool bridge: enabled (threshold ${formatSettingValue(bridge.effectiveThreshold)}).`
        : `VS Code Virtual Tool bridge: not enabled (reset command ${bridge.resetCommandAvailable ? 'available' : 'unavailable'}).`;
      const action = await vscode.window.showInformationMessage(
        `Native Tool Search setting: ${status.setting}. ${runtimeSummary} ${bridgeSummary}`,
        'Open Debug Logs',
        'Open Settings'
      );
      if (action === 'Open Debug Logs') {
        outputChannel.show(true);
      } else if (action === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codexModelProvider.nativeToolSearch');
      }
    }),
    vscode.commands.registerCommand('codexModelProvider.manage', async () => {
      const action = await vscode.window.showQuickPick(
        ['Sign in with ChatGPT', 'Sign in with Device Code', 'Show Auth Status', 'Sign Out', 'Import Codex auth.json (Legacy)', 'Refresh Account Limits', 'Enable Native Tool Search', 'Restore VS Code Tool Grouping', 'Show Native Tool Search Status', 'Open Debug Logs', 'Set API Key', 'Clear API Key', 'Open Settings'],
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
      } else if (action === 'Enable Native Tool Search') {
        await vscode.commands.executeCommand('codexModelProvider.enableNativeToolSearch');
      } else if (action === 'Restore VS Code Tool Grouping') {
        await vscode.commands.executeCommand('codexModelProvider.restoreVSCodeToolGrouping');
      } else if (action === 'Show Native Tool Search Status') {
        await vscode.commands.executeCommand('codexModelProvider.showNativeToolSearchStatus');
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

function formatNativeToolSearchReason(reason: string): string {
  switch (reason) {
    case 'native-enabled': return 'native hosted Tool Search is active';
    case 'compatibility-disabled': return 'Codex compatibility is unavailable for this endpoint';
    case 'disabled-by-setting': return 'disabled in Settings';
    case 'backend-unsupported': return 'the model or endpoint rejected Tool Search recently';
    case 'backend-rejected': return 'the backend rejected Tool Search and this request retried with legacy tools';
    case 'virtual-tools-active': return 'VS Code supplied Virtual Tool placeholders';
    case 'auto-tool-count-below-threshold': return 'the selected tool count is below the automatic threshold';
    case 'auto-deferred-schema-small': return 'the deferred schemas are too small for automatic Tool Search';
    default: return reason;
  }
}

function formatSettingValue(value: unknown): string {
  return value === undefined ? 'default' : String(value);
}
