import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-auth-'));
const bundlePath = join(tempDir, 'auth.cjs');
const entryPath = join(tempDir, 'auth-entry.ts');
const repoImport = (relativePath) => JSON.stringify(join(process.cwd(), relativePath));
const require = createRequire(import.meta.url);
const moduleLoad = Module._load;
const nativeFetch = globalThis.fetch;
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        fs: {
          stat: async (uri) => {
            const fileStat = await stat(uri.fsPath);
            return { mtime: fileStat.mtimeMs };
          },
          delete: async (uri) => {
            await rm(uri.fsPath);
          }
        }
      },
      window: { showErrorMessage: async () => undefined, showInformationMessage: async () => undefined },
      commands: { executeCommand: async () => undefined },
      EventEmitter
    };
  }
  return moduleLoad.call(this, request, parent, isMain);
};
await import('node:fs/promises').then(({ writeFile }) => writeFile(entryPath, `
export * from ${repoImport('src/auth/codexAuthJsonImporter')};
export * from ${repoImport('src/auth/codexJwt')};
export * from ${repoImport('src/auth/codexAuthManager')};
export * from ${repoImport('src/auth/codexAuthRequest')};
export * from ${repoImport('src/auth/codexAuthLock')};
export * from ${repoImport('src/auth/codexSecretStore')};
export * from ${repoImport('src/auth/codexPkce')};
export * from ${repoImport('src/auth/codexOAuthClient')};
export * from ${repoImport('src/auth/codexAuthenticationProvider')};
export * from ${repoImport('src/auth/codexLoopbackLogin')};
`));

await build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: ['vscode']
});

try {
  const auth = require(bundlePath);
  const futureToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'user@example.com' });
  const soonToken = jwt({ exp: Math.floor(Date.now() / 1000) + 60 });
  const valid = auth.parseCodexAuthJson(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: futureToken,
      access_token: futureToken,
      refresh_token: 'refresh-token',
      account_id: 'acct_1'
    },
    OPENAI_API_KEY: 'ignored'
  }));

  assertEqual(valid.auth_mode, 'chatgpt', 'auth mode');
  assertEqual(valid.tokens.refresh_token, 'refresh-token', 'refresh token');
  assertEqual('OPENAI_API_KEY' in valid, false, 'extra fields ignored');
  assertThrows(() => auth.parseCodexAuthJson('{'), 'malformed JSON rejected');
  assertThrows(() => auth.parseCodexAuthJson(JSON.stringify({ auth_mode: 'api', tokens: {} })), 'unsupported mode rejected');
  assertThrows(() => auth.parseCodexAuthJson(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a', access_token: 'b' } })), 'missing refresh token rejected');

  assertEqual(auth.getJwtExpiration(futureToken), JSON.parse(Buffer.from(futureToken.split('.')[1], 'base64url').toString()).exp * 1000, 'jwt expiration');
  assertEqual(auth.getJwtExpiration('not-a-jwt'), undefined, 'malformed jwt expiration');
  assertEqual(auth.isJwtExpiringSoon(soonToken, 5 * 60 * 1000), true, 'expiring soon');
  assertEqual(auth.needsRefresh({ ...valid, tokens: { ...valid.tokens, access_token: soonToken } }), true, 'refresh when access token expires soon');
  assertEqual(auth.needsRefresh({ ...valid, last_refresh: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString() }), true, 'refresh when last_refresh is old');

  const importedSecrets = new Map();
  const importedSecretStorage = {
    async get(key) { return importedSecrets.get(key); },
    async store(key, value) { importedSecrets.set(key, value); },
    async delete(key) { importedSecrets.delete(key); }
  };
  const importedRefreshCalls = [];
  let importedRevokeCalls = 0;
  const importedManager = new auth.CodexAuthManager(
    new auth.CodexSecretStore(importedSecretStorage),
    () => ({ async withLock(callback) { return callback(); } }),
    {
      async refresh(refreshToken) {
        importedRefreshCalls.push(refreshToken);
        return { access_token: futureToken, refresh_token: 'rotated-refresh-token', account_id: 'acct_2' };
      },
      async revoke() { importedRevokeCalls += 1; }
    }
  );
  const importedEvents = [];
  const importedSubscription = importedManager.onDidChangeAuth((event) => importedEvents.push(event));
  const importedAccountKey = await importedManager.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: futureToken,
      access_token: soonToken,
      refresh_token: 'imported-refresh-token',
      account_id: 'acct_1'
    }
  }));
  const accountSecretKey = `codexForCopilot.codexAuthAccount.${importedAccountKey}`;
  const importedBeforeRefresh = JSON.parse(importedSecrets.get(accountSecretKey));
  assertEqual(importedBeforeRefresh.source, 'importedAuthJson', 'auth.json import retains its credential source');
  assertEqual(importedBeforeRefresh.tokens.refresh_token, 'imported-refresh-token', 'auth.json import stores its refresh token');
  const importedSnapshot = await importedManager.getCredentialSnapshot();
  const importedAfterRefresh = JSON.parse(importedSecrets.get(accountSecretKey));
  assertEqual(importedSnapshot.source, 'importedAuthJson', 'auth.json import remains identifiable after refresh');
  assertEqual(importedSnapshot.refreshable, true, 'auth.json import is refreshable');
  assertEqual(JSON.stringify(importedRefreshCalls), JSON.stringify(['imported-refresh-token']), 'auth.json import enters the automatic refresh path');
  assertEqual(importedAfterRefresh.tokens.refresh_token, 'rotated-refresh-token', 'auth.json refresh persists refresh-token rotation');
  assertEqual(importedAfterRefresh.tokens.account_id, 'acct_2', 'auth.json refresh persists refreshed account metadata');
  assertEqual(JSON.stringify(importedEvents.map((event) => event.reason)), JSON.stringify(['signedIn', 'tokensRefreshed']), 'auth.json import emits sign-in and refresh events');
  await importedManager.signOut();
  assertEqual(importedSecrets.has(accountSecretKey), false, 'sign-out removes the imported credential copy');
  assertEqual(importedRevokeCalls, 0, 'sign-out does not revoke an imported auth.json credential');
  importedSubscription.dispose();
  importedManager.dispose();

  const rawImportedSecrets = new Map([
    ['codexForCopilot.codexAuthBundle', JSON.stringify({ auth_mode: 'chatgpt', tokens: valid.tokens, last_refresh: new Date().toISOString() })]
  ]);
  const rawImportedStore = new auth.CodexSecretStore({
    async get(key) { return rawImportedSecrets.get(key); },
    async store(key, value) { rawImportedSecrets.set(key, value); },
    async delete(key) { rawImportedSecrets.delete(key); }
  });
  const migratedRawImport = await rawImportedStore.getCredential();
  assertEqual(migratedRawImport.source, 'importedAuthJson', 'pre-schema auth.json import migrates into the refreshable path');
  assertEqual(migratedRawImport.tokens.refresh_token, 'refresh-token', 'pre-schema auth.json migration preserves the refresh token');
  const migratedKey = (await rawImportedStore.listAccountKeys())[0];
  assertEqual(rawImportedSecrets.has('codexForCopilot.codexAuthBundle'), false, 'legacy single-key record is removed after migration');
  assertEqual(JSON.parse(rawImportedSecrets.get(`codexForCopilot.codexAuthAccount.${migratedKey}`)).source, 'importedAuthJson', 'pre-schema auth.json migration persists a stable schema-v2 record');

  const legacySecrets = new Map();
  const legacySecretStorage = {
    async get(key) { return legacySecrets.get(key); },
    async store(key, value) { legacySecrets.set(key, value); },
    async delete(key) { legacySecrets.delete(key); }
  };
  const legacyStore = new auth.CodexSecretStore(legacySecretStorage);
  const legacyManager = new auth.CodexAuthManager(
    legacyStore,
    () => ({ async withLock(callback) { return callback(); } }),
    { async refresh() { throw new Error('legacy snapshots must not refresh'); }, async revoke() {} }
  );
  await legacyManager.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: futureToken, access_token: futureToken, refresh_token: 'fresh-import-token' }
  }));
  await legacyStore.setLegacyCredential({
    schemaVersion: 2,
    source: 'legacyCodexFile',
    revision: 'legacy',
    accessToken: futureToken,
    accountId: 'legacy-acct',
    loadedAt: new Date().toISOString()
  });
  await legacyManager.switchAccount('legacy-acct');
  const legacySnapshot = await legacyManager.getCredentialSnapshot();
  assertEqual(legacySnapshot.source, 'legacyCodexFile', 'stored legacy access-token snapshots remain identifiable');
  assertEqual(legacySnapshot.refreshable, false, 'stored legacy access-token snapshots stay non-refreshable');
  legacyManager.dispose();

  const lock = new auth.CodexAuthLock({ fsPath: join(tempDir, 'refresh.lock') });
  let activeLocks = 0;
  let maxConcurrentLocks = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => lock.withLock(async () => {
      activeLocks += 1;
      maxConcurrentLocks = Math.max(maxConcurrentLocks, activeLocks);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeLocks -= 1;
    }))
  );
  assertEqual(maxConcurrentLocks, 1, 'refresh lock serializes concurrent callers');

  let calls = 0;
  const manager = {
    async getCredentialSnapshot() {
      calls += 1;
      return { accessToken: calls === 1 ? 'old-token' : 'new-token', accountId: 'acct_1', accountKey: 'acct_1', revision: calls === 1 ? 'old' : 'new' };
    },
    async getActiveAccountKey() { return 'acct_1'; },
    async recoverFromUnauthorized() {
      calls += 10;
      return { accessToken: 'new-token', accountId: 'acct_1', accountKey: 'acct_1', revision: 'new' };
    }
  };
  const seenAuth = [];
  globalThis.fetch = async (_input, init) => {
    seenAuth.push(init.headers.Authorization);
    return new Response('', { status: seenAuth.length === 1 ? 401 : 200 });
  };
  const response = await auth.codexFetch(manager, 'http://example.test', {});
  assertEqual(response.status, 200, '401 retry succeeds');
  assertEqual(JSON.stringify(seenAuth), JSON.stringify(['Bearer old-token', 'Bearer new-token']), 'retry uses refreshed token');
  globalThis.fetch = nativeFetch;

  const pkce = auth.generateCodexPkce();
  assertEqual(pkce.verifier.length >= 43, true, 'PKCE verifier has RFC-compliant length');
  assertEqual(pkce.challenge.length >= 43, true, 'PKCE challenge has RFC-compliant length');
  assertEqual(auth.statesMatch(pkce.state, pkce.state), true, 'PKCE state matches itself');
  assertEqual(auth.statesMatch(pkce.state, 'incorrect'), false, 'PKCE state rejects mismatch');
  const oauth = new auth.CodexOAuthClient(async () => new Response(JSON.stringify({ id_token: futureToken, access_token: 'access', refresh_token: 'refresh' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const url = new URL(oauth.createAuthorizationUrl('http://localhost:1455/auth/callback', pkce.verifier, pkce.challenge, pkce.state));
  assertEqual(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize', 'authorization URL matches Codex OAuth endpoint');
  assertEqual(url.searchParams.get('scope'), 'openid profile email offline_access api.connectors.read api.connectors.invoke', 'authorization URL matches Codex OAuth scopes');
  assertEqual(url.searchParams.get('code_challenge_method'), 'S256', 'authorization URL uses PKCE S256');
  assertEqual(url.searchParams.get('state'), pkce.state, 'authorization URL includes state');

  const callbackPort = await findAvailablePort();
  const loopbackClient = {
    createAuthorizationUrl(redirectUri, _verifier, _challenge, state) {
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', state);
      return callback.toString();
    },
    async exchangeAuthorizationCode(code) {
      assertEqual(code, 'authorization-code', 'IPv6 callback authorization code');
      return { id_token: futureToken, access_token: 'access', refresh_token: 'refresh' };
    }
  };
  const loopbackStages = [];
  let callbackConnection;
  let credentialsPersisted = false;
  let callbackPromise;
  const loopbackTokens = await auth.signInWithLoopback(loopbackClient, async (redirectUri) => {
    const callback = new URL(redirectUri);
    callbackPromise = fetch(`http://127.0.0.1:${callback.port}${callback.pathname}?code=authorization-code&state=${callback.searchParams.get('state')}`).then(async (response) => {
      callbackConnection = response.headers.get('connection');
      assertEqual(response.status, 200, 'callback reports success after credentials are persisted');
      assertEqual(credentialsPersisted, true, 'callback success waits for credential persistence');
    });
    return true;
  }, { loopbackPorts: [callbackPort], callbackPath: '/auth/callback' }, (stage) => loopbackStages.push(stage), async () => {
    credentialsPersisted = true;
  });
  await callbackPromise;
  assertEqual(loopbackTokens.access_token, 'access', 'loopback callback completes OAuth sign-in');
  assertEqual(callbackConnection, 'close', 'callback response closes the browser connection');
  assertEqual(loopbackStages.at(-1), 'completed', 'loopback sign-in completes before server cleanup');

  const failedCallbackPort = await findAvailablePort();
  let failedCallbackPromise;
  const failedLoopbackClient = {
    createAuthorizationUrl: loopbackClient.createAuthorizationUrl,
    async exchangeAuthorizationCode() {
      throw new Error('token exchange failed');
    }
  };
  await assertRejects(() => auth.signInWithLoopback(failedLoopbackClient, async (redirectUri) => {
    const callback = new URL(redirectUri);
    failedCallbackPromise = fetch(`http://127.0.0.1:${callback.port}${callback.pathname}?code=authorization-code&state=${callback.searchParams.get('state')}`).then((response) => {
      assertEqual(response.status, 500, 'callback reports token exchange failure');
    });
    return true;
  }, { loopbackPorts: [failedCallbackPort], callbackPath: '/auth/callback' }), 'token exchange failure rejects loopback sign-in');
  await failedCallbackPromise;

  const authChanges = new EventEmitter();
  let signedInSnapshot;
  const fakeAuthManager = {
    onDidChangeAuth: authChanges.event,
    async getStatus() {
      return signedInSnapshot
        ? { authenticated: true, email: 'user@example.com' }
        : { authenticated: false };
    },
    async listAccounts() {
      return signedInSnapshot
        ? [{ accountKey: 'acct_1', source: 'extensionOAuth', email: 'user@example.com', accountId: signedInSnapshot.accountId, isActive: true, reauthRequired: false }]
        : [];
    },
    async getActiveAccountKey() { return signedInSnapshot ? 'acct_1' : undefined; },
    async getCredentialSnapshot() {
      if (!signedInSnapshot) {
        throw new Error('not signed in');
      }
      return signedInSnapshot;
    },
    async signInWithBrowser() {
      signedInSnapshot = {
        source: 'extensionOAuth',
        accessToken: 'initial-access-token',
        accountId: 'acct_1',
        revision: 'first',
        refreshable: true
      };
      authChanges.fire({ reason: 'signedIn' });
    },
    async signOut() {
      signedInSnapshot = undefined;
      authChanges.fire({ reason: 'signedOut' });
    }
  };
  const authenticationProvider = new auth.CodexAuthenticationProvider(fakeAuthManager);
  const sessionChanges = [];
  authenticationProvider.onDidChangeSessions((event) => sessionChanges.push(event));
  assertEqual((await authenticationProvider.getSessions(undefined, {})).length, 0, 'unauthenticated provider has no sessions');
  const session = await authenticationProvider.createSession(['openid'], {});
  await flushEvents();
  assertEqual(session.account.id, 'acct_1', 'session uses Codex account ID');
  assertEqual(sessionChanges[0].added[0].id, session.id, 'sign-in adds a VS Code session');
  signedInSnapshot = { ...signedInSnapshot, accessToken: 'refreshed-access-token', revision: 'second' };
  authChanges.fire({ reason: 'tokensRefreshed' });
  await flushEvents();
  assertEqual(sessionChanges[1].changed[0].accessToken, 'refreshed-access-token', 'token refresh updates the VS Code session');
  await authenticationProvider.removeSession(session.id);
  await flushEvents();
  assertEqual(sessionChanges[2].removed[0].id, session.id, 'sign-out removes the VS Code session');
  await assertRejects(() => authenticationProvider.createSession(['unsupported-scope'], {}), 'unsupported authentication scope rejected');
  authenticationProvider.dispose();

  console.log('Smoke test passed: auth import, PKCE, loopback completion, JWT parsing, refresh decisions, 401 retry, and VS Code authentication sessions are correct.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function jwt(payload) {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, label) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected throw`);
}

async function assertRejects(fn, label) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

async function flushEvents() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1').once('listening', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
