export type CodexCredentialSource = 'extensionOAuth' | 'importedAuthJson' | 'legacyCodexFile';

export interface CodexTokenData {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

// Kept solely for parsing older Codex auth.json files.
export interface CodexAuthBundle {
  auth_mode: 'chatgpt';
  tokens: CodexTokenData;
  last_refresh?: string;
}

export interface ExtensionOAuthCredentialRecord {
  schemaVersion: 2;
  source: 'extensionOAuth';
  revision: string;
  tokens: CodexTokenData;
  email?: string;
  accessTokenExpiresAt?: number;
  lastRefreshAt: string;
}

export interface ImportedAuthJsonCredentialRecord {
  schemaVersion: 2;
  source: 'importedAuthJson';
  revision: string;
  tokens: CodexTokenData;
  email?: string;
  accessTokenExpiresAt?: number;
  lastRefreshAt: string;
}

export type RefreshableCodexCredentialRecord = ExtensionOAuthCredentialRecord | ImportedAuthJsonCredentialRecord;

export interface LegacyCodexCredentialRecord {
  schemaVersion: 2;
  source: 'legacyCodexFile';
  revision: string;
  accessToken: string;
  accountId?: string;
  email?: string;
  accessTokenExpiresAt?: number;
  loadedAt: string;
}

export type CodexCredentialRecord = RefreshableCodexCredentialRecord | LegacyCodexCredentialRecord;

export interface CodexCredentialSnapshot {
  source: CodexCredentialSource | 'openaiApiKey';
  accessToken: string;
  accountId?: string;
  expiresAt?: number;
  revision: string;
  refreshable: boolean;
}

export interface CodexAuthStatus {
  authenticated: boolean;
  source?: CodexCredentialSource;
  email?: string;
  accountId?: string;
  accessTokenExpiresAt?: number;
  lastRefresh?: string;
  reauthRequired?: boolean;
}

export type CodexAuthChangeReason = 'signedIn' | 'tokensRefreshed' | 'reauthRequired' | 'signedOut' | 'accountChanged';
export interface CodexAuthChangeEvent { reason: CodexAuthChangeReason; revision?: string; }

export class AuthRequiredError extends Error {
  constructor(message = 'Sign in with ChatGPT or configure an API key.') { super(message); this.name = 'AuthRequiredError'; }
}
export class ReauthRequiredError extends Error {
  constructor(message = 'ChatGPT credentials expired or were revoked. Please sign in again.') { super(message); this.name = 'ReauthRequiredError'; }
}
export class InvalidAuthJsonError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidAuthJsonError'; }
}
export class TokenRefreshError extends Error {
  constructor(message: string, public readonly permanent: boolean, public readonly status?: number, public readonly errorCode?: string) {
    super(message); this.name = 'TokenRefreshError';
  }
}
