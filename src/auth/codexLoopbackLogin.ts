import { createServer, type Server } from 'node:http';
import { CODEX_OAUTH, type CodexOAuthCompatibilityProfile } from './codexOAuthCompatibility';
import { generateCodexPkce, statesMatch } from './codexPkce';
import type { CodexOAuthClient, OAuthTokens } from './codexOAuthClient';

export async function signInWithLoopback(client: CodexOAuthClient, openExternal: (uri: string) => Thenable<boolean>, profile: CodexOAuthCompatibilityProfile = CODEX_OAUTH): Promise<OAuthTokens> {
  const { server, port } = await bindLoopback(profile.loopbackPorts);
  const redirectUri = `http://localhost:${port}${profile.callbackPath}`;
  const pkce = generateCodexPkce();
  const result = new Promise<{ code: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ChatGPT sign-in timed out.')), 5 * 60_000); timeout.unref?.();
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== profile.callbackPath) { response.writeHead(404).end(); return; }
      const code = url.searchParams.get('code'); const state = url.searchParams.get('state'); const oauthError = url.searchParams.get('error');
      if (oauthError || !code || !statesMatch(pkce.state, state ?? undefined)) { response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>Sign-in could not be verified.</h1>You can close this tab.'); clearTimeout(timeout); reject(new Error('ChatGPT sign-in callback was rejected.')); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>Signed in to Codex for Copilot.</h1>You can close this tab and return to VS Code.'); clearTimeout(timeout); resolve({ code });
    });
  });
  try { await openExternal(client.createAuthorizationUrl(redirectUri, pkce.verifier, pkce.challenge, pkce.state)); const { code } = await result; return await client.exchangeAuthorizationCode(code, redirectUri, pkce.verifier); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
async function bindLoopback(ports: readonly number[]): Promise<{ server: Server; port: number }> {
  for (const port of ports) { const server = createServer(); try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); return { server, port }; } catch { server.close(); } }
  throw new Error('ChatGPT sign-in could not bind a local callback port. Use Device Code sign-in instead.');
}
