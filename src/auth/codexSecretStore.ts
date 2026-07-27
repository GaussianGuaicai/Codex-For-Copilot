import * as vscode from 'vscode';
import type { CodexAuthBundle, CodexCredentialRecord, ExtensionOAuthCredentialRecord, LegacyCodexCredentialRecord } from './codexAuthTypes';

export const CODEX_AUTH_SECRET_KEY = 'codexForCopilot.codexAuthBundle';

export class CodexSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  async getCredential(): Promise<CodexCredentialRecord | undefined> {
    const raw = await this.secrets.get(CODEX_AUTH_SECRET_KEY);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as unknown;
      if (isCredential(value)) return value;
      const legacy = value as CodexAuthBundle;
      if (legacy?.auth_mode === 'chatgpt' && legacy.tokens?.access_token && legacy.tokens?.id_token && legacy.tokens?.refresh_token) {
        // Old imports were copied from Codex CLI. Preserve the access token only;
        // the extension must never rotate a refresh token it does not own.
        return { schemaVersion: 2, source: 'legacyCodexFile', revision: randomRevision(), accessToken: legacy.tokens.access_token, accountId: legacy.tokens.account_id, loadedAt: legacy.last_refresh ?? new Date().toISOString() };
      }
    } catch { /* invalid stored secret is treated as absent */ }
    return undefined;
  }
  async setCredential(record: ExtensionOAuthCredentialRecord): Promise<void> { await this.secrets.store(CODEX_AUTH_SECRET_KEY, JSON.stringify(record)); }
  async setLegacyCredential(record: LegacyCodexCredentialRecord): Promise<void> { await this.secrets.store(CODEX_AUTH_SECRET_KEY, JSON.stringify(record)); }
  async deleteCredential(): Promise<void> { await this.secrets.delete(CODEX_AUTH_SECRET_KEY); }
  // Compatibility helpers retained for existing consumers during migration.
  async getAuthBundle(): Promise<CodexAuthBundle | undefined> { const record = await this.getCredential(); return record?.source === 'extensionOAuth' ? { auth_mode: 'chatgpt', tokens: record.tokens, last_refresh: record.lastRefreshAt } : undefined; }
  async setAuthBundle(bundle: CodexAuthBundle): Promise<void> { await this.setCredential({ schemaVersion: 2, source: 'extensionOAuth', revision: randomRevision(), tokens: bundle.tokens, lastRefreshAt: bundle.last_refresh ?? new Date().toISOString() }); }
  async deleteAuthBundle(): Promise<void> { await this.deleteCredential(); }
}
export function randomRevision(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function isCredential(value: unknown): value is CodexCredentialRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CodexCredentialRecord>;
  return candidate.schemaVersion === 2 && (candidate.source === 'extensionOAuth' || candidate.source === 'legacyCodexFile');
}
