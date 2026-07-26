export interface CodexOAuthCompatibilityProfile {
  issuer: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  deviceCodeUrl: string;
  deviceTokenUrl: string;
  loopbackPorts: readonly number[];
  callbackPath: string;
  scopes: string;
}

// Isolate values copied from the current public Codex implementation. These are
// compatibility values, not a new public OAuth contract for this extension.
export const CODEX_OAUTH: CodexOAuthCompatibilityProfile = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  revokeUrl: 'https://auth.openai.com/oauth/revoke',
  deviceCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  loopbackPorts: [1455, 1457],
  callbackPath: '/auth/callback',
  scopes: 'openid profile email offline_access'
};
