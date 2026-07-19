import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexIdentity.ts');
try {
  const { CodexIdentityManager, inputStartsNewTurn } = loaded.exports;
  const values = new Map();
  const memento = {
    get(key) { return values.get(key); },
    async update(key, value) { values.set(key, value); }
  };
  const firstManager = new CodexIdentityManager(memento);
  const first = await firstManager.createThread();
  const secondManager = new CodexIdentityManager(memento);
  const second = await secondManager.createThread(first.threadId);
  assertEqual(second.installationId, first.installationId, 'installation persists');
  assertEqual(second.windowId === first.windowId, false, 'window rotates');
  assertEqual(second.parentThreadId, first.threadId, 'fork parent');
  assertEqual(firstManager.createNextTurn(first).turnId === first.turnId, false, 'turn rotates');
  assertEqual(inputStartsNewTurn([{ type: 'function_call_output' }]), false, 'tool continuation retains turn');
  assertEqual(inputStartsNewTurn([{ type: 'message', role: 'user' }]), true, 'user message starts turn');
  console.log('Smoke test passed: installation, window, thread, fork, and turn identity lifetimes are correct.');
} finally {
  await loaded.dispose();
}
