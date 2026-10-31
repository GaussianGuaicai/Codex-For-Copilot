import assert from 'node:assert/strict';
import { loadBundled } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/reasoningEffortSession.ts');
try {
  const { ReasoningEffortSessions } = loaded.exports;
  const pending = [];
  const sessions = new ReasoningEffortSessions((effort) => new Promise((resolve) => pending.push({ effort, resolve })));
  const context = (sessionId, taskId, effort, revision = 0, source = 'request', state = 'running') => ({
    protocolVersion: 1, sessionId, taskId, configuration: { reasoningEffort: effort }, revision, source, state
  });
  const a = context('a', 'turn-a', 'low');
  const b = context('b', 'turn-b', 'medium');
  assert.deepEqual(sessions.resolve('model', a, 'low'), { effort: 'low', live: true, sessionId: 'a' });
  assert.deepEqual(sessions.resolve('model', b, 'medium'), { effort: 'medium', live: true, sessionId: 'b' });
  const first = sessions.handleChange('model', context('a', 'turn-a', 'high', 1, 'user'));
  assert.equal(pending.length, 1, 'notification starts before another request');
  assert.equal(sessions.resolve('model', a, 'low').effort, 'low', 'unanswered consent never changes a request');
  pending[0].resolve('Apply to Current Task');
  await first;
  assert.equal(sessions.resolve('model', a, 'low').effort, 'high', 'stale options cannot undo confirmed effort');
  assert.equal(sessions.resolve('model', b, 'medium').effort, 'medium', 'same-model task B is isolated');
  await sessions.handleChange('model', context('a', 'turn-a', 'high', 1, 'user'));
  await sessions.handleChange('model', context('a', 'wrong-task', 'none', 2, 'user'));
  await sessions.handleChange('wrong-model', context('a', 'turn-a', 'none', 2, 'user'));
  assert.equal(pending.length, 1, 'duplicates and mismatched identities never prompt');
  const older = sessions.handleChange('model', context('a', 'turn-a', 'medium', 2, 'user'));
  const newer = sessions.handleChange('model', context('a', 'turn-a', 'none', 3, 'user'));
  pending[2].resolve('Future Tasks Only');
  pending[1].resolve('Apply to Current Task');
  await Promise.all([older, newer]);
  assert.equal(sessions.resolve('model', a, 'none').effort, 'high', 'late confirmation cannot overwrite a newer deferred choice');
  const closed = sessions.handleChange('model', context('a', 'turn-a', 'low', 4, 'user'));
  await sessions.handleChange('model', context('a', 'turn-a', 'low', 4, 'lifecycle', 'ended'));
  pending[3].resolve('Apply to Current Task');
  await closed;
  assert.equal(sessions.resolve('model', a, 'low').live, false, 'closed task cannot be resurrected by stale requests');
  const next = context('a', 'turn-new', 'medium');
  assert.equal(sessions.resolve('model', next, 'medium').effort, 'medium', 'next task gets a new selection');
  const disposed = sessions.handleChange('model', context('a', 'turn-new', 'none', 1, 'user'));
  sessions.dispose();
  pending[4].resolve('Apply to Current Task');
  await disposed;
  assert.deepEqual(sessions.resolve('model', undefined, 'low'), { effort: 'low', live: false }, 'stock VS Code keeps boundary-only behavior');
  assert.equal(sessions.resolve('model', { ...a, protocolVersion: 2 }, 'low').live, false, 'unknown bridge versions are ignored');
  console.log('Smoke test passed: immediate session consent, stale-option protection, lifecycle and concurrent session isolation.');
} finally {
  await loaded.dispose();
}
