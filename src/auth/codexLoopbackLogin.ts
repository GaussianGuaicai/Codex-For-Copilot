import { createServer, type Server } from 'node:http';
import { CODEX_OAUTH, type CodexOAuthCompatibilityProfile } from './codexOAuthCompatibility';
import { generateCodexPkce, statesMatch } from './codexPkce';
import type { CodexOAuthClient, OAuthTokens } from './codexOAuthClient';

export type LoopbackSignInStage = 'listening' | 'browserOpened' | 'callbackReceived' | 'exchangingCode' | 'completed';

export async function signInWithLoopback(
  client: CodexOAuthClient,
  openExternal: (uri: string) => Thenable<boolean>,
  profile: CodexOAuthCompatibilityProfile = CODEX_OAUTH,
  onStage?: (stage: LoopbackSignInStage, port: number) => void,
  persistTokens?: (tokens: OAuthTokens) => Promise<void>
): Promise<OAuthTokens> {
  const { server, port } = await bindLoopback(profile.loopbackPorts);
  onStage?.('listening', port);
  const redirectUri = `http://localhost:${port}${profile.callbackPath}`;
  const pkce = generateCodexPkce();
  let timeout: NodeJS.Timeout | undefined;
  const result = new Promise<{ code: string; response: import('node:http').ServerResponse }>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('ChatGPT sign-in timed out.')), 5 * 60_000);
    timeout.unref?.();
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== profile.callbackPath) { response.writeHead(404).end(); return; }
      onStage?.('callbackReceived', port);
      const code = url.searchParams.get('code'); const state = url.searchParams.get('state'); const oauthError = url.searchParams.get('error');
      if (oauthError || !code || !statesMatch(pkce.state, state ?? undefined)) { response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end('<h1>Sign-in could not be verified.</h1>You can close this tab.'); clearTimeout(timeout); reject(new Error('ChatGPT sign-in callback was rejected.')); return; }
      clearTimeout(timeout);
      resolve({ code, response });
    });
  });
  try {
    const opened = await openExternal(client.createAuthorizationUrl(redirectUri, pkce.verifier, pkce.challenge, pkce.state));
    if (!opened) throw new Error('VS Code could not open the ChatGPT sign-in page.');
    onStage?.('browserOpened', port);
    const { code, response } = await result;
    onStage?.('exchangingCode', port);
    try {
      const tokens = await client.exchangeAuthorizationCode(code, redirectUri, pkce.verifier);
      await persistTokens?.(tokens);
      onStage?.('completed', port);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end('<h1>Signed in to Codex for Copilot.</h1>You can close this tab and return to VS Code.');
      return tokens;
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end('<h1>Sign-in could not be completed.</h1>Return to VS Code for details.');
      throw error;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    closeLoopbackServer(server);
  }
}
async function bindLoopback(ports: readonly number[]): Promise<{ server: Server; port: number }> {
  for (const port of ports) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return { server, port };
    } catch {
      server.close();
    }
  }
  throw new Error('ChatGPT sign-in could not bind a local callback port. Use Device Code sign-in instead.');
}

function closeLoopbackServer(server: Server): void {
  server.close();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
}
