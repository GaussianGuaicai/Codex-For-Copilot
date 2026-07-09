export type CodexAuthMode = 'chatgpt';

export interface CodexTokenData {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

export interface CodexAuthBundle {
  auth_mode: CodexAuthMode;
  tokens: CodexTokenData;
  last_refresh?: string;
}

export interface CodexAuthStatus {
  authenticated: boolean;
  email?: string;
  accountId?: string;
  accessTokenExpiresAt?: number;
  lastRefresh?: string;
  reauthRequired?: boolean;
}

export type CodexAuthState =
  | 'unauthenticated'
  | 'authenticated'
  | 'refreshing'
  | 'reauthRequired'
  | 'signingIn';

export class AuthRequiredError extends Error {
  constructor(message = 'Codex credentials are required.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class ReauthRequiredError extends Error {
  constructor(message = 'Codex credentials expired. Please import auth.json again.') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

export class InvalidAuthJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuthJsonError';
  }
}

export class TokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
    public readonly status?: number,
    public readonly errorCode?: string
  ) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}
