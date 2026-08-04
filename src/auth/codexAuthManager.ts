import * as vscode from 'vscode';
import { parseCodexAuthJson } from './codexAuthJsonImporter';
import { CodexAuthLock } from './codexAuthLock';
import { getJwtExpiration, isJwtExpiringSoon, decodeJwtPayload } from './codexJwt';
import { CodexSecretStore, randomRevision } from './codexSecretStore';
import { ACCESS_TOKEN_REFRESH_WINDOW_MS, PERIODIC_REFRESH_INTERVAL_MS } from './codexTokenRefresh';
import { CodexOAuthClient, type OAuthTokens } from './codexOAuthClient';
import { signInWithLoopback } from './codexLoopbackLogin';
import { signInWithDeviceCode } from './codexDeviceCodeLogin';
import { AuthRequiredError, type CodexAuthChangeEvent, type CodexAuthStatus, type CodexCredentialRecord, type CodexCredentialSnapshot, type ExtensionOAuthCredentialRecord, ReauthRequiredError, TokenRefreshError } from './codexAuthTypes';
import type { CodexLogger } from '../codexLogger';

export class CodexAuthManager implements vscode.Disposable {
  private refreshPromise: Promise<CodexCredentialSnapshot> | undefined;
  private permanentFailureRevision: string | undefined;
  private readonly changes = new vscode.EventEmitter<CodexAuthChangeEvent>();
  readonly onDidChangeAuth = this.changes.event;
  constructor(
    private readonly store: CodexSecretStore,
    private readonly lock: CodexAuthLock,
    private readonly oauth = new CodexOAuthClient(),
    private readonly logger?: CodexLogger
  ) {}
  dispose(): void { this.changes.dispose(); }
  async getStatus(): Promise<CodexAuthStatus> { const record = await this.store.getCredential(); if (!record) return { authenticated: false }; const snapshot = snapshotFor(record); return { authenticated: true, source: record.source, email: record.email, accountId: snapshot.accountId, accessTokenExpiresAt: snapshot.expiresAt, lastRefresh: record.source === 'extensionOAuth' ? record.lastRefreshAt : record.loadedAt, reauthRequired: this.permanentFailureRevision === snapshot.revision }; }
  async getCredentialSnapshot(): Promise<CodexCredentialSnapshot> { const record = await this.store.getCredential(); if (!record) throw new AuthRequiredError(); if (record.source === 'extensionOAuth') await this.refreshIfNeeded(); const latest = await this.store.getCredential(); if (!latest) throw new AuthRequiredError(); return snapshotFor(latest); }
  async getAccessToken(): Promise<string> { return (await this.getCredentialSnapshot()).accessToken; }
  async importAuthJson(rawJson: string): Promise<void> { const bundle = parseCodexAuthJson(rawJson); const payload = safeDecode(bundle.tokens.id_token); await this.store.setLegacyCredential({ schemaVersion: 2, source: 'legacyCodexFile', revision: randomRevision(), accessToken: bundle.tokens.access_token, accountId: bundle.tokens.account_id, email: stringValue(payload.email), accessTokenExpiresAt: getJwtExpiration(bundle.tokens.access_token), loadedAt: bundle.last_refresh ?? new Date().toISOString() }); this.fire('signedIn'); }
  async signInWithBrowser(): Promise<void> {
    const logger = this.logger?.operation('auth.browser-sign-in');
    logger?.info('sign-in.started');
    await signInWithLoopback(
      this.oauth,
      (uri) => vscode.env.openExternal(vscode.Uri.parse(uri)),
      undefined,
      (stage, port) => logger?.debug('sign-in.stage', { stage, port }),
      async (tokens) => {
        await this.completeSignIn(tokens);
        logger?.info('sign-in.completed');
      }
    );
  }
  async signInWithDeviceCode(): Promise<void> { const logger = this.logger?.operation('auth.device-code-sign-in'); try { await this.completeSignIn(await signInWithDeviceCode(this.oauth)); logger?.info('sign-in.completed'); } catch (error) { logger?.error('sign-in.failed', error); throw error; } }
  async refreshIfNeeded(reason: 'proactive' | 'unauthorized' = 'proactive'): Promise<CodexCredentialSnapshot> {
    if (!this.refreshPromise) this.refreshPromise = this.doRefresh(reason).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  async refreshAfter401(): Promise<void> { await this.recoverFromUnauthorized({ snapshotRevision: (await this.getCredentialSnapshot()).revision, visibleActivity: false, reason: 'http401' }); }
  async recoverFromUnauthorized(context: { snapshotRevision: string; visibleActivity: boolean; reason: 'http401' | 'websocketUnauthorized' }): Promise<CodexCredentialSnapshot> {
    if (context.visibleActivity) throw new ReauthRequiredError('Authentication failed after response activity started.');
    try { return await this.refreshIfNeeded('unauthorized'); } catch (error) { if (error instanceof TokenRefreshError && error.permanent) { this.permanentFailureRevision = context.snapshotRevision; this.fire('reauthRequired'); throw new ReauthRequiredError(); } throw error; }
  }
  async signOut(): Promise<void> { const record = await this.store.getCredential(); if (record?.source === 'extensionOAuth') await this.oauth.revoke(record.tokens.refresh_token).catch(() => undefined); await this.store.deleteCredential(); this.permanentFailureRevision = undefined; this.fire('signedOut'); }
  private async doRefresh(reason: 'proactive' | 'unauthorized'): Promise<CodexCredentialSnapshot> {
    const existing = await this.store.getCredential(); if (!existing) throw new AuthRequiredError(); if (existing.source !== 'extensionOAuth') return snapshotFor(existing); if (reason === 'proactive' && !needsRefresh(existing)) return snapshotFor(existing); if (this.permanentFailureRevision === existing.revision) throw new ReauthRequiredError();
    const logger = this.logger?.operation('auth.refresh', { reason });
    try {
      return await this.lock.withLock(async () => { const latest = await this.store.getCredential(); if (!latest) throw new AuthRequiredError(); if (latest.source !== 'extensionOAuth') return snapshotFor(latest); if (reason === 'proactive' && !needsRefresh(latest)) return snapshotFor(latest); const tokens = await this.oauth.refresh(latest.tokens.refresh_token); const replacement: ExtensionOAuthCredentialRecord = { ...latest, revision: randomRevision(), tokens: { ...latest.tokens, ...tokens }, accessTokenExpiresAt: getJwtExpiration(tokens.access_token ?? latest.tokens.access_token), lastRefreshAt: new Date().toISOString() }; await this.store.setCredential(replacement); this.permanentFailureRevision = undefined; this.fire('tokensRefreshed', replacement.revision); logger?.info('refresh.completed'); return snapshotFor(replacement); });
    } catch (error) { logger?.warn('refresh.failed', { error }); throw error; }
  }
  private async completeSignIn(tokens: OAuthTokens): Promise<void> { const payload = safeDecode(tokens.id_token); const previous = await this.store.getCredential(); const record: ExtensionOAuthCredentialRecord = { schemaVersion: 2, source: 'extensionOAuth', revision: randomRevision(), tokens, email: stringValue(payload.email), accessTokenExpiresAt: getJwtExpiration(tokens.access_token), lastRefreshAt: new Date().toISOString() }; await this.store.setCredential(record); this.permanentFailureRevision = undefined; this.fire(previous ? 'accountChanged' : 'signedIn', record.revision); }
  private fire(reason: CodexAuthChangeEvent['reason'], revision?: string): void { this.changes.fire({ reason, revision }); }
}
export function needsRefresh(record: CodexCredentialRecord | { tokens: { access_token: string }; last_refresh?: string; lastRefreshAt?: string }): boolean { const access = 'tokens' in record ? record.tokens.access_token : record.accessToken; const last = 'lastRefreshAt' in record ? record.lastRefreshAt : ('last_refresh' in record ? record.last_refresh : undefined); return isJwtExpiringSoon(access, ACCESS_TOKEN_REFRESH_WINDOW_MS) || !last || !Number.isFinite(Date.parse(last)) || Date.now() - Date.parse(last) >= PERIODIC_REFRESH_INTERVAL_MS; }
function snapshotFor(record: CodexCredentialRecord): CodexCredentialSnapshot { return record.source === 'extensionOAuth' ? { source: record.source, accessToken: record.tokens.access_token, accountId: record.tokens.account_id, expiresAt: record.accessTokenExpiresAt ?? getJwtExpiration(record.tokens.access_token), revision: record.revision, refreshable: true } : { source: record.source, accessToken: record.accessToken, accountId: record.accountId, expiresAt: record.accessTokenExpiresAt, revision: record.revision, refreshable: false }; }
function safeDecode(token: string): Record<string, unknown> { try { const value = decodeJwtPayload(token); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
