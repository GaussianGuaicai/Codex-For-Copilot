import * as vscode from 'vscode';
import { parseCodexAuthJson } from './codexAuthJsonImporter';
import { CodexAuthLock } from './codexAuthLock';
import { getJwtExpiration, isJwtExpiringSoon, decodeJwtPayload } from './codexJwt';
import { CodexSecretStore, randomRevision } from './codexSecretStore';
import { ACCESS_TOKEN_REFRESH_WINDOW_MS, PERIODIC_REFRESH_INTERVAL_MS } from './codexTokenRefresh';
import { CodexOAuthClient, type OAuthTokens } from './codexOAuthClient';
import { signInWithLoopback } from './codexLoopbackLogin';
import { signInWithDeviceCode } from './codexDeviceCodeLogin';
import { AuthRequiredError, type CodexAuthChangeEvent, type CodexAuthStatus, type CodexCredentialRecord, type CodexCredentialSnapshot, type CodexCredentialSource, type ExtensionOAuthCredentialRecord, type RefreshableCodexCredentialRecord, ReauthRequiredError, TokenRefreshError } from './codexAuthTypes';
import type { CodexLogger } from '../codexLogger';

export interface CodexAccountSummary {
  accountKey: string;
  source: CodexCredentialSource;
  email?: string;
  accountId?: string;
  isActive: boolean;
  accessTokenExpiresAt?: number;
  reauthRequired: boolean;
}

export class CodexAuthManager implements vscode.Disposable {
  private readonly refreshPromises = new Map<string, Promise<CodexCredentialSnapshot>>();
  private readonly permanentFailureRevisions = new Map<string, string>();
  private readonly changes = new vscode.EventEmitter<CodexAuthChangeEvent>();
  readonly onDidChangeAuth = this.changes.event;
  constructor(
    private readonly store: CodexSecretStore,
    private readonly lockFor: (accountKey: string) => CodexAuthLock,
    private readonly oauth = new CodexOAuthClient(),
    private readonly logger?: CodexLogger
  ) {}
  dispose(): void { this.changes.dispose(); }

  async getActiveAccountKey(): Promise<string | undefined> { return this.store.getActiveAccountKey(); }

  async listAccounts(): Promise<CodexAccountSummary[]> {
    const keys = await this.store.listAccountKeys();
    const active = await this.store.getActiveAccountKey();
    const accounts: CodexAccountSummary[] = [];
    for (const accountKey of keys) {
      const record = await this.store.getCredential(accountKey);
      if (!record) continue;
      const snapshot = snapshotFor(record);
      accounts.push({
        accountKey,
        source: record.source,
        email: record.email,
        accountId: snapshot.accountId,
        isActive: accountKey === active,
        accessTokenExpiresAt: snapshot.expiresAt,
        reauthRequired: this.permanentFailureRevisions.get(accountKey) === snapshot.revision
      });
    }
    return accounts;
  }

  async getStatus(accountKey?: string): Promise<CodexAuthStatus> {
    const key = accountKey ?? await this.store.getActiveAccountKey();
    if (!key) return { authenticated: false };
    const record = await this.store.getCredential(key);
    if (!record) return { authenticated: false };
    const snapshot = snapshotFor(record);
    return { authenticated: true, accountKey: key, source: record.source, email: record.email, accountId: snapshot.accountId, accessTokenExpiresAt: snapshot.expiresAt, lastRefresh: isRefreshableCredential(record) ? record.lastRefreshAt : record.loadedAt, reauthRequired: this.permanentFailureRevisions.get(key) === snapshot.revision };
  }

  async getCredentialSnapshot(accountKey?: string): Promise<CodexCredentialSnapshot> {
    const key = accountKey ?? await this.store.getActiveAccountKey();
    if (!key) throw new AuthRequiredError();
    const record = await this.store.getCredential(key);
    if (!record) throw new AuthRequiredError();
    if (isRefreshableCredential(record)) await this.refreshIfNeeded('proactive', key);
    const latest = await this.store.getCredential(key);
    if (!latest) throw new AuthRequiredError();
    return snapshotFor(latest, key);
  }

  async getAccessToken(accountKey?: string): Promise<string> { return (await this.getCredentialSnapshot(accountKey)).accessToken; }

  async switchAccount(accountKey: string): Promise<void> {
    const previous = await this.store.getActiveAccountKey();
    await this.store.setActiveAccountKey(accountKey);
    if (previous !== accountKey) this.changes.fire({ reason: 'activeAccountChanged', accountKey });
  }

  async importAuthJson(rawJson: string): Promise<string> {
    const bundle = parseCodexAuthJson(rawJson);
    const payload = safeDecode(bundle.tokens.id_token);
    const record: RefreshableCodexCredentialRecord = { schemaVersion: 2, source: 'importedAuthJson', revision: randomRevision(), tokens: bundle.tokens, email: stringValue(payload.email), accessTokenExpiresAt: getJwtExpiration(bundle.tokens.access_token), lastRefreshAt: bundle.last_refresh ?? new Date().toISOString() };
    const accountKey = await this.store.setCredential(record);
    this.permanentFailureRevisions.delete(accountKey);
    this.fire('signedIn', accountKey, record.revision);
    return accountKey;
  }

  async signInWithBrowser(): Promise<string> {
    const logger = this.logger?.operation('auth.browser-sign-in');
    logger?.info('sign-in.started');
    let accountKey: string | undefined;
    await signInWithLoopback(
      this.oauth,
      (uri) => vscode.env.openExternal(vscode.Uri.parse(uri)),
      undefined,
      (stage, port) => logger?.debug('sign-in.stage', { stage, port }),
      async (tokens) => {
        accountKey = await this.completeSignIn(tokens);
        logger?.info('sign-in.completed');
      }
    );
    return accountKey!;
  }
  async signInWithDeviceCode(): Promise<string> { const logger = this.logger?.operation('auth.device-code-sign-in'); try { const accountKey = await this.completeSignIn(await signInWithDeviceCode(this.oauth)); logger?.info('sign-in.completed'); return accountKey; } catch (error) { logger?.error('sign-in.failed', error); throw error; } }

  async refreshIfNeeded(reason: 'proactive' | 'unauthorized' = 'proactive', accountKey?: string): Promise<CodexCredentialSnapshot> {
    const key = accountKey ?? await this.store.getActiveAccountKey();
    if (!key) throw new AuthRequiredError();
    const existing = this.refreshPromises.get(key);
    if (existing) return existing;
    const promise = this.doRefresh(reason, key).finally(() => { if (this.refreshPromises.get(key) === promise) this.refreshPromises.delete(key); });
    this.refreshPromises.set(key, promise);
    return promise;
  }

  async refreshAfter401(accountKey?: string): Promise<void> { const key = accountKey ?? await this.store.getActiveAccountKey(); await this.recoverFromUnauthorized({ accountKey: key!, snapshotRevision: (await this.getCredentialSnapshot(key)).revision, visibleActivity: false, reason: 'http401' }); }

  async recoverFromUnauthorized(context: { accountKey: string; snapshotRevision: string; visibleActivity: boolean; reason: 'http401' | 'websocketUnauthorized' }): Promise<CodexCredentialSnapshot> {
    if (context.visibleActivity) throw new ReauthRequiredError('Authentication failed after response activity started.');
    try { return await this.refreshIfNeeded('unauthorized', context.accountKey); } catch (error) { if (error instanceof TokenRefreshError && error.permanent) { this.permanentFailureRevisions.set(context.accountKey, context.snapshotRevision); this.fire('reauthRequired', context.accountKey); throw new ReauthRequiredError(); } throw error; }
  }

  /** Sign out / remove an account. Defaults to the active account. */
  async signOut(accountKey?: string): Promise<void> {
    const key = accountKey ?? await this.store.getActiveAccountKey();
    if (!key) return;
    const record = await this.store.getCredential(key);
    if (record?.source === 'extensionOAuth') await this.oauth.revoke(record.tokens.refresh_token).catch(() => undefined);
    await this.store.deleteCredential(key);
    this.permanentFailureRevisions.delete(key);
    this.refreshPromises.delete(key);
    this.fire('signedOut', key);
  }

  /** Sign out of every stored account. */
  async signOutAll(): Promise<void> {
    for (const account of await this.listAccounts()) {
      await this.signOut(account.accountKey);
    }
  }

  private async doRefresh(reason: 'proactive' | 'unauthorized', accountKey: string): Promise<CodexCredentialSnapshot> {
    const existing = await this.store.getCredential(accountKey); if (!existing) throw new AuthRequiredError(); if (!isRefreshableCredential(existing)) return snapshotFor(existing, accountKey); if (reason === 'proactive' && !needsRefresh(existing)) return snapshotFor(existing, accountKey); if (this.permanentFailureRevisions.get(accountKey) === existing.revision) throw new ReauthRequiredError();
    const logger = this.logger?.operation('auth.refresh', { reason });
    try {
      return await this.lockFor(accountKey).withLock(async () => { const latest = await this.store.getCredential(accountKey); if (!latest) throw new AuthRequiredError(); if (!isRefreshableCredential(latest)) return snapshotFor(latest, accountKey); if (reason === 'proactive' && !needsRefresh(latest)) return snapshotFor(latest, accountKey); const tokens = await this.oauth.refresh(latest.tokens.refresh_token); const replacement: RefreshableCodexCredentialRecord = { ...latest, revision: randomRevision(), tokens: { ...latest.tokens, ...tokens }, accessTokenExpiresAt: getJwtExpiration(tokens.access_token ?? latest.tokens.access_token), lastRefreshAt: new Date().toISOString() }; await this.store.setCredential(replacement, accountKey); this.permanentFailureRevisions.delete(accountKey); this.fire('tokensRefreshed', accountKey, replacement.revision); logger?.info('refresh.completed'); return snapshotFor(replacement, accountKey); });
    } catch (error) { logger?.warn('refresh.failed', { error }); throw error; }
  }

  private async completeSignIn(tokens: OAuthTokens): Promise<string> { const payload = safeDecode(tokens.id_token); const record: ExtensionOAuthCredentialRecord = { schemaVersion: 2, source: 'extensionOAuth', revision: randomRevision(), tokens, email: stringValue(payload.email), accessTokenExpiresAt: getJwtExpiration(tokens.access_token), lastRefreshAt: new Date().toISOString() }; const accountKey = await this.store.setCredential(record); this.permanentFailureRevisions.delete(accountKey); this.fire('signedIn', accountKey, record.revision); return accountKey; }

  private fire(reason: CodexAuthChangeEvent['reason'], accountKey: string, revision?: string): void { this.changes.fire({ reason, accountKey, revision }); }
}
export function needsRefresh(record: CodexCredentialRecord | { tokens: { access_token: string }; last_refresh?: string; lastRefreshAt?: string }): boolean { const access = 'tokens' in record ? record.tokens.access_token : record.accessToken; const last = 'lastRefreshAt' in record ? record.lastRefreshAt : ('last_refresh' in record ? record.last_refresh : undefined); return isJwtExpiringSoon(access, ACCESS_TOKEN_REFRESH_WINDOW_MS) || !last || !Number.isFinite(Date.parse(last)) || Date.now() - Date.parse(last) >= PERIODIC_REFRESH_INTERVAL_MS; }
function snapshotFor(record: CodexCredentialRecord, accountKey?: string): CodexCredentialSnapshot { return isRefreshableCredential(record) ? { source: record.source, accessToken: record.tokens.access_token, accountId: record.tokens.account_id, accountKey, expiresAt: record.accessTokenExpiresAt ?? getJwtExpiration(record.tokens.access_token), revision: record.revision, refreshable: true } : { source: record.source, accessToken: record.accessToken, accountId: record.accountId, accountKey, expiresAt: record.accessTokenExpiresAt, revision: record.revision, refreshable: false }; }
function isRefreshableCredential(record: CodexCredentialRecord | undefined): record is RefreshableCodexCredentialRecord { return record?.source === 'extensionOAuth' || record?.source === 'importedAuthJson'; }
function safeDecode(token: string): Record<string, unknown> { try { const value = decodeJwtPayload(token); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
