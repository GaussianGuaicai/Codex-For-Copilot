import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-auth-'));
const bundlePath = join(tempDir, 'auth.cjs');
const entryPath = join(tempDir, 'auth-entry.ts');
const repoImport = (relativePath) => JSON.stringify(join(process.cwd(), relativePath));
const require = createRequire(import.meta.url);
const moduleLoad = Module._load;
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
      commands: { executeCommand: async () => undefined }
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
    async getAccessToken() {
      calls += 1;
      return calls === 1 ? 'old-token' : 'new-token';
    },
    async refreshAfter401() {
      calls += 10;
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

  console.log('Smoke test passed: auth import, JWT parsing, refresh decisions, and 401 retry are correct.');
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
