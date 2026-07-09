import * as vscode from 'vscode';
import { parseCodexAuthJson } from './codexAuthJsonImporter';
import { CodexAuthLock } from './codexAuthLock';
import { getJwtExpiration, isJwtExpiringSoon, decodeJwtPayload } from './codexJwt';
import { CodexSecretStore } from './codexSecretStore';
import { ACCESS_TOKEN_REFRESH_WINDOW_MS, PERIODIC_REFRESH_INTERVAL_MS, refreshCodexTokens } from './codexTokenRefresh';
import { AuthRequiredError, CodexAuthBundle, CodexAuthStatus, ReauthRequiredError, TokenRefreshError } from './codexAuthTypes';

export class CodexAuthManager {
  constructor(
    private readonly store: CodexSecretStore,
    private readonly lock: CodexAuthLock
  ) {}

  async getStatus(): Promise<CodexAuthStatus> {
    const bundle = await this.store.getAuthBundle();
    if (!bundle) {
      return { authenticated: false };
    }

    const idPayload = safeDecode(bundle.tokens.id_token);
    return {
      authenticated: true,
      email: typeof idPayload.email === 'string' ? idPayload.email : undefined,
      accountId: bundle.tokens.account_id,
      accessTokenExpiresAt: getJwtExpiration(bundle.tokens.access_token),
      lastRefresh: bundle.last_refresh
    };
  }

  async importAuthJson(rawJson: string): Promise<void> {
    await this.store.setAuthBundle(parseCodexAuthJson(rawJson));
  }

  async getAccessToken(): Promise<string> {
    const existing = await this.store.getAuthBundle();
    if (!existing) {
      throw new AuthRequiredError();
    }

    await this.refreshIfNeeded('proactive');
    const latest = await this.store.getAuthBundle();
    if (!latest) {
      throw new AuthRequiredError();
    }

    return latest.tokens.access_token;
  }

  async refreshIfNeeded(reason: 'proactive' | 'unauthorized' = 'proactive'): Promise<void> {
    const bundle = await this.store.getAuthBundle();
    if (!bundle) {
      throw new AuthRequiredError();
    }

    if (reason !== 'unauthorized' && !needsRefresh(bundle)) {
      return;
    }

    await this.lock.withLock(async () => {
      const latest = await this.store.getAuthBundle();
      if (!latest) {
        throw new AuthRequiredError();
      }
      if (reason !== 'unauthorized' && !needsRefresh(latest)) {
        return;
      }
      await this.refreshBundle(latest);
    });
  }

  async refreshAfter401(): Promise<void> {
    try {
      await this.refreshIfNeeded('unauthorized');
    } catch (error) {
      if (error instanceof TokenRefreshError && error.permanent) {
        void vscode.window.showErrorMessage('Codex credentials expired or were revoked. Please import auth.json again.', 'Import auth.json', 'Sign out').then((action) => {
          if (action === 'Import auth.json') {
            void vscode.commands.executeCommand('codexForCopilot.auth.importAuthJson');
          } else if (action === 'Sign out') {
            void vscode.commands.executeCommand('codexForCopilot.auth.signOut');
          }
        });
        throw new ReauthRequiredError();
      }
      throw error;
    }
  }

  async signOut(): Promise<void> {
    await this.store.deleteAuthBundle();
  }

  async signInWithDeviceCode(): Promise<void> {
    await vscode.window.showInformationMessage('Device Code login is planned but not implemented yet. Please import Codex auth.json for now.');
  }

  private async refreshBundle(bundle: CodexAuthBundle): Promise<void> {
    const refreshed = await refreshCodexTokens(bundle.tokens.refresh_token);
    await this.store.setAuthBundle({
      ...bundle,
      tokens: {
        ...bundle.tokens,
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
        ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {})
      },
      last_refresh: new Date().toISOString()
    });
  }
}

export function needsRefresh(bundle: CodexAuthBundle): boolean {
  if (isJwtExpiringSoon(bundle.tokens.access_token, ACCESS_TOKEN_REFRESH_WINDOW_MS)) {
    return true;
  }

  if (!bundle.last_refresh) {
    return true;
  }

  const lastRefresh = Date.parse(bundle.last_refresh);
  return !Number.isFinite(lastRefresh) || Date.now() - lastRefresh >= PERIODIC_REFRESH_INTERVAL_MS;
}

function safeDecode(token: string): Record<string, unknown> {
  try {
    const payload = decodeJwtPayload(token);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
