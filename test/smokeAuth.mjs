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
export * from ${repoImport('src/auth/codexAccountIdentity')};
export * from ${repoImport('src/auth/codexJwt')};
export * from ${repoImport('src/auth/codexAuthManager')};
export * from ${repoImport('src/auth/codexAuthTypes')};
export * from ${repoImport('src/auth/codexAuthRequest')};
export * from ${repoImport('src/auth/codexAuthLock')};
export * from ${repoImport('src/auth/codexSecretStore')};
export * from ${repoImport('src/auth/codexPkce')};
export * from ${repoImport('src/auth/codexOAuthClient')};
export * from ${repoImport('src/auth/codexAuthenticationProvider')};
export * from ${repoImport('src/auth/codexLoopbackLogin')};
export * from ${repoImport('src/secrets')};
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

  const nestedTokens = {
    id_token: jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'nested-workspace', chatgpt_user_id: 'nested-user' },
      'https://api.openai.com/profile': { email: 'nested@example.com' }
    }),
    access_token: futureToken,
    refresh_token: 'nested-refresh'
  };
  const nestedIdentity = auth.parseCodexAccountIdentity(nestedTokens);
  assertEqual(nestedIdentity.accountId, 'nested-workspace', 'identity parser reads the nested workspace claim without account_id');
  assertEqual(nestedIdentity.userId, 'nested-user', 'identity parser reads the nested user claim');
  assertEqual(nestedIdentity.email, 'nested@example.com', 'identity parser reads the nested profile email');
  const explicitIdentity = auth.parseCodexAccountIdentity({ ...nestedTokens, account_id: 'explicit-workspace' }, 'explicit@example.com');
  assertEqual(explicitIdentity.accountId, 'explicit-workspace', 'explicit workspace selection takes precedence over JWT claims');
  assertEqual(explicitIdentity.email, 'explicit@example.com', 'explicit email takes precedence over JWT claims');
  const legacyIdentity = auth.parseCodexAccountIdentity({
    ...nestedTokens,
    id_token: jwt({
      'https://api.openai.com/auth.chatgpt_account_id': 'legacy-workspace',
      'https://api.openai.com/auth.user_id': 'legacy-user',
      'https://api.openai.com/profile.email': 'legacy@example.com'
    })
  });
  assertEqual(legacyIdentity.accountId, 'legacy-workspace', 'legacy dotted workspace claims remain supported');
  assertEqual(legacyIdentity.userId, 'legacy-user', 'legacy dotted user claims remain supported');
  assertEqual(legacyIdentity.email, 'legacy@example.com', 'legacy dotted profile claims remain supported');
  assertEqual(auth.parseCodexAccountIdentity({
    ...nestedTokens,
    id_token: jwt({ 'https://api.openai.com/auth': { user_id: 'alternate-user' } })
  }).userId, 'alternate-user', 'nested user_id remains a supported owner claim');
  for (const invalidClaim of [null, [], 'invalid', { chatgpt_account_id: 42, chatgpt_user_id: false, email: [] }]) {
    const identity = auth.parseCodexAccountIdentity({
      ...nestedTokens,
      id_token: jwt({ 'https://api.openai.com/auth': invalidClaim, 'https://api.openai.com/profile': invalidClaim })
    });
    assertEqual(JSON.stringify(identity), '{}', 'malformed namespaced claims are ignored');
  }
  assertEqual(auth.parseCodexAccountIdentity({ ...nestedTokens, id_token: 'malformed', account_id: 'explicit-workspace' }).accountId, 'explicit-workspace', 'malformed JWTs do not discard explicit workspace selection');

  const nestedSecrets = new Map();
  const nestedStore = new auth.CodexSecretStore({
    async get(key) { return nestedSecrets.get(key); },
    async store(key, value) { nestedSecrets.set(key, value); },
    async delete(key) { nestedSecrets.delete(key); }
  });
  const nestedOAuth = new auth.CodexOAuthClient(async () => new Response(JSON.stringify(nestedTokens), { status: 200 }));
  const nestedManager = new auth.CodexAuthManager(
    nestedStore,
    () => ({ async withLock(callback) { return callback(); } }),
    nestedOAuth
  );
  const nestedLoginTokens = await nestedOAuth.exchangeAuthorizationCode('test-code', 'http://localhost/auth/callback', 'test-verifier');
  assertEqual(nestedLoginTokens.account_id, undefined, 'OAuth regression fixture has no top-level account_id');
  const nestedKey = await nestedManager.completeSignIn(nestedLoginTokens);
  assertEqual((await nestedManager.getCredentialSnapshot(nestedKey)).accountId, 'nested-workspace', 'native sign-in resolves the workspace from the JWT');
  assertEqual((await nestedManager.getStatus(nestedKey)).accountId, 'nested-workspace', 'auth status reports the resolved workspace');
  assertEqual((await nestedManager.listAccounts())[0].accountId, 'nested-workspace', 'account listing reports the resolved workspace');
  assertEqual(await nestedManager.completeSignIn(nestedLoginTokens), nestedKey, 'signing in again reuses the verified nested owner');
  const restoredNestedManager = new auth.CodexAuthManager(
    nestedStore,
    () => ({ async withLock(callback) { return callback(); } }),
    { async refresh() { throw new Error('stored snapshots must not refresh'); }, async revoke() {} }
  );
  assertEqual((await restoredNestedManager.getStoredCredentialSnapshot(nestedKey)).accountId, 'nested-workspace', 'existing OAuth records without account_id work without signing in again');
  const storedNestedCredentials = await auth.getCodexCredentialsForAccount(restoredNestedManager, nestedKey, false);
  assertEqual(storedNestedCredentials.headers['ChatGPT-Account-ID'], 'nested-workspace', 'inactive account usage retains the resolved workspace header');
  restoredNestedManager.dispose();
  const nestedHeaders = [];
  const nestedResponse = await auth.codexFetch(nestedManager, 'https://example.test/usage', {}, async (_input, init) => {
    nestedHeaders.push(init.headers['ChatGPT-Account-ID']);
    return new Response('', { status: nestedHeaders.length === 1 ? 401 : 200 });
  }, nestedKey);
  assertEqual(nestedResponse.status, 200, 'nested OAuth credentials recover after a refresh');
  assertEqual(JSON.stringify(nestedHeaders), JSON.stringify(['nested-workspace', 'nested-workspace']), 'initial and refreshed requests both send the workspace header');
  const refreshedNestedCredentials = await auth.getCodexCredentialsForAccount(nestedManager, nestedKey);
  assertEqual(refreshedNestedCredentials.headers['ChatGPT-Account-ID'], 'nested-workspace', 'active provider credentials retain the resolved workspace header');
  nestedManager.dispose();

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

  const staleSecrets = new Map();
  const staleStorage = new auth.CodexSecretStore({
    async get(key) { return staleSecrets.get(key); },
    async store(key, value) { staleSecrets.set(key, value); },
    async delete(key) { staleSecrets.delete(key); }
  });
  let staleRefreshCalls = 0;
  const staleManager = new auth.CodexAuthManager(
    staleStorage,
    () => ({ async withLock(callback) { return callback(); } }),
    {
      async refresh(refreshToken) {
        staleRefreshCalls += 1;
        if (refreshToken !== 'initial-refresh') throw new Error('Refresh token was already rotated.');
        return { access_token: 'new-access', refresh_token: 'rotated-refresh' };
      },
      async revoke() {}
    }
  );
  const staleAccountKey = await staleManager.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: futureToken, access_token: futureToken, refresh_token: 'initial-refresh' }
  }));
  const staleSnapshot = await staleManager.getCredentialSnapshot(staleAccountKey);
  const staleContext = { accountKey: staleAccountKey, snapshotRevision: staleSnapshot.revision, visibleActivity: false, reason: 'http401' };
  const refreshedSnapshot = await staleManager.recoverFromUnauthorized(staleContext);
  const delayedRetrySnapshot = await staleManager.recoverFromUnauthorized(staleContext);
  assertEqual(delayedRetrySnapshot.accessToken, refreshedSnapshot.accessToken, 'delayed 401 reuses the token refreshed for its original revision');
  assertEqual(staleRefreshCalls, 1, 'delayed 401 does not rotate a one-use refresh token twice');
  staleManager.dispose();

  const lockedSecrets = new Map();
  const lockedStorage = new auth.CodexSecretStore({
    async get(key) { return lockedSecrets.get(key); },
    async store(key, value) { lockedSecrets.set(key, value); },
    async delete(key) { lockedSecrets.delete(key); }
  });
  let lockedRefreshCalls = 0;
  const lockedOAuth = {
    async refresh() {
      lockedRefreshCalls += 1;
      if (lockedRefreshCalls > 1) throw new Error('Cross-window refresh token was already rotated.');
      return { access_token: 'locked-new-access', refresh_token: 'locked-new-refresh' };
    },
    async revoke() {}
  };
  const firstWindow = new auth.CodexAuthManager(lockedStorage, () => ({ async withLock(callback) { return callback(); } }), lockedOAuth);
  const lockedAccountKey = await firstWindow.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt', tokens: { id_token: futureToken, access_token: futureToken, refresh_token: 'locked-original-refresh' }
  }));
  const lockedOriginal = await firstWindow.getCredentialSnapshot(lockedAccountKey);
  const lockedContext = { accountKey: lockedAccountKey, snapshotRevision: lockedOriginal.revision, visibleActivity: false, reason: 'http401' };
  const secondWindow = new auth.CodexAuthManager(lockedStorage, () => ({ async withLock(callback) {
    await firstWindow.recoverFromUnauthorized(lockedContext);
    return callback();
  } }), lockedOAuth);
  const lockedResult = await secondWindow.recoverFromUnauthorized(lockedContext);
  assertEqual(lockedResult.accessToken, 'locked-new-access', 'waiting window reads rotated credentials after acquiring the lock');
  assertEqual(lockedRefreshCalls, 1, 'waiting window does not reuse a refresh token rotated by another window');
  firstWindow.dispose();
  secondWindow.dispose();

  const rejectedSecrets = new Map();
  const rejectedStorage = new auth.CodexSecretStore({
    async get(key) { return rejectedSecrets.get(key); },
    async store(key, value) { rejectedSecrets.set(key, value); },
    async delete(key) { rejectedSecrets.delete(key); }
  });
  let rejectedRefreshCalls = 0;
  const rejectedManager = new auth.CodexAuthManager(
    rejectedStorage,
    () => ({ async withLock(callback) { return callback(); } }),
    {
      async refresh() {
        rejectedRefreshCalls += 1;
        throw new auth.TokenRefreshError('Refresh credential rejected.', true, 401, 'invalid_grant');
      },
      async revoke() {}
    }
  );
  const rejectedEvents = [];
  rejectedManager.onDidChangeAuth((event) => rejectedEvents.push(event));
  const rejectedAccountKey = await rejectedManager.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt', tokens: { id_token: futureToken, access_token: soonToken, refresh_token: 'rejected-refresh', account_id: 'workspace-rejected' }
  }));
  await assertRejects(() => rejectedManager.getCredentialSnapshot(rejectedAccountKey), 'permanent proactive refresh rejection requires reauthentication');
  assertEqual((await rejectedManager.getStatus(rejectedAccountKey)).reauthRequired, true, 'rejected proactive refresh marks the account as requiring reauthentication');
  await assertRejects(() => rejectedManager.getCredentialSnapshot(rejectedAccountKey), 'rejected account does not refresh again');
  assertEqual(rejectedRefreshCalls, 1, 'permanent proactive rejection does not flood the token endpoint');
  assertEqual(rejectedEvents.filter((event) => event.reason === 'reauthRequired').length, 1, 'permanent proactive rejection emits one reauthentication event');
  await rejectedManager.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt', tokens: { id_token: futureToken, access_token: futureToken, refresh_token: 'recovered-refresh', account_id: 'workspace-rejected' }
  }));
  assertEqual((await rejectedManager.getStatus(rejectedAccountKey)).reauthRequired, false, 'fresh re-import clears reauthentication state');
  const stillValidSnapshot = await rejectedManager.getCredentialSnapshot(rejectedAccountKey);
  await assertRejects(() => rejectedManager.recoverFromUnauthorized({
    accountKey: rejectedAccountKey,
    snapshotRevision: stillValidSnapshot.revision,
    visibleActivity: false,
    reason: 'http401'
  }), '401 refresh rejection requires reauthentication even before access-token expiry');
  await assertRejects(() => rejectedManager.getCredentialSnapshot(rejectedAccountKey), 'rejected unexpired access token is not sent to the backend again');
  rejectedManager.dispose();

  const periodicSecrets = new Map();
  const periodicCalls = [];
  const periodicManager = new auth.CodexAuthManager(
    new auth.CodexSecretStore({
      async get(key) { return periodicSecrets.get(key); },
      async store(key, value) { periodicSecrets.set(key, value); },
      async delete(key) { periodicSecrets.delete(key); }
    }),
    () => ({ async withLock(callback) { return callback(); } }),
    {
      async refresh(refreshToken) {
        periodicCalls.push(refreshToken);
        if (refreshToken.startsWith('broken-')) throw new auth.TokenRefreshError('Revoked.', true, 401, 'invalid_grant');
        return { access_token: futureToken, refresh_token: `rotated-${refreshToken}` };
      },
      async revoke() {}
    }
  );
  const activeKey = await periodicManager.importAuthJson(authJsonFor('active', 'workspace', 'active@example.com', soonToken));
  const inactiveKey = await periodicManager.importAuthJson(authJsonFor('inactive', 'workspace', 'inactive@example.com', soonToken));
  const freshKey = await periodicManager.importAuthJson(authJsonFor('fresh', 'workspace', 'fresh@example.com', futureToken));
  const brokenKey = await periodicManager.importAuthJson(JSON.stringify({
    auth_mode: 'chatgpt', tokens: { ...authJsonTokens('broken', 'workspace', 'broken@example.com', soonToken), refresh_token: 'broken-refresh' }
  }));
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let periodicTick;
  let periodicInterval;
  let periodicTimer;
  let timerRegistrations = 0;
  let timerCleared = false;
  globalThis.setInterval = (callback, interval) => {
    timerRegistrations += 1;
    periodicTick = callback;
    periodicInterval = interval;
    periodicTimer = originalSetInterval(() => {}, interval);
    return periodicTimer;
  };
  globalThis.clearInterval = (timer) => {
    if (timer === periodicTimer) timerCleared = true;
    return originalClearInterval(timer);
  };
  try {
    await periodicManager.startPeriodicRefresh();
    await periodicManager.startPeriodicRefresh();
    assertEqual(timerRegistrations, 1, 'background refresh starts only one scheduler');
    assertEqual(periodicInterval, 5 * 60 * 1000, 'background credential refresh checks every five minutes');
    assertEqual(JSON.stringify(periodicCalls.sort()), JSON.stringify(['active-workspace-refresh', 'broken-refresh', 'inactive-workspace-refresh'].sort()), 'startup checks active and inactive expiring accounts independently');
    assertEqual((await periodicManager.getActiveAccountKey()), activeKey, 'background refresh does not switch accounts');
    assertEqual((await periodicManager.getStoredCredentialSnapshot(inactiveKey)).accessToken, futureToken, 'inactive account stores its rotated access token');
    assertEqual((await periodicManager.getStoredCredentialSnapshot(freshKey)).accessToken, futureToken, 'fresh inactive account is not refreshed unnecessarily');
    assertEqual((await periodicManager.getStatus(brokenKey)).reauthRequired, true, 'a rejected inactive account is marked without blocking others');
    const renewedInactive = new Promise((resolve) => {
      const subscription = periodicManager.onDidChangeAuth((event) => {
        if (event.reason === 'tokensRefreshed' && event.accountKey === inactiveKey) {
          subscription.dispose();
          resolve();
        }
      });
    });
    await periodicManager.importAuthJson(authJsonFor('inactive', 'workspace', 'inactive@example.com', soonToken));
    periodicTick();
    await renewedInactive;
    assertEqual(periodicCalls.filter((token) => token === 'broken-refresh').length, 1, 'periodic ticks do not retry permanently rejected credentials');
  } finally {
    periodicManager.dispose();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  assertEqual(timerCleared, true, 'disposing the auth manager stops periodic credential refresh');

  const profileIdentity = auth.parseCodexAccountIdentity({
    id_token: jwt({ 'https://api.openai.com/auth.chatgpt_user_id': 'profile-user', 'https://api.openai.com/profile.email': 'profile@example.com' }),
    access_token: futureToken,
    refresh_token: 'profile-refresh',
    account_id: 'workspace-profile'
  });
  assertEqual(profileIdentity.email, 'profile@example.com', 'identity parser reads the profile email claim');

  const multiAccountSecrets = new Map();
  const multiAccountManager = createImportedManager(auth, multiAccountSecrets);
  const userAWorkspaceOne = authJsonFor('user-a', 'workspace-1', 'a@example.com', 'user-a-token');
  const userBWorkspaceOne = authJsonFor('user-b', 'workspace-1', 'b@example.com', 'user-b-token');
  const userAWorkspaceTwo = authJsonFor('user-a', 'workspace-2', 'a@example.com', 'user-a-workspace-two-token');
  const userAKey = await multiAccountManager.importAuthJson(userAWorkspaceOne);
  const userBKey = await multiAccountManager.importAuthJson(userBWorkspaceOne);
  assertEqual((await multiAccountManager.listAccounts()).length, 2, 'different users in one workspace retain separate accounts');
  assertEqual(userAKey === userBKey, false, 'different users in one workspace receive distinct local keys');
  await multiAccountManager.switchAccount(userAKey);
  assertEqual((await multiAccountManager.getCredentialSnapshot()).accessToken, 'user-a-token', 'switching restores user A credentials');
  await multiAccountManager.switchAccount(userBKey);
  assertEqual((await multiAccountManager.getCredentialSnapshot()).accessToken, 'user-b-token', 'switching restores user B credentials');
  const inactiveAccountCredentials = await auth.getCodexCredentialsForAccount(multiAccountManager, userAKey, false);
  assertEqual(inactiveAccountCredentials.apiKey, 'user-a-token', 'inactive account usage credentials retain the stored token');
  assertEqual(inactiveAccountCredentials.authManager, undefined, 'inactive account usage credentials do not trigger refresh or 401 retry');
  const updatedUserAKey = await multiAccountManager.importAuthJson(authJsonFor('user-a', 'workspace-1', 'a@example.com', 'user-a-new-token'));
  assertEqual(updatedUserAKey, userAKey, 're-importing the same owner reuses its local key');
  assertEqual((await multiAccountManager.listAccounts()).length, 2, 're-importing the same owner does not duplicate the account');
  assertEqual((await multiAccountManager.getCredentialSnapshot(userAKey)).accessToken, 'user-a-new-token', 're-importing updates the existing owner credentials');
  const userAWorkspaceTwoKey = await multiAccountManager.importAuthJson(userAWorkspaceTwo);
  assertEqual(userAWorkspaceTwoKey === userAKey, false, 'the same user in a different workspace receives a separate local key');
  assertEqual((await multiAccountManager.listAccounts()).length, 3, 'the same user can retain independent workspace accounts');
  const multiAccountProvider = new auth.CodexAuthenticationProvider(multiAccountManager);
  const multiAccountSessions = await multiAccountProvider.getSessions(undefined, {});
  assertEqual(multiAccountSessions.length, 3, 'each stored owner produces a VS Code authentication session');
  assertEqual(new Set(multiAccountSessions.map((session) => session.id)).size, 3, 'stored owners produce distinct VS Code authentication session IDs');
  multiAccountProvider.dispose();
  multiAccountManager.dispose();

  const legacyUserATokens = authJsonTokens('user-a', 'workspace-1', 'a@example.com', 'legacy-user-a-token');
  const legacyV2Secrets = new Map([
    ['codexForCopilot.codexAuthAccounts', JSON.stringify({ accountKeys: ['workspace-1'], activeAccountKey: 'workspace-1' })],
    ['codexForCopilot.codexAuthAccount.workspace-1', JSON.stringify({ schemaVersion: 2, source: 'importedAuthJson', revision: 'legacy-user-a', tokens: legacyUserATokens, email: 'a@example.com', lastRefreshAt: new Date().toISOString() })]
  ]);
  const legacyV2Manager = createImportedManager(auth, legacyV2Secrets);
  const legacyUserBKey = await legacyV2Manager.importAuthJson(userBWorkspaceOne);
  assertEqual(legacyUserBKey === 'workspace-1', false, 'legacy workspace key does not overwrite another user in the workspace');
  assertEqual(JSON.parse(legacyV2Secrets.get('codexForCopilot.codexAuthAccount.workspace-1')).tokens.access_token, 'legacy-user-a-token', 'legacy workspace credential remains unchanged');
  assertEqual((await legacyV2Manager.listAccounts()).length, 2, 'legacy storage retains both owners after import');
  assertEqual(await legacyV2Manager.importAuthJson(userAWorkspaceOne), 'workspace-1', 're-importing the legacy owner retains its existing workspace key');
  legacyV2Manager.dispose();

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

  for (const failingKey of ['codexForCopilot.codexAuthAccount.acct_1', 'codexForCopilot.codexAuthAccounts']) {
    const migrationSecrets = new Map([
      ['codexForCopilot.codexAuthBundle', JSON.stringify({ auth_mode: 'chatgpt', tokens: valid.tokens })]
    ]);
    const migrationStore = new auth.CodexSecretStore({
      async get(key) { return migrationSecrets.get(key); },
      async store(key, value) {
        if (key === failingKey) throw new Error('temporary SecretStorage failure');
        migrationSecrets.set(key, value);
      },
      async delete(key) { migrationSecrets.delete(key); }
    });
    await migrationStore.listAccountKeys();
    assertEqual(migrationSecrets.has('codexForCopilot.codexAuthBundle'), true, `legacy secret survives failed migration write for ${failingKey}`);
  }

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

  const legacyAccountCalls = [];
  let legacyAccessCall = 0;
  const legacyCompatibilityManager = {
    async getAccessToken(accountKey) {
      legacyAccountCalls.push(['token', accountKey]);
      legacyAccessCall += 1;
      return legacyAccessCall === 1 ? 'legacy-old-token' : 'legacy-new-token';
    },
    async refreshAfter401(accountKey) {
      legacyAccountCalls.push(['refresh', accountKey]);
    }
  };
  seenAuth.length = 0;
  const legacyResponse = await auth.codexFetch(
    legacyCompatibilityManager,
    'http://legacy.example.test',
    {},
    globalThis.fetch,
    'legacy-account-a'
  );
  assertEqual(legacyResponse.status, 200, 'legacy 401 retry succeeds');
  assertEqual(JSON.stringify(legacyAccountCalls), JSON.stringify([
    ['token', 'legacy-account-a'],
    ['refresh', 'legacy-account-a'],
    ['token', 'legacy-account-a']
  ]), 'legacy token reads and 401 refresh use the pinned account key');
  assertEqual(JSON.stringify(seenAuth), JSON.stringify(['Bearer legacy-old-token', 'Bearer legacy-new-token']), 'legacy retry uses the refreshed pinned token');
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
    credentialSnapshotCalls: 0,
    storedCredentialSnapshotCalls: 0,
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
      this.credentialSnapshotCalls += 1;
      if (!signedInSnapshot) {
        throw new Error('not signed in');
      }
      return signedInSnapshot;
    },
    async getStoredCredentialSnapshot() {
      this.storedCredentialSnapshotCalls += 1;
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
  assertEqual(fakeAuthManager.credentialSnapshotCalls, 0, 'session enumeration avoids refresh-capable credential reads');
  assertEqual(fakeAuthManager.storedCredentialSnapshotCalls > 0, true, 'session enumeration reads stored credential snapshots');
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

  console.log('Smoke test passed: multi-owner auth import, PKCE, loopback completion, JWT parsing, refresh decisions, 401 retry, and VS Code authentication sessions are correct.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function jwt(payload) {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}

function authJsonFor(userId, accountId, email, accessToken) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: authJsonTokens(userId, accountId, email, accessToken) });
}

function authJsonTokens(userId, accountId, email, accessToken) {
  return {
    id_token: jwt({
      'https://api.openai.com/auth': { chatgpt_user_id: userId, chatgpt_account_id: accountId },
      'https://api.openai.com/profile': { email }
    }),
    access_token: accessToken,
    refresh_token: `${userId}-${accountId}-refresh`,
    account_id: accountId
  };
}

function createImportedManager(authApi, secrets) {
  return new authApi.CodexAuthManager(
    new authApi.CodexSecretStore({
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); }
    }),
    () => ({ async withLock(callback) { return callback(); } }),
    { async refresh() { throw new Error('multi-account test credentials must not refresh'); }, async revoke() {} }
  );
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
