import * as vscode from 'vscode';
import { buildCodexAccountUsageDisplay, fetchCodexAccountUsage, type CodexAccountUsageSnapshot } from './accountUsage';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { getProviderConfig } from './config';
import { getApiCredentials } from './secrets';
import { type CodexLogSink, CodexLogger, createCodexLogger } from './codexLogger';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class CodexAccountUsageStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[];
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private lastSnapshot?: CodexAccountUsageSnapshot;
  private refreshInFlight?: Promise<void>;
  private selectedModel = getProviderConfig().model;
  private readonly logger: CodexLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    logger: CodexLogger | CodexLogSink,
    private readonly authManager?: CodexAuthManager
  ) {
    this.logger = logger instanceof CodexLogger ? logger : createCodexLogger(logger, 'account-usage');
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.statusBarItem.name = 'Codex Account Limits';
    this.statusBarItem.command = 'codexModelProvider.refreshAccountLimits';
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
    if (this.lastSnapshot) {
      this.render(this.lastSnapshot);
    }
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
    if (!this.lastSnapshot) {
      await this.refresh();
    }

    if (!this.lastSnapshot) {
      vscode.window.showInformationMessage('No Codex account limits are available for the active credentials.');
      return;
    }

    const display = buildCodexAccountUsageDisplay(this.lastSnapshot, this.selectedModel);
    await vscode.window.showInformationMessage(display.tooltip.replace(/\n/g, ' | '));
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async refreshNow(): Promise<void> {
    const logger = this.logger.operation('account-usage.refresh');
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);

    if (!credentials || credentials.kind !== 'codexAccessToken') {
      this.lastSnapshot = undefined;
      this.statusBarItem.hide();
      logger.debug('refresh.skipped', { reason: 'credentials-unavailable' });
      return;
    }

    try {
      const snapshot = await fetchCodexAccountUsage({
        baseURL: config.baseURL,
        credentials,
        selectedModel: this.selectedModel
      });
      this.lastSnapshot = snapshot;
      this.render(snapshot);
      logger.debug('refresh.completed', {
        selectedModel: this.selectedModel,
        rateLimitCount: snapshot.limits.length,
        creditBudgetCount: snapshot.creditBudgets.length
      });
    } catch (error) {
      logger.warn('refresh.failed', { error });

      if (this.lastSnapshot) {
        this.render(this.lastSnapshot);
      } else {
        this.statusBarItem.hide();
      }
    }
  }

  private render(snapshot: CodexAccountUsageSnapshot): void {
    const display = buildCodexAccountUsageDisplay(snapshot, this.selectedModel);
    if (!display.compactText) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = display.compactText;
    this.statusBarItem.tooltip = display.tooltip;
    this.statusBarItem.show();
  }
}
