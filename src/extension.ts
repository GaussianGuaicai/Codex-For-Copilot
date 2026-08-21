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
  migrateNativeToolSearchOptIn,
  restoreVSCodeToolGrouping
} from './nativeToolSearch/nativeToolGroupingBridge';
import { getNativeToolSearchRuntimeStatus } from './nativeToolSearch/nativeToolSearchStatus';
import { getLastEffectiveCodexProtocol } from './codexProtocol';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Codex Model Provider', { log: true });
  const logger = createCodexLogger(outputChannel, 'extension');
  logger.info('extension.activated', {
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    architecture: process.arch,
    logLevel: outputChannel.logLevel
  });
  try {
    if (await migrateNativeToolSearchOptIn(context)) {
      logger.info('native-tool-search.opt-in-migrated', { policy: 'auto' });
    }
  } catch (error) {
    logger.warn('native-tool-search.opt-in-migration-failed', { error });
    void vscode.window.showWarningMessage(
      'Native Tool Search was previously enabled, but its opt-in setting could not be migrated. Run Codex: Enable Native Tool Search to try again.'
    );
  }
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
    (accountKey) => new CodexAuthLock(vscode.Uri.joinPath(context.globalStorageUri, `codex-auth-refresh.${sanitizeLockKey(accountKey)}.lock`)),
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
      { supportsMultipleAccounts: true }
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
      try {
        const accountKey = await importCodexAuthJsonInteractive(authManager);
        if (!accountKey) {
          return;
        }
        const status = await authManager.getStatus(accountKey);
        const suffix = status.email ? ` for ${status.email}` : '';
        vscode.window.showInformationMessage(`Codex credentials imported${suffix}.`);
      } catch (error) {
        logger.child('command').error('auth.import.failed', error);
        const message = error instanceof InvalidAuthJsonError ? error.message : 'Failed to import Codex auth.json.';
        vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.signOut', async () => {
      const accounts = await authManager.listAccounts();
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('No Codex accounts are signed in.');
        return;
      }
      await authManager.signOutAll();
      logger.child('command').info('auth.sign-out.completed', { count: accounts.length });
      vscode.window.showInformationMessage(accounts.length > 1 ? `Signed out of all ${accounts.length} Codex accounts.` : 'Codex credentials removed.');
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
    vscode.commands.registerCommand('codexModelProvider.showAccountLimits', async () => {
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
      const runtimeSummary = status.setting === 'disabled'
        ? 'Native Tool Search is disabled.'
        : runtime
        ? `${runtime.mode === 'native-hosted' ? 'Active' : 'Fallback'}: ${formatNativeToolSearchReason(runtime.reason)}; ${runtime.selectedToolCount} selected, ${runtime.deferredToolCount} deferred, ${runtime.deferredToolSchemaBytes} deferred schema bytes.`
        : 'No Agent request has run since this extension activated.';
      const discoverySummary = status.setting === 'disabled'
        ? 'Tool discovery: VS Code Virtual Tool Groups (default).'
        : bridge.enabledByThisExtension
          ? `Tool discovery: Codex Native Tool Search; VS Code Virtual Tool Groups are temporarily disabled (threshold ${formatSettingValue(bridge.effectiveThreshold)}).`
          : `Native Tool Search policy: ${status.setting}; VS Code Virtual Tool Groups were not disabled by this extension.`;
      const action = await vscode.window.showInformationMessage(
        `${discoverySummary} ${runtimeSummary}`,
        'Open Debug Logs',
        'Open Settings'
      );
      if (action === 'Open Debug Logs') {
        outputChannel.show(true);
      } else if (action === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codexModelProvider.nativeToolSearch');
      }
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.switchAccount', async () => {
      const picked = await pickAccount(authManager, 'Switch Codex Account', 'Choose which account new chat requests use.');
      if (!picked) return;
      await authManager.switchAccount(picked.accountKey);
      logger.child('command').info('auth.switched', { accountKey: picked.accountKey });
      vscode.window.showInformationMessage(`Active Codex account switched to ${picked.email ?? picked.accountId ?? picked.accountKey}.`);
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.removeAccount', async () => {
      const picked = await pickAccount(authManager, 'Remove Codex Account', 'Choose an account to remove (its credentials will be deleted).');
      if (!picked) return;
      const label = picked.email ?? picked.accountId ?? picked.accountKey;
      const confirm = await vscode.window.showWarningMessage(`Remove Codex account ${label}?`, { modal: true }, 'Remove');
      if (confirm !== 'Remove') return;
      await authManager.signOut(picked.accountKey);
      logger.child('command').info('auth.removed', { accountKey: picked.accountKey });
      vscode.window.showInformationMessage(`Codex account ${label} removed.`);
    }),
    vscode.commands.registerCommand('codexForCopilot.auth.addAccount', async () => {
      const method = await vscode.window.showQuickPick(
        [
          { label: 'Sign in with ChatGPT', description: 'Open the ChatGPT website in your browser', id: 'browser' as const },
          { label: 'Sign in with Device Code', description: 'Authorize with a one-time device code', id: 'device' as const },
          { label: 'Import Codex auth.json', description: 'Load credentials from an exported auth.json file', id: 'import' as const }
        ],
        { title: 'Add Codex Account', placeHolder: 'Choose how to sign in to the new account' }
      );
      if (!method) {
        return;
      }
      try {
        let accountKey: string | undefined;
        if (method.id === 'browser') {
          accountKey = await authManager.signInWithBrowser();
        } else if (method.id === 'device') {
          accountKey = await authManager.signInWithDeviceCode();
        } else {
          accountKey = await importCodexAuthJsonInteractive(authManager);
          if (!accountKey) {
            return;
          }
        }
        await authManager.switchAccount(accountKey);
        const status = await authManager.getStatus(accountKey);
        vscode.window.showInformationMessage(`Added Codex account${status.email ? ` ${status.email}` : ''} and set it active.`);
      } catch (error) {
        logger.child('command').error('auth.add-account.failed', error);
        const message = error instanceof InvalidAuthJsonError ? error.message : (error instanceof Error ? error.message : 'Adding a Codex account failed.');
        vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('codexModelProvider.showEffectiveProtocol', () => {
      const diagnostic = getLastEffectiveCodexProtocol();
      if (!diagnostic) {
        void vscode.window.showInformationMessage('No Codex-compatible request has run since this extension activated.');
        return;
      }
      logger.info('protocol.effective', { ...diagnostic });
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand('codexModelProvider.manage', async () => {
      const action = await vscode.window.showQuickPick(
        ['Sign in with ChatGPT', 'Add Codex Account', 'Switch Codex Account', 'Remove Codex Account', 'Sign in with Device Code', 'Show Auth Status', 'Sign Out (All Accounts)', 'Import Codex auth.json', 'Refresh Account Limits', 'Enable Native Tool Search', 'Use VS Code Virtual Tool Groups', 'Show Native Tool Search Status', 'Show Effective Protocol', 'Open Debug Logs', 'Set API Key', 'Clear API Key', 'Open Settings'],
        { title: 'Codex' }
      );

      if (action === 'Sign in with ChatGPT') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signInWithChatGPT');
      } else if (action === 'Add Codex Account') {
        await vscode.commands.executeCommand('codexForCopilot.auth.addAccount');
      } else if (action === 'Switch Codex Account') {
        await vscode.commands.executeCommand('codexForCopilot.auth.switchAccount');
      } else if (action === 'Remove Codex Account') {
        await vscode.commands.executeCommand('codexForCopilot.auth.removeAccount');
      } else if (action === 'Import Codex auth.json') {
        await vscode.commands.executeCommand('codexForCopilot.auth.importAuthJson');
      } else if (action === 'Show Auth Status') {
        await vscode.commands.executeCommand('codexForCopilot.auth.showStatus');
      } else if (action === 'Sign Out (All Accounts)') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signOut');
      } else if (action === 'Sign in with Device Code') {
        await vscode.commands.executeCommand('codexForCopilot.auth.signInWithDeviceCode');
      } else if (action === 'Refresh Account Limits') {
        await vscode.commands.executeCommand('codexModelProvider.refreshAccountLimits');
      } else if (action === 'Enable Native Tool Search') {
        await vscode.commands.executeCommand('codexModelProvider.enableNativeToolSearch');
      } else if (action === 'Use VS Code Virtual Tool Groups') {
        await vscode.commands.executeCommand('codexModelProvider.restoreVSCodeToolGrouping');
      } else if (action === 'Show Native Tool Search Status') {
        await vscode.commands.executeCommand('codexModelProvider.showNativeToolSearchStatus');
      } else if (action === 'Show Effective Protocol') {
        await vscode.commands.executeCommand('codexModelProvider.showEffectiveProtocol');
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

function sanitizeLockKey(accountKey: string): string {
  return accountKey.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Prompt for an auth.json file and import it, returning the new account key (or undefined if cancelled). */
async function importCodexAuthJsonInteractive(authManager: CodexAuthManager): Promise<string | undefined> {
  const selected = await vscode.window.showOpenDialog({
    title: 'Import Codex auth.json',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ['json'] }
  });
  const uri = selected?.[0];
  if (!uri) {
    return undefined;
  }
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  return authManager.importAuthJson(raw);
}

async function pickAccount(
  authManager: CodexAuthManager,
  title: string,
  placeHolder: string
): Promise<{ accountKey: string; email?: string; accountId?: string; isActive: boolean } | undefined> {
  const accounts = await authManager.listAccounts();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage('No Codex accounts are configured. Use "Add Codex Account" to sign in.');
    return undefined;
  }
  const items = accounts.map((account) => ({
    label: `${account.isActive ? '$(check) ' : ''}${account.email ?? account.accountId ?? account.accountKey}`,
    description: account.isActive ? 'active' : (account.accountId ?? ''),
    detail: account.reauthRequired ? 'Re-authentication required' : undefined,
    account
  }));
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, matchOnDescription: true });
  return picked?.account;
}
