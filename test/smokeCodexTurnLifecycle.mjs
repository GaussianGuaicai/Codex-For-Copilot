import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responseBranchStore.ts');
try {
  const { ResponseBranchStore } = loaded.exports;
  const store = new ResponseBranchStore();
  const envelope = { identityKey: 'scope' };
  const state = {
    identity: {
      installationId: 'installation',
      sessionId: 'session',
      threadId: 'thread',
      windowId: 'window'
    },
    turn: { id: 'turn-a', stickyState: 'opaque', startedAt: 1, completed: true },
    lastResponseItems: [{ type: 'reasoning' }],
    updatedAt: Date.now()
  };
  const initial = [{ type: 'message', role: 'user', content: 'hello' }];
  const branchId = store.recordSuccess(envelope, initial, 'resp-a', undefined, state);
  const toolContinuation = [...initial, { type: 'function_call_output', call_id: 'call', output: 'result' }];
  const toolMatch = store.findReusableBranch(envelope, toolContinuation);
  assertEqual(toolMatch.state.turn.id, 'turn-a', 'tool result keeps turn');
  assertEqual(toolMatch.state.turn.stickyState, 'opaque', 'tool result keeps sticky state');
  toolMatch.state.turn.stickyState = 'mutated';
  assertEqual(store.findReusableBranch(envelope, toolContinuation).state.turn.stickyState, 'opaque', 'state is safely cloned');
  const updated = { ...state, turn: { ...state.turn, completed: false }, updatedAt: Date.now() };
  store.recordSuccess(envelope, toolContinuation, 'resp-b', branchId, updated);
  const userContinuation = [...toolContinuation, { type: 'message', role: 'user', content: 'next' }];
  assertEqual(store.findReusableBranch(envelope, userContinuation).state.identity.threadId, 'thread', 'thread identity remains stable');
  console.log('Smoke test passed: branch state preserves thread/turn data across tool and user continuations.');
} finally {
  await loaded.dispose();
}
