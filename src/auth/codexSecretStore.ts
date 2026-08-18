import * as vscode from 'vscode';
import { decodeJwtPayload } from './codexJwt';
import type { CodexAuthBundle, CodexCredentialRecord, LegacyCodexCredentialRecord, RefreshableCodexCredentialRecord } from './codexAuthTypes';

/** Legacy single-account secret key retained purely for first-run migration. */
export const CODEX_AUTH_SECRET_KEY = 'codexForCopilot.codexAuthBundle';
const ACCOUNTS_INDEX_SECRET_KEY = 'codexForCopilot.codexAuthAccounts';
const ACTIVE_ACCOUNT_SECRET_KEY = 'codexForCopilot.codexActiveAccount';
const ACCOUNT_SECRET_PREFIX = 'codexForCopilot.codexAuthAccount.';

/** Value persisted in the accounts index secret. */
interface AccountsIndex {
  accountKeys: string[];
  activeAccountKey?: string;
}

/** Stores Codex credentials across multiple accounts plus a pointer to the active one. */
export class CodexSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** List every stored account key. Migration from the legacy single record is performed on first access. */
  async listAccountKeys(): Promise<string[]> {
    await this.migrateLegacyIfNeeded();
    return (await this.readIndex()).accountKeys;
  }

  /** The active account key, defaulting to the first stored account when unset. */
  async getActiveAccountKey(): Promise<string | undefined> {
    await this.migrateLegacyIfNeeded();
    const index = await this.readIndex();
    const requested = index.activeAccountKey;
    if (requested && await this.hasCredential(requested)) {
      return requested;
    }
    const first = index.accountKeys[0];
    if (first && first !== requested) {
      await this.writeIndex({ accountKeys: index.accountKeys, activeAccountKey: first });
    }
    return first;
  }

  async setActiveAccountKey(accountKey: string): Promise<void> {
    await this.migrateLegacyIfNeeded();
    if (!await this.hasCredential(accountKey)) throw new Error(`Unknown Codex account: ${accountKey}`);
    const index = await this.readIndex();
    await this.writeIndex({ accountKeys: index.accountKeys, activeAccountKey: accountKey });
  }

  // ------------------------------------------------------------------
  // Per-account credential access
  // ------------------------------------------------------------------

  async getCredential(accountKey?: string): Promise<CodexCredentialRecord | undefined> {
    const key = accountKey ?? await this.getActiveAccountKey();
    if (!key) return undefined;
    const raw = await this.secrets.get(this.accountKeyFor(key));
    return raw ? parseCredential(raw) : undefined;
  }

  /** Persist a record under a derived account key; returns the key used. */
  async setCredential(record: RefreshableCodexCredentialRecord, accountKey?: string): Promise<string> {
    await this.migrateLegacyIfNeeded();
    const key = accountKey ?? deriveAccountKey(record);
    await this.secrets.store(this.accountKeyFor(key), JSON.stringify(record));
    await this.addToIndex(key);
    return key;
  }

  async setLegacyCredential(record: LegacyCodexCredentialRecord, accountKey?: string): Promise<string> {
    await this.migrateLegacyIfNeeded();
    const key = accountKey ?? deriveAccountKey(record);
    await this.secrets.store(this.accountKeyFor(key), JSON.stringify(record));
    await this.addToIndex(key);
    return key;
  }

  async deleteCredential(accountKey?: string): Promise<void> {
    const key = accountKey ?? await this.getActiveAccountKey();
    if (!key) return;
    await this.secrets.delete(this.accountKeyFor(key));
    const index = await this.readIndex();
    const accountKeys = index.accountKeys.filter((k) => k !== key);
    const activeAccountKey = index.activeAccountKey === key ? accountKeys[0] : index.activeAccountKey;
    await this.writeIndex({ accountKeys, activeAccountKey });
  }

  async hasCredential(accountKey: string): Promise<boolean> {
    return (await this.secrets.get(this.accountKeyFor(accountKey))) !== undefined;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private accountKeyFor(accountKey: string): string {
    return `${ACCOUNT_SECRET_PREFIX}${accountKey}`;
  }

  private async readIndex(): Promise<AccountsIndex> {
    const raw = await this.secrets.get(ACCOUNTS_INDEX_SECRET_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AccountsIndex;
        if (Array.isArray(parsed?.accountKeys)) {
          return { accountKeys: parsed.accountKeys.filter((k): k is string => typeof k === 'string'), activeAccountKey: typeof parsed.activeAccountKey === 'string' ? parsed.activeAccountKey : undefined };
        }
      } catch { /* fall through to reconstruct from active key */ }
    }
    const active = await this.secrets.get(ACTIVE_ACCOUNT_SECRET_KEY);
    return { accountKeys: [], activeAccountKey: active ?? undefined };
  }

  private async writeIndex(index: AccountsIndex): Promise<void> {
    await this.secrets.store(ACCOUNTS_INDEX_SECRET_KEY, JSON.stringify(index));
    if (index.activeAccountKey) {
      await this.secrets.store(ACTIVE_ACCOUNT_SECRET_KEY, index.activeAccountKey);
    } else {
      await this.secrets.delete(ACTIVE_ACCOUNT_SECRET_KEY);
    }
  }

  private async addToIndex(accountKey: string): Promise<void> {
    const index = await this.readIndex();
    if (!index.accountKeys.includes(accountKey)) {
      index.accountKeys.push(accountKey);
    }
    if (!index.activeAccountKey) {
      index.activeAccountKey = accountKey;
    }
    await this.writeIndex(index);
  }

  /** Move the legacy single-key record into a derived account key. Runs once. */
  private async migrateLegacyIfNeeded(): Promise<void> {
    const legacyRaw = await this.secrets.get(CODEX_AUTH_SECRET_KEY);
    if (!legacyRaw) return;
    try {
      const record = parseCredential(legacyRaw);
      if (record) {
        const key = deriveAccountKey(record);
        await this.secrets.store(this.accountKeyFor(key), JSON.stringify(record));
        await this.addToIndex(key);
      }
    } catch { /* ignore unparsable legacy secret */ }
    await this.secrets.delete(CODEX_AUTH_SECRET_KEY);
  }
}

export function randomRevision(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }

function parseCredential(raw: string): CodexCredentialRecord | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (isCredential(value)) return value;
    const legacy = value as CodexAuthBundle;
    if (legacy?.auth_mode === 'chatgpt' && legacy.tokens?.access_token && legacy.tokens?.id_token && legacy.tokens?.refresh_token) {
      return { schemaVersion: 2, source: 'importedAuthJson', revision: randomRevision(), tokens: legacy.tokens, lastRefreshAt: legacy.last_refresh ?? new Date().toISOString() };
    }
  } catch { /* invalid stored secret is treated as absent */ }
  return undefined;
}

/** Stable per-account secret suffix derived from the credential's identity. */
function deriveAccountKey(record: CodexCredentialRecord): string {
  const accountId = isRefreshableCredential(record) ? record.tokens.account_id : record.accountId;
  if (accountId?.trim()) return sanitize(accountId.trim());
  if (record.email?.trim()) return sanitize(record.email.trim());
  if (isRefreshableCredential(record)) {
    try {
      const payload = decodeJwtPayload(record.tokens.id_token);
      if (payload && typeof payload === 'object') {
        const email = (payload as Record<string, unknown>).email;
        if (typeof email === 'string' && email.trim()) return sanitize(email.trim());
      }
    } catch { /* fall through */ }
  }
  return sanitize(`account-${record.revision}`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isCredential(value: unknown): value is CodexCredentialRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CodexCredentialRecord>;
  return candidate.schemaVersion === 2 && (candidate.source === 'extensionOAuth' || candidate.source === 'importedAuthJson' || candidate.source === 'legacyCodexFile');
}
function isRefreshableCredential(record: CodexCredentialRecord | undefined): record is RefreshableCodexCredentialRecord {
  return record?.source === 'extensionOAuth' || record?.source === 'importedAuthJson';
}
