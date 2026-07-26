import { CODEX_OAUTH, type CodexOAuthCompatibilityProfile } from './codexOAuthCompatibility';
import { TokenRefreshError } from './codexAuthTypes';

export interface OAuthTokens { id_token: string; access_token: string; refresh_token: string; account_id?: string; }
export interface DeviceCodeResponse { device_auth_id: string; user_code: string; verification_uri: string; interval: number; }
type FetchLike = typeof fetch;

export class CodexOAuthClient {
  constructor(private readonly request: FetchLike = fetch, private readonly profile: CodexOAuthCompatibilityProfile = CODEX_OAUTH) {}
  createAuthorizationUrl(redirectUri: string, verifier: string, challenge: string, state: string): string {
    const url = new URL(this.profile.authorizeUrl);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.profile.clientId, redirect_uri: redirectUri, scope: this.profile.scopes, code_challenge: challenge, code_challenge_method: 'S256', state, id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex-for-copilot' }).toString();
    return url.toString();
  }
  async exchangeAuthorizationCode(code: string, redirectUri: string, verifier: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: this.profile.clientId }) as Promise<OAuthTokens>;
  }
  async refresh(refreshToken: string): Promise<Partial<OAuthTokens>> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.profile.clientId }, true);
  }
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await this.request(this.profile.deviceCodeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: this.profile.clientId, originator: 'codex-for-copilot' }) });
    const body = await jsonObject(response);
    if (!response.ok || !isString(body.device_auth_id) || !isString(body.user_code)) throw new Error('Could not start Device Code sign-in.');
    const interval = typeof body.interval === 'number' ? body.interval : Number(body.interval);
    return { device_auth_id: body.device_auth_id, user_code: body.user_code, verification_uri: `${this.profile.issuer}/codex/device`, interval: Number.isFinite(interval) && interval > 0 ? interval : 5 };
  }
  async pollDeviceCode(deviceAuthId: string, userCode: string): Promise<{ authorization_code?: string; code_verifier?: string; pending: boolean }> {
    const response = await this.request(this.profile.deviceTokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }) });
    const body = await jsonObject(response);
    if (response.ok && isString(body.authorization_code) && isString(body.code_verifier)) return { authorization_code: body.authorization_code, code_verifier: body.code_verifier, pending: false };
    const code = typeof body.error === 'string' ? body.error : '';
    if (response.status === 404 || response.status === 428 || /pending|authorization_pending/i.test(code)) return { pending: true };
    throw new Error('Device Code sign-in was rejected.');
  }
  async revoke(token: string): Promise<void> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
    try { await this.request(this.profile.revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: this.profile.clientId }), signal: controller.signal }); } finally { clearTimeout(timeout); }
  }
  private async token(values: Record<string, string>, allowPartial = false): Promise<OAuthTokens | Partial<OAuthTokens>> {
    let response: Response;
    try { response = await this.request(this.profile.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) }); }
    catch { throw new TokenRefreshError('ChatGPT token request failed due to a network error.', false); }
    const body = await jsonObject(response);
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : undefined;
      const permanent = response.status === 401 || (response.status === 400 && Boolean(code && /^(invalid_grant|refresh_token_(expired|reused|invalidated)|revoked)$/i.test(code)));
      throw new TokenRefreshError('ChatGPT token request failed.', permanent, response.status, code);
    }
    const tokens: Partial<OAuthTokens> = {};
    for (const key of ['id_token', 'access_token', 'refresh_token'] as const) if (isString(body[key])) tokens[key] = body[key].trim();
    if (isString(body.account_id)) tokens.account_id = body.account_id.trim();
    if (!allowPartial && (!tokens.id_token || !tokens.access_token || !tokens.refresh_token)) throw new Error('ChatGPT token response was incomplete.');
    return tokens as OAuthTokens;
  }
}
async function jsonObject(response: Response): Promise<Record<string, unknown>> { try { const value = await response.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
function isString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
