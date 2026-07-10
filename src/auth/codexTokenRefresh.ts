import { TokenRefreshError } from './codexAuthTypes';

export const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
export const PERIODIC_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;

const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const PERMANENT_ERROR_CODES = new Set([
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'revoked',
  'unauthorized_client'
]);

export interface RefreshResult {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

export async function refreshCodexTokens(refreshToken: string): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
  } catch (error) {
    throw new TokenRefreshError('Codex token refresh failed due to a network error.', false);
  }

  const payload = await readJsonObject(response);
  if (!response.ok) {
    const errorCode = typeof payload.error === 'string' ? payload.error : undefined;
    const permanent = response.status === 400 || response.status === 401 || (errorCode ? PERMANENT_ERROR_CODES.has(errorCode) : false);
    throw new TokenRefreshError('Codex token refresh failed.', permanent, response.status, errorCode);
  }

  return {
    ...(typeof payload.id_token === 'string' && payload.id_token.trim() ? { id_token: payload.id_token.trim() } : {}),
    ...(typeof payload.access_token === 'string' && payload.access_token.trim() ? { access_token: payload.access_token.trim() } : {}),
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.trim() ? { refresh_token: payload.refresh_token.trim() } : {})
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = (await response.json()) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
