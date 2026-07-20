import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responseBranchStore.ts');
try {
  const { ResponseBranchStore } = loaded.exports;
  const store = new ResponseBranchStore();
  const envelope = {
    identityKey: 'scope',
    scopeKey: 'scope',
    requestFingerprint: 'fingerprint-a',
    effectiveInputBudget: 258400
  };
  const state = {
    identity: {
      installationId: 'installation',
      sessionId: 'session',
      threadId: 'thread',
      windowId: 'window'
    },
    turn: { id: 'turn-a', stickyState: 'opaque', startedAt: 1, completed: true },
    continuation: {
      fullRequest: {
        model: 'gpt-test',
        instructions: 'Smoke test instructions',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        stream: true,
        store: false
      },
      responseId: 'resp-a',
      responseItems: [{ type: 'reasoning' }],
      requestFingerprint: 'fingerprint-a',
      turnId: 'turn-a'
    },
    updatedAt: Date.now()
  };
  const initial = [{ type: 'message', role: 'user', content: 'hello' }];
  const branchId = store.recordSuccess(envelope, initial, 'resp-a', undefined, state);
  const toolContinuation = [...initial, { type: 'function_call_output', call_id: 'call', output: 'result' }];
  const toolMatch = store.findReusableBranch(envelope, toolContinuation);
  assertEqual(toolMatch.state.turn.id, 'turn-a', 'tool result keeps turn');
  assertEqual(toolMatch.state.turn.stickyState, 'opaque', 'tool result keeps sticky state');
  assertEqual(toolMatch.state.continuation.responseId, 'resp-a', 'tool result keeps continuation response id');
  toolMatch.state.turn.stickyState = 'mutated';
  toolMatch.state.continuation.responseItems[0].type = 'mutated';
  assertEqual(store.findReusableBranch(envelope, toolContinuation).state.turn.stickyState, 'opaque', 'state is safely cloned');
  assertEqual(store.findReusableBranch(envelope, toolContinuation).state.continuation.responseItems[0].type, 'reasoning', 'continuation snapshot is safely cloned');
  const updated = { ...state, turn: { ...state.turn, completed: false }, updatedAt: Date.now() };
  store.recordSuccess(envelope, toolContinuation, 'resp-b', branchId, updated);
  const userContinuation = [...toolContinuation, { type: 'message', role: 'user', content: 'next' }];
  assertEqual(store.findReusableBranch(envelope, userContinuation).state.identity.threadId, 'thread', 'thread identity remains stable');
  console.log('Smoke test passed: branch state preserves thread/turn data across tool and user continuations.');
} finally {
  await loaded.dispose();
}
