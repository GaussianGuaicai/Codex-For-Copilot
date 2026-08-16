import * as vscode from 'vscode';
import type { CodexAuthBundle, CodexCredentialRecord, LegacyCodexCredentialRecord, RefreshableCodexCredentialRecord } from './codexAuthTypes';

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
        // Migrate pre-schema imports into the same refreshable record used by new
        // auth.json imports, preserving a stable record identity for VS Code sessions.
        const migrated: RefreshableCodexCredentialRecord = { schemaVersion: 2, source: 'importedAuthJson', revision: randomRevision(), tokens: legacy.tokens, lastRefreshAt: legacy.last_refresh ?? new Date().toISOString() };
        try { await this.setCredential(migrated); } catch { /* preserve usable credentials if migration persistence fails */ }
        return migrated;
      }
    } catch { /* invalid stored secret is treated as absent */ }
    return undefined;
  }
  async setCredential(record: RefreshableCodexCredentialRecord): Promise<void> { await this.secrets.store(CODEX_AUTH_SECRET_KEY, JSON.stringify(record)); }
  async setLegacyCredential(record: LegacyCodexCredentialRecord): Promise<void> { await this.secrets.store(CODEX_AUTH_SECRET_KEY, JSON.stringify(record)); }
  async deleteCredential(): Promise<void> { await this.secrets.delete(CODEX_AUTH_SECRET_KEY); }
  // Compatibility helpers retained for existing consumers during migration.
  async getAuthBundle(): Promise<CodexAuthBundle | undefined> { const record = await this.getCredential(); return isRefreshableCredential(record) ? { auth_mode: 'chatgpt', tokens: record.tokens, last_refresh: record.lastRefreshAt } : undefined; }
  async setAuthBundle(bundle: CodexAuthBundle): Promise<void> { await this.setCredential({ schemaVersion: 2, source: 'importedAuthJson', revision: randomRevision(), tokens: bundle.tokens, lastRefreshAt: bundle.last_refresh ?? new Date().toISOString() }); }
  async deleteAuthBundle(): Promise<void> { await this.deleteCredential(); }
}
export function randomRevision(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function isCredential(value: unknown): value is CodexCredentialRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CodexCredentialRecord>;
  return candidate.schemaVersion === 2 && (candidate.source === 'extensionOAuth' || candidate.source === 'importedAuthJson' || candidate.source === 'legacyCodexFile');
}
function isRefreshableCredential(record: CodexCredentialRecord | undefined): record is RefreshableCodexCredentialRecord {
  return record?.source === 'extensionOAuth' || record?.source === 'importedAuthJson';
}
