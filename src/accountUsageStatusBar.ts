import * as vscode from 'vscode';
import { buildCodexAccountUsageDisplay, fetchCodexAccountUsage, type CodexAccountUsageSnapshot } from './accountUsage';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { getProviderConfig } from './config';
import { getCodexCredentialsForAccount } from './secrets';
import { type CodexLogSink, CodexLogger, createCodexLogger } from './codexLogger';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface AccountUsageEntry {
  accountKey: string;
  label: string;
  isActive: boolean;
  snapshot?: CodexAccountUsageSnapshot;
  error?: boolean;
}

export class CodexAccountUsageStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[];
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private readonly usageByAccount = new Map<string, AccountUsageEntry>();
  private refreshInFlight?: Promise<void>;
  private selectedModel = getProviderConfig().model;
  private readonly logger: CodexLogger;

  constructor(
    logger: CodexLogger | CodexLogSink,
    private readonly authManager?: CodexAuthManager
  ) {
    this.logger = logger instanceof CodexLogger ? logger : createCodexLogger(logger, 'account-usage');
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.statusBarItem.name = 'Codex Account Limits';
    this.statusBarItem.command = 'codexModelProvider.showAccountLimits';
    this.statusBarItem.hide();

    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);

    this.disposables = [
      this.statusBarItem,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codexModelProvider.baseURL') || event.affectsConfiguration('codexModelProvider.credentialsSource') || event.affectsConfiguration('codexModelProvider.model')) {
          if (event.affectsConfiguration('codexModelProvider.model')) {
            this.selectedModel = getProviderConfig().model;
          }
          void this.refresh();
        }
      })
    ];

    void this.refresh();
  }

  setSelectedModel(model: string): void {
    if (!model.trim() || model === this.selectedModel) {
      return;
    }

    this.selectedModel = model;
    this.renderActive();
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshNow().finally(() => {
      this.refreshInFlight = undefined;
    });

    return this.refreshInFlight;
  }

  async showDetails(): Promise<void> {
    if (this.usageByAccount.size === 0) {
      await this.refresh();
    }

    if (this.usageByAccount.size === 0) {
      vscode.window.showInformationMessage('No Codex account limits are available.');
      return;
    }

    interface UsagePick extends vscode.QuickPickItem {
      accountKey?: string;
    }

    const items: UsagePick[] = [...this.usageByAccount.values()].map((entry) => {
      if (entry.error || !entry.snapshot) {
        return {
          label: `${entry.isActive ? '$(check) ' : ''}${entry.label}`,
          description: entry.isActive ? 'active' : '',
          detail: 'Usage unavailable (failed to load)',
          accountKey: entry.accountKey
        };
      }
      const display = buildCodexAccountUsageDisplay(entry.snapshot, this.selectedModel);
      return {
        label: `${entry.isActive ? '$(check) ' : ''}${entry.label}`,
        description: [entry.isActive ? 'active' : '', display.compactText ?? ''].filter(Boolean).join('  '),
        detail: display.tooltip.replace(/\n/g, '  •  '),
        accountKey: entry.accountKey
      };
    });

    const actions: vscode.QuickPickItem = { label: '$(sync) Refresh all', };
    const picked = await vscode.window.showQuickPick(
      [...items, { label: '', kind: vscode.QuickPickItemKind.Separator }, actions],
      {
        title: 'Codex Account Limits',
        placeHolder: 'Select an account to set it active, or refresh all.'
      }
    );

    if (!picked) {
      return;
    }

    if (picked === actions) {
      await this.refresh();
      return;
    }

    const selected = (picked as UsagePick).accountKey;
    if (selected && this.authManager) {
      const entry = this.usageByAccount.get(selected);
      if (entry && !entry.isActive) {
        await this.authManager.switchAccount(selected);
        vscode.window.showInformationMessage(`Active Codex account switched to ${entry.label}.`);
        // Switching fires onDidChangeAuth which triggers a refresh; render immediately too.
        this.renderActive();
      }
    }
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async refreshNow(): Promise<void> {
    const logger = this.logger.operation('account-usage.refresh');
    const config = getProviderConfig();

    if (!this.authManager) {
      this.usageByAccount.clear();
      this.statusBarItem.hide();
      logger.debug('refresh.skipped', { reason: 'no-auth-manager' });
      return;
    }

    const accounts = await this.authManager.listAccounts();
    if (accounts.length === 0) {
      this.usageByAccount.clear();
      this.statusBarItem.hide();
      logger.debug('refresh.skipped', { reason: 'no-accounts' });
      return;
    }

    // Fetch each account's usage in parallel; keep prior snapshots for accounts that fail.
    const results = await Promise.all(accounts.map(async (account) => {
      const label = account.email ?? account.accountId ?? account.accountKey;
      const credentials = await getCodexCredentialsForAccount(this.authManager!, account.accountKey);
      if (!credentials) {
        return { accountKey: account.accountKey, label, isActive: account.isActive, error: true } as AccountUsageEntry;
      }
      try {
        const snapshot = await fetchCodexAccountUsage({
          baseURL: config.baseURL,
          credentials,
          selectedModel: this.selectedModel
        });
        return { accountKey: account.accountKey, label, isActive: account.isActive, snapshot } as AccountUsageEntry;
      } catch (error) {
        logger.warn('refresh.account-failed', { accountKey: account.accountKey, error });
        const prior = this.usageByAccount.get(account.accountKey);
        return { accountKey: account.accountKey, label, isActive: account.isActive, snapshot: prior?.snapshot, error: !prior?.snapshot } as AccountUsageEntry;
      }
    }));

    this.usageByAccount.clear();
    for (const entry of results) {
      this.usageByAccount.set(entry.accountKey, entry);
    }

    this.renderActive();
    logger.debug('refresh.completed', { accountCount: results.length, selectedModel: this.selectedModel });
  }

  private renderActive(): void {
    const active = [...this.usageByAccount.values()].find((entry) => entry.isActive)
      ?? this.usageByAccount.values().next().value;

    if (!active || !active.snapshot) {
      this.statusBarItem.hide();
      return;
    }

    const display = buildCodexAccountUsageDisplay(active.snapshot, this.selectedModel);
    if (!display.compactText) {
      this.statusBarItem.hide();
      return;
    }

    const accountCount = this.usageByAccount.size;
    const prefix = accountCount > 1 ? `$(organization) ${active.label} ` : '';
    this.statusBarItem.text = `${prefix}${display.compactText}`;
    this.statusBarItem.tooltip = accountCount > 1
      ? `${display.tooltip}\n\n${accountCount} accounts — click to view all.`
      : display.tooltip;
    this.statusBarItem.show();
  }
}
