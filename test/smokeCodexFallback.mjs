import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexConnectionManager.ts');
try {
  const { CodexConnectionManager } = loaded.exports;
  const manager = new CodexConnectionManager();
  const base = {
    baseURL: 'https://chatgpt.com/backend-api/codex',
    authIdentity: 'auth-a',
    accountId: 'acct-a',
    compatibilityProfile: 'codex',
    sessionId: 'session-a',
    threadId: 'thread-a'
  };
  manager.markHttpFallback(base);
  assertEqual(manager.isHttpFallback(base), true, 'failed session falls back');
  assertEqual(manager.isHttpFallback({ ...base, sessionId: 'session-b' }), false, 'new session retries websocket');
  assertEqual(manager.isHttpFallback({ ...base, authIdentity: 'auth-b' }), false, 'other auth unaffected');
  manager.dispose();
  console.log('Smoke test passed: HTTP fallback is scoped to one Codex session.');
} finally {
  await loaded.dispose();
}
