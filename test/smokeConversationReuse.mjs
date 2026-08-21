import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-reuse-'));
const compareBundlePath = join(tempDir, 'convertMessages.cjs');
const branchStoreBundlePath = join(tempDir, 'responseBranchStore.cjs');
const providerBundlePath = join(tempDir, 'provider.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);
const textEncoder = new TextEncoder();

class MockLanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class MockLanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }

  static image(data, mimeType) {
    return new MockLanguageModelDataPart(data, mimeType);
  }

  static text(value, mimeType = 'text/plain') {
    return new MockLanguageModelDataPart(textEncoder.encode(value), mimeType);
  }

}

class MockLanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class MockLanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

const vscodeStub = {
  LanguageModelTextPart: MockLanguageModelTextPart,
  LanguageModelDataPart: MockLanguageModelDataPart,
  LanguageModelToolResultPart: MockLanguageModelToolResultPart,
  LanguageModelToolCallPart: MockLanguageModelToolCallPart,
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
    System: 3
  },
  LanguageModelChatToolMode: {
    Required: 2
  }
};

await build({
  entryPoints: ['src/convertMessages.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: compareBundlePath,
  external: ['vscode']
});

await build({
  entryPoints: ['src/responseBranchStore.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: branchStoreBundlePath,
  external: ['vscode']
});

await build({
  entryPoints: ['src/provider.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: providerBundlePath,
  external: ['vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const {
  compareResponsesInputHistory,
  convertMessagesToResponsesInput,
  convertMessagesToResponsesInputWithStatefulMarker,
  stableSerialize
} = require(compareBundlePath);
const { ResponseBranchStore } = require(branchStoreBundlePath);
const { buildResponseBranchReuseEnvelope, buildResponseBranchToolSignatures, getReasoningEffort } = require(providerBundlePath);

try {
  runStableSerializeSmokeTest(stableSerialize);
  runReasoningEffortOptionSmokeTest(getReasoningEffort);
  runCompareHistorySmokeTest(compareResponsesInputHistory);
  runToolCallIdCanonicalizationSmokeTest(compareResponsesInputHistory);
  runLegacyRuntimeSystemConversionSmokeTest(convertMessagesToResponsesInput);
  runStatefulMarkerConversionSmokeTest(convertMessagesToResponsesInputWithStatefulMarker);
  runStatefulMarkerBranchStoreSmokeTest(ResponseBranchStore);
  runBranchStoreSmokeTest(ResponseBranchStore);
  runInputBudgetReuseSmokeTest(buildResponseBranchReuseEnvelope, ResponseBranchStore);
  runBranchStoreDisableReuseSmokeTest(ResponseBranchStore);
  runBranchStoreToolContinuationSmokeTest(ResponseBranchStore);
  runToolCompatibilitySmokeTest(buildResponseBranchReuseEnvelope, buildResponseBranchToolSignatures, ResponseBranchStore);
  runCacheControlToolResultSmokeTest(convertMessagesToResponsesInput, ResponseBranchStore);
  runDanglingToolCallSteerSmokeTest(convertMessagesToResponsesInput);
  runNamelessToolCallReplaySmokeTest(convertMessagesToResponsesInput);
  runImageToolResultSmokeTest(convertMessagesToResponsesInput);
  runImagePlaceholderReuseSmokeTest(compareResponsesInputHistory, convertMessagesToResponsesInput, ResponseBranchStore);
  runImageUriAnnotationReuseSmokeTest(compareResponsesInputHistory, convertMessagesToResponsesInput, ResponseBranchStore);

  console.log('Smoke tests passed: conversation reuse comparison and branch storage are correct.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function runStableSerializeSmokeTest(stableSerialize) {
  const left = stableSerialize({ b: 2, a: { d: 4, c: 3 } });
  const right = stableSerialize({ a: { c: 3, d: 4 }, b: 2 });
  assertEqual(left, right, 'stable serialization');
}

function runReasoningEffortOptionSmokeTest(getReasoningEffort) {
  const modelDefault = 'high';
  const noDefault = undefined;

  assertReasoningEffort(
    getReasoningEffort(modelDefault, { modelOptions: { thinking: 'medium' } }, noDefault),
    'medium',
    'modelOptions.thinking',
    false,
    'direct thinking option overrides model default'
  );
  assertReasoningEffort(
    getReasoningEffort(modelDefault, { modelOptions: { thinking: { effort: 'low' } } }, noDefault),
    'low',
    'modelOptions.thinking.effort',
    false,
    'nested thinking option overrides model default'
  );
  assertReasoningEffort(
    getReasoningEffort(modelDefault, { modelOptions: { thinkingEffort: 'medium' } }, noDefault),
    'medium',
    'modelOptions.thinkingEffort',
    false,
    'thinking effort option overrides model default'
  );
  assertReasoningEffort(
    getReasoningEffort(modelDefault, {
      modelConfiguration: { reasoningEffort: 'low' },
      modelOptions: { thinking: 'medium' }
    }, noDefault),
    'medium',
    'modelOptions.thinking',
    true,
    'request-level thinking option overrides a stale model configuration'
  );
  assertReasoningEffort(
    getReasoningEffort(modelDefault, {}, 'low'),
    'low',
    'default',
    false,
    'configured default overrides model default'
  );
}

function assertReasoningEffort(actual, effort, source, hasExplicitConflict, label) {
  assertEqual(actual.effort, effort, `${label} effort`);
  assertEqual(actual.source, source, `${label} source`);
  assertEqual(actual.hasExplicitConflict, hasExplicitConflict, `${label} conflict state`);
}

function runCompareHistorySmokeTest(compareResponsesInputHistory) {
  const previousInput = [
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'assistant', content: 'previous-sensitive-content' }
  ];
  const appendInput = [...previousInput, { type: 'message', role: 'user', content: 'continue' }];
  const forkInput = [
    previousInput[0],
    { type: 'message', role: 'assistant', content: 'current-sensitive-content' }
  ];

  const appendComparison = compareResponsesInputHistory(previousInput, appendInput);
  assertEqual(appendComparison.kind, 'append', 'append comparison kind');
  assertEqual(appendComparison.matchedPrefixCount, previousInput.length, 'append matched prefix count');
  assertEqual(JSON.stringify(appendComparison.appendedInput), JSON.stringify([appendInput[2]]), 'append delta');

  const forkComparison = compareResponsesInputHistory(previousInput, forkInput);
  assertEqual(forkComparison.kind, 'fork', 'fork comparison kind');
  assertEqual(forkComparison.matchedPrefixCount, 1, 'fork matched prefix count');
  assertEqual(
    JSON.stringify(forkComparison.mismatch).includes('previous-sensitive-content'),
    false,
    'fork previous mismatch summary redacts content'
  );
  assertEqual(
    JSON.stringify(forkComparison.mismatch).includes('current-sensitive-content'),
    false,
    'fork current mismatch summary redacts content'
  );
  assertEqual(JSON.parse(forkComparison.mismatch?.previousItemSummary ?? '{}').type, 'message', 'fork summary item type');
  assertEqual(JSON.parse(forkComparison.mismatch?.currentItemSummary ?? '{}').role, 'assistant', 'fork summary item role');
}

function runToolCallIdCanonicalizationSmokeTest(compareResponsesInputHistory) {
  const previousInput = [
    { type: 'message', role: 'user', content: 'find files' },
    { type: 'function_call', call_id: 'call_prev_1', name: 'list_dir', arguments: '{"path":"src"}' },
    { type: 'function_call_output', call_id: 'call_prev_1', output: '["a.ts","b.ts"]' },
    { type: 'message', role: 'assistant', content: 'I found two files.' }
  ];
  const currentInput = [
    { type: 'message', role: 'user', content: 'find files' },
    { type: 'function_call', call_id: 'call_replayed_9', name: 'list_dir', arguments: '{"path":"src"}' },
    { type: 'function_call_output', call_id: 'call_replayed_9', output: '["a.ts","b.ts"]' },
    { type: 'message', role: 'assistant', content: 'I found two files.' },
    { type: 'message', role: 'user', content: 'continue' }
  ];

  const comparison = compareResponsesInputHistory(previousInput, currentInput);
  assertEqual(comparison.kind, 'append', 'call id drift comparison kind');
  assertEqual(comparison.matchedPrefixCount, previousInput.length, 'call id drift matched prefix count');
  assertEqual(JSON.stringify(comparison.appendedInput), JSON.stringify([currentInput[4]]), 'call id drift delta');
}

function runLegacyRuntimeSystemConversionSmokeTest(convertMessagesToResponsesInput) {
  const converted = convertMessagesToResponsesInput([{
    role: vscodeStub.LanguageModelChatMessageRole.System,
    content: [new vscodeStub.LanguageModelTextPart('Runtime instructions')]
  }]);
  assertEqual(JSON.stringify(converted), JSON.stringify([{
    role: 'assistant',
    content: 'Runtime instructions',
    type: 'message'
  }]), 'legacy conversion remains unchanged before provider marker integration');
}

function runStatefulMarkerConversionSmokeTest(convertMessagesToResponsesInputWithStatefulMarker) {
  const official = convertMessagesToResponsesInputWithStatefulMarker([
    {
      role: vscodeStub.LanguageModelChatMessageRole.Assistant,
      content: [vscodeStub.LanguageModelDataPart.text('codex::gpt-5.6-sol\\resp_official', 'Stateful_Marker')]
    },
    {
      role: vscodeStub.LanguageModelChatMessageRole.System,
      content: [new vscodeStub.LanguageModelTextPart(' Runtime Agent instructions. ')]
    },
    {
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [new vscodeStub.LanguageModelTextPart('Only this delta')]
    }
  ]);
  assertEqual(official.statefulMarker.kind, 'valid', 'official marker is valid');
  assertEqual(official.statefulMarker.modelId, 'codex::gpt-5.6-sol', 'official marker model id');
  assertEqual(official.statefulMarker.previousResponseId, 'resp_official', 'official marker response id');
  assertEqual(official.statefulMarker.isLeadingStandalone, true, 'official marker is a leading standalone anchor');
  assertEqual(official.systemInstructions, 'Runtime Agent instructions.', 'runtime System instructions are extracted');
  assertEqual(JSON.stringify(official.input), JSON.stringify([
    { role: 'user', content: 'Only this delta', type: 'message' }
  ]), 'System and marker are excluded from current input');
  assertEqual(JSON.stringify(official.statefulMarker.incrementalInput), JSON.stringify(official.input), 'official delta equals sanitized input');

  const firstDelimiter = convertMessagesToResponsesInputWithStatefulMarker([{
    role: vscodeStub.LanguageModelChatMessageRole.Assistant,
    content: [vscodeStub.LanguageModelDataPart.text('model-a\\resp\\with-delimiter', 'stateful_marker')]
  }]);
  assertEqual(firstDelimiter.statefulMarker.modelId, 'model-a', 'marker model ends at first delimiter');
  assertEqual(firstDelimiter.statefulMarker.previousResponseId, 'resp\\with-delimiter', 'marker response id retains later delimiters');

  const sameMessageRemainder = convertMessagesToResponsesInputWithStatefulMarker([
    {
      role: vscodeStub.LanguageModelChatMessageRole.Assistant,
      content: [
        vscodeStub.LanguageModelDataPart.text('model-a\\resp_same_message', 'stateful_marker'),
        new vscodeStub.LanguageModelTextPart('assistant delta')
      ]
    },
    {
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [new vscodeStub.LanguageModelTextPart('later delta')]
    }
  ]);
  assertEqual(JSON.stringify(sameMessageRemainder.statefulMarker.incrementalInput), JSON.stringify([
    { role: 'assistant', content: 'assistant delta', type: 'message' },
    { role: 'user', content: 'later delta', type: 'message' }
  ]), 'structural delta includes the marker message remainder and later messages');

  const invalidMarkers = [
    vscodeStub.LanguageModelDataPart.text('missing-delimiter', 'stateful_marker'),
    vscodeStub.LanguageModelDataPart.text('\\resp_empty_model', 'stateful_marker'),
    vscodeStub.LanguageModelDataPart.text('model-empty-response\\', 'stateful_marker'),
    new vscodeStub.LanguageModelDataPart(new Uint8Array([0xc3, 0x28]), 'stateful_marker'),
    new vscodeStub.LanguageModelDataPart(new Uint8Array(4097), 'stateful_marker'),
    vscodeStub.LanguageModelDataPart.text(`${'m'.repeat(513)}\\resp_large_model`, 'stateful_marker'),
    vscodeStub.LanguageModelDataPart.text(`model-large-response\\${'r'.repeat(513)}`, 'stateful_marker'),
    vscodeStub.LanguageModelDataPart.text('model-control\u0001\\resp_control', 'stateful_marker'),
    vscodeStub.LanguageModelDataPart.text('model-whitespace\\ resp_whitespace', 'stateful_marker')
  ];
  for (const [index, marker] of invalidMarkers.entries()) {
    const converted = convertMessagesToResponsesInputWithStatefulMarker([{
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [
        new vscodeStub.LanguageModelTextPart('safe'),
        marker,
        new vscodeStub.LanguageModelTextPart(' input')
      ]
    }]);
    assertEqual(converted.statefulMarker.kind, 'invalid', `invalid marker ${index} fails closed`);
    assertEqual(converted.statefulMarker.reason, 'metadata', `invalid marker ${index} metadata reason`);
    assertEqual(converted.statefulMarker.isLeadingStandalone, false, `invalid marker ${index} is embedded`);
    assertEqual(JSON.stringify(converted.input), JSON.stringify([
      { role: 'user', content: 'safe input', type: 'message' }
    ]), `invalid marker ${index} is stripped`);
  }

  const duplicate = convertMessagesToResponsesInputWithStatefulMarker([{
    role: vscodeStub.LanguageModelChatMessageRole.Assistant,
    content: [
      vscodeStub.LanguageModelDataPart.text('model-one\\resp_one', 'stateful_marker'),
      vscodeStub.LanguageModelDataPart.text('model-two\\resp_two', 'STATEFUL_MARKER')
    ]
  }]);
  assertEqual(duplicate.statefulMarker.kind, 'invalid', 'duplicate markers fail closed');
  assertEqual(duplicate.statefulMarker.reason, 'multiple', 'duplicate markers report multiple');
  assertEqual(duplicate.statefulMarker.isLeadingStandalone, true, 'duplicate leading anchor is classified for local failure');
  assertEqual(JSON.stringify(duplicate.input), '[]', 'duplicate markers are stripped');

  const nested = convertMessagesToResponsesInputWithStatefulMarker([{
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [new vscodeStub.LanguageModelToolResultPart('call_nested_marker', [
      vscodeStub.LanguageModelDataPart.text('model-nested\\resp_nested', 'stateful_marker'),
      new vscodeStub.LanguageModelTextPart('safe tool output')
    ])]
  }]);
  assertEqual(nested.statefulMarker.kind, 'none', 'nested marker never anchors');
  assertEqual(JSON.stringify(nested.input), JSON.stringify([
    { type: 'function_call_output', call_id: 'call_nested_marker', output: 'safe tool output' }
  ]), 'nested marker is suppressed from tool output');
}

function runStatefulMarkerBranchStoreSmokeTest(ResponseBranchStore) {
  const envelope = reuseEnvelope('reuse-key-marker');
  const previousInput = [{ type: 'message', role: 'user', content: 'seed' }];
  const currentInput = [{ type: 'message', role: 'user', content: 'follow up' }];
  const store = createTestResponseBranchStore(ResponseBranchStore);
  const branchId = store.recordSuccess(envelope, previousInput, 'resp_marker_exact');
  const exactMatch = store.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_marker_exact',
    incrementalInput: currentInput
  });
  assertEqual(exactMatch?.branchId, branchId, 'exact marker branch id');
  assertEqual(exactMatch?.responseId, 'resp_marker_exact', 'exact marker response id');
  assertEqual(exactMatch?.comparison.matchedPrefixCount, 0, 'marker lookup does not require historical prefix');
  assertEqual(JSON.stringify(exactMatch?.comparison.appendedInput), JSON.stringify(currentInput), 'exact marker returns complete delta');

  const continuedBranchId = store.recordSuccess(
    envelope,
    currentInput,
    'resp_marker_continued',
    branchId,
    createCompletedBranchState(envelope, currentInput, 'resp_marker_continued')
  );
  assertEqual(continuedBranchId === branchId, false, 'continuation creates a new immutable marker anchor');
  assertEqual(store.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_marker_exact',
    incrementalInput: currentInput
  })?.branchId, branchId, 'older emitted marker remains reusable after continuation');
  const siblingInput = [{ type: 'message', role: 'user', content: 'sibling follow up' }];
  const siblingBranchId = store.recordSuccess(
    envelope,
    siblingInput,
    'resp_marker_sibling',
    branchId,
    createCompletedBranchState(envelope, siblingInput, 'resp_marker_sibling')
  );
  assertEqual(siblingBranchId === branchId || siblingBranchId === continuedBranchId, false, 'same-anchor sibling continuation gets an independent branch');
  assertEqual(store.findReusableBranch(envelope, siblingInput, {
    responseId: 'resp_marker_exact',
    incrementalInput: siblingInput
  })?.branchId, branchId, 'source marker survives sibling continuation recording');
  const nextInput = [{ type: 'message', role: 'user', content: 'continue from child' }];
  assertEqual(store.findReusableBranch(envelope, nextInput, {
    responseId: 'resp_marker_continued',
    incrementalInput: nextInput
  })?.branchId, continuedBranchId, 'new continuation marker resolves independently');

  const alternateInput = [{ type: 'message', role: 'user', content: 'alternate seed' }];
  store.recordSuccess(envelope, alternateInput, 'resp_marker_alternate');
  assertEqual(store.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_unknown',
    incrementalInput: currentInput
  }), undefined, 'unknown marker id never falls through');
  assertEqual(store.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_marker_exact',
    incrementalInput: [{ type: 'message', role: 'user', content: 'different delta' }]
  }), undefined, 'marker suffix mismatch never falls through');

  const compatibilityCases = [
    { label: 'request envelope mismatch', envelope: { ...envelope, identityKey: 'changed-identity', requestFingerprint: 'changed-fingerprint' } },
    { label: 'instruction mismatch', envelope: { ...envelope, identityKey: 'changed-instructions', requestFingerprint: 'changed-instructions' } },
    { label: 'catalog mismatch', envelope: { ...envelope, catalogHash: 'changed-catalog' } },
    { label: 'tool plan mismatch', envelope: { ...envelope, toolPlanMode: 'native-hosted' } },
    { label: 'tool mismatch', envelope: { ...envelope, toolSignatures: { read_file: 'changed-tool' } } },
    { label: 'budget downgrade', envelope: { ...envelope, effectiveInputBudget: 128000 } }
  ];
  for (const compatibilityCase of compatibilityCases) {
    assertEqual(store.findReusableBranch(compatibilityCase.envelope, currentInput, {
      responseId: 'resp_marker_exact',
      incrementalInput: currentInput
    }), undefined, `${compatibilityCase.label} rejects an exact marker`);
  }

  store.disableReuse(envelope, false);
  assertEqual(store.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_marker_exact',
    incrementalInput: currentInput
  }), undefined, 'disabled reuse rejects an exact marker');

  const expiredStore = new ResponseBranchStore(0);
  expiredStore.recordSuccess(
    envelope,
    previousInput,
    'resp_marker_expired',
    undefined,
    createCompletedBranchState(envelope, previousInput, 'resp_marker_expired')
  );
  const originalNow = Date.now;
  Date.now = () => originalNow() + 1;
  try {
    assertEqual(expiredStore.findReusableBranch(envelope, currentInput, {
      responseId: 'resp_marker_expired',
      incrementalInput: currentInput
    }), undefined, 'expired exact marker fails closed');
  } finally {
    Date.now = originalNow;
  }

  const incompleteStore = new ResponseBranchStore();
  const incompleteState = createCompletedBranchState(envelope, previousInput, 'resp_marker_incomplete');
  incompleteState.turn.completed = false;
  incompleteStore.recordSuccess(envelope, previousInput, 'resp_marker_incomplete', undefined, incompleteState);
  assertEqual(incompleteStore.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_marker_incomplete',
    incrementalInput: currentInput
  }), undefined, 'incomplete turn rejects an exact marker');

  const missingSnapshotStore = new ResponseBranchStore();
  const missingSnapshotState = createCompletedBranchState(envelope, previousInput, 'resp_marker_missing_snapshot');
  delete missingSnapshotState.continuation;
  missingSnapshotStore.recordSuccess(envelope, previousInput, 'resp_marker_missing_snapshot', undefined, missingSnapshotState);
  assertEqual(missingSnapshotStore.findReusableBranch(envelope, currentInput, {
    responseId: 'resp_marker_missing_snapshot',
    incrementalInput: currentInput
  }), undefined, 'missing continuation snapshot rejects an exact marker');

  const malformedFingerprintEnvelope = {
    ...envelope,
    identityKey: 'reuse-key-marker-malformed-fingerprint',
    requestFingerprint: JSON.stringify({ requestFingerprint: fingerprintFullRequest() })
  };
  const malformedFingerprintStore = new ResponseBranchStore();
  malformedFingerprintStore.recordSuccess(
    malformedFingerprintEnvelope,
    previousInput,
    'resp_marker_malformed_fingerprint',
    undefined,
    createCompletedBranchState(
      malformedFingerprintEnvelope,
      previousInput,
      'resp_marker_malformed_fingerprint'
    )
  );
  assertEqual(malformedFingerprintStore.findReusableBranch(malformedFingerprintEnvelope, currentInput, {
    responseId: 'resp_marker_malformed_fingerprint',
    incrementalInput: currentInput
  }), undefined, 'malformed protocol fingerprint wrapper rejects an exact marker');

  const pendingStore = createTestResponseBranchStore(ResponseBranchStore);
  const pendingEnvelope = reuseEnvelope('reuse-key-marker-pending');
  const pendingItems = [
    { type: 'function_call', call_id: 'call_pending_one', name: 'read_file', arguments: '{}' },
    { type: 'function_call', call_id: 'call_pending_two', name: 'list_dir', arguments: '{}' }
  ];
  pendingStore.recordSuccess(
    pendingEnvelope,
    previousInput,
    'resp_marker_pending',
    undefined,
    createCompletedBranchState(pendingEnvelope, previousInput, 'resp_marker_pending', pendingItems)
  );
  const completeOutputs = [
    { type: 'function_call_output', call_id: 'call_pending_one', output: 'one' },
    { type: 'function_call_output', call_id: 'call_pending_two', output: 'two' }
  ];
  assertEqual(pendingStore.findReusableBranch(pendingEnvelope, completeOutputs, {
    responseId: 'resp_marker_pending',
    incrementalInput: completeOutputs
  })?.responseId, 'resp_marker_pending', 'exact marker accepts complete pending-call outputs');
  const noOutputs = [{ type: 'message', role: 'user', content: 'skip the calls' }];
  assertEqual(pendingStore.findReusableBranch(pendingEnvelope, noOutputs, {
    responseId: 'resp_marker_pending',
    incrementalInput: noOutputs
  }), undefined, 'exact marker rejects unanswered pending calls');
  assertEqual(pendingStore.findReusableBranch(pendingEnvelope, [completeOutputs[0]], {
    responseId: 'resp_marker_pending',
    incrementalInput: [completeOutputs[0]]
  }), undefined, 'exact marker rejects partial pending-call outputs');
}

function runBranchStoreSmokeTest(ResponseBranchStore) {
  const store = createTestResponseBranchStore(ResponseBranchStore);
  const envelope = reuseEnvelope('reuse-key-a');
  const toolChangedEnvelope = reuseEnvelope('reuse-key-b');
  const previousInput = [
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'assistant', content: 'hi' }
  ];
  const appendInput = [...previousInput, { type: 'message', role: 'user', content: 'continue' }];
  const forkInput = [
    previousInput[0],
    { type: 'message', role: 'assistant', content: 'different' }
  ];

  const branchId = store.recordSuccess(envelope, previousInput, 'resp_1');
  const reusableMatch = store.findReusableBranch(envelope, appendInput);
  assertEqual(reusableMatch?.branchId, branchId, 'reusable branch id');
  assertEqual(reusableMatch?.responseId, 'resp_1', 'reusable previous response id');
  assertEqual(JSON.stringify(reusableMatch?.comparison.appendedInput ?? []), JSON.stringify([appendInput[2]]), 'reusable delta input');

  const toolChangedMatch = store.findReusableBranch(toolChangedEnvelope, appendInput);
  assertEqual(toolChangedMatch, undefined, 'tool change busts reuse');

  const forkMatch = store.findReusableBranch(envelope, forkInput);
  assertEqual(forkMatch, undefined, 'fork does not reuse previous branch');
}

function runInputBudgetReuseSmokeTest(buildResponseBranchReuseEnvelope, ResponseBranchStore) {
  const baseOptions = {
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    authIdentity: 'codexAuth:acct-budget',
    compatibilityEnabled: true,
    model: 'gpt-5.4',
    instructions: 'Budget reuse smoke',
    store: false,
    omitMaxOutputTokens: true,
    maxOutputTokens: 1024,
    textVerbosity: 'medium',
    includeEncryptedReasoning: true
  };
  const standard = buildResponseBranchReuseEnvelope({ ...baseOptions, effectiveInputBudget: 258400 });
  const long = buildResponseBranchReuseEnvelope({ ...baseOptions, effectiveInputBudget: 950000 });
  const legacy = buildResponseBranchReuseEnvelope(baseOptions);
  const previousInput = [{ type: 'message', role: 'user', content: 'hello' }];
  const appendInput = [...previousInput, { type: 'message', role: 'user', content: 'continue' }];

  assertEqual(standard.requestFingerprint, long.requestFingerprint, 'local budget stays out of request fingerprint');
  assertEqual(standard.identityKey, long.identityKey, 'local budget stays out of reuse identity');

  const upgradeStore = createTestResponseBranchStore(ResponseBranchStore);
  upgradeStore.recordSuccess(standard, previousInput, 'resp_standard');
  assertEqual(upgradeStore.findReusableBranch(standard, appendInput)?.responseId, 'resp_standard', 'same budget reuses branch');
  assertEqual(upgradeStore.findReusableBranch(long, appendInput)?.responseId, 'resp_standard', 'larger budget reuses smaller-budget branch');

  const downgradeStore = createTestResponseBranchStore(ResponseBranchStore);
  downgradeStore.recordSuccess(long, previousInput, 'resp_long');
  assertEqual(downgradeStore.findReusableBranch(standard, appendInput), undefined, 'smaller budget rejects larger-budget branch');
  const downgradeDiagnostic = downgradeStore.explainReuseMiss(standard, appendInput);
  assertEqual(downgradeDiagnostic?.inputBudgetCompatible, false, 'downgrade diagnostic reports incompatible budget');
  assertEqual(downgradeDiagnostic?.previousEffectiveInputBudget, 950000, 'downgrade diagnostic reports stored budget');
  assertEqual(downgradeDiagnostic?.currentEffectiveInputBudget, 258400, 'downgrade diagnostic reports target budget');

  const legacyStore = createTestResponseBranchStore(ResponseBranchStore);
  legacyStore.recordSuccess(legacy, previousInput, 'resp_legacy');
  assertEqual(legacyStore.findReusableBranch(standard, appendInput), undefined, 'missing legacy budget fails closed');
}

function runBranchStoreDisableReuseSmokeTest(ResponseBranchStore) {
  const store = createTestResponseBranchStore(ResponseBranchStore);
  const envelope = reuseEnvelope('reuse-key-disabled');
  const previousInput = [
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'assistant', content: 'hi' }
  ];
  const appendInput = [...previousInput, { type: 'message', role: 'user', content: 'continue' }];
  const secondAppendInput = [...appendInput, { type: 'message', role: 'user', content: 'one more step' }];

  store.recordSuccess(envelope, previousInput, 'resp_missing_anchor');
  store.recordSuccess(envelope, appendInput, 'resp_duplicate_missing_anchor');

  store.disableReuse(envelope);
  assertEqual(store.findReusableBranch(envelope, secondAppendInput), undefined, 'disabled reuse bypasses continuation anchor');

  store.invalidateResponseId('resp_missing_anchor');
  store.invalidateResponseId('resp_duplicate_missing_anchor');
  store.recordSuccess(envelope, appendInput, 'resp_recovered_anchor');

  const recoveredMatch = store.findReusableBranch(envelope, secondAppendInput);
  assertEqual(recoveredMatch?.responseId, 'resp_recovered_anchor', 'full-input success re-enables reuse with a fresh anchor');
}

function runBranchStoreToolContinuationSmokeTest(ResponseBranchStore) {
  const store = createTestResponseBranchStore(ResponseBranchStore);
  const envelope = reuseEnvelope('reuse-key-tool-continuation');
  const previousInput = [
    { type: 'message', role: 'user', content: 'Find the file that handles auth.' },
    { type: 'message', role: 'assistant', content: 'I will inspect the source tree.' },
    { type: 'function_call', call_id: 'call_prev_1', name: 'list_dir', arguments: '{"path":"src"}' },
    { type: 'function_call_output', call_id: 'call_prev_1', output: '["config.ts","secrets.ts"]' }
  ];
  const currentInput = [
    { type: 'message', role: 'user', content: 'Find the file that handles auth.' },
    { type: 'message', role: 'assistant', content: 'I will inspect the source tree and then open the auth file.' },
    { type: 'function_call', call_id: 'call_replayed_1', name: 'list_dir', arguments: '{"path":"src"}' },
    { type: 'function_call_output', call_id: 'call_replayed_1', output: '["config.ts","secrets.ts"]' },
    { type: 'message', role: 'assistant', content: 'Now I will read the auth implementation.' },
    { type: 'function_call', call_id: 'call_replayed_2', name: 'read_file', arguments: '{"filePath":"src/secrets.ts"}' },
    { type: 'function_call_output', call_id: 'call_replayed_2', output: 'export async function getApiCredentials() {}' }
  ];

  const branchId = store.recordSuccess(envelope, previousInput, 'resp_tool_step_1');
  const reusableMatch = store.findReusableBranch(envelope, currentInput);
  assertEqual(reusableMatch?.branchId, branchId, 'tool continuation branch id');
  assertEqual(reusableMatch?.responseId, 'resp_tool_step_1', 'tool continuation previous response id');
  assertEqual(
    JSON.stringify(reusableMatch?.comparison.appendedInput ?? []),
    JSON.stringify([
      { type: 'function_call_output', call_id: 'call_replayed_2', output: 'export async function getApiCredentials() {}' }
    ]),
    'tool continuation delta'
  );
}

function runToolCompatibilitySmokeTest(buildResponseBranchReuseEnvelope, buildResponseBranchToolSignatures, ResponseBranchStore) {
  const baseOptions = {
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    authIdentity: 'codexAuth:acct-test',
    compatibilityEnabled: true,
    model: 'gpt-5.4-mini',
    instructions: 'You are a helpful coding assistant integrated with VS Code.',
    reasoning: { effort: 'high' },
    toolMode: 1,
    serviceTier: 'default',
    store: false,
    omitMaxOutputTokens: false,
    maxOutputTokens: 1024,
    textVerbosity: 'medium',
    includeEncryptedReasoning: true
  };
  const previousInput = [
    { type: 'message', role: 'user', content: 'Inspect the repo.' }
  ];
  const currentInput = [
    ...previousInput,
    { type: 'message', role: 'user', content: 'Now continue.' }
  ];
  const previousTools = [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
    { name: 'list_dir', description: 'List a directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
  ];
  const currentToolsWithAddition = [
    { name: 'run_in_terminal', description: 'Run a shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'list_dir', description: 'List a directory', inputSchema: { properties: { path: { type: 'string' } }, type: 'object' } },
    { name: 'read_file', description: 'Read a file', inputSchema: { properties: { filePath: { type: 'string' } }, type: 'object' } }
  ];
  const currentToolsWithChange = [
    { name: 'list_dir', description: 'List a directory recursively', inputSchema: { properties: { path: { type: 'string' } }, type: 'object' } },
    { name: 'read_file', description: 'Read a file', inputSchema: { properties: { filePath: { type: 'string' } }, type: 'object' } }
  ];
  const currentToolsWithRemoval = [
    { name: 'read_file', description: 'Read a file', inputSchema: { properties: { filePath: { type: 'string' } }, type: 'object' } }
  ];

  const left = buildResponseBranchReuseEnvelope({
    ...baseOptions,
    tools: previousTools
  });

  const right = buildResponseBranchReuseEnvelope({
    ...baseOptions,
    tools: currentToolsWithAddition
  });

  assertEqual(left.identityKey === right.identityKey, false, 'tool catalog busts the semantic request fingerprint');

  const store = createTestResponseBranchStore(ResponseBranchStore);
  store.recordSuccess(left, previousInput, 'resp_tool_catalog_base');
  const additiveMatch = store.findReusableBranch(right, currentInput);
  assertEqual(additiveMatch, undefined, 'added tool busts reuse');
  const additiveDiagnostic = store.explainReuseMiss(right, currentInput);
  assertEqual(additiveDiagnostic?.toolCompatibility?.addedToolNames.length, 1, 'added tool diagnostic count');
  assertEqual(additiveDiagnostic?.toolCompatibility?.addedToolNames[0], 'run_in_terminal', 'added tool diagnostic name');

  const changedMatch = store.findReusableBranch(reuseEnvelope(left.identityKey, buildResponseBranchToolSignatures(currentToolsWithChange)), currentInput);
  assertEqual(changedMatch, undefined, 'changed existing tool busts reuse');

  const removedMatch = store.findReusableBranch(reuseEnvelope(left.identityKey, buildResponseBranchToolSignatures(currentToolsWithRemoval)), currentInput);
  assertEqual(removedMatch, undefined, 'removed existing tool busts reuse');

  const changedServiceTier = buildResponseBranchReuseEnvelope({
    ...baseOptions,
    tools: previousTools,
    serviceTier: 'priority'
  });
  const changedOutputCap = buildResponseBranchReuseEnvelope({
    ...baseOptions,
    tools: previousTools,
    maxOutputTokens: 2048
  });
  assertEqual(left.identityKey === changedServiceTier.identityKey, false, 'service tier changes the semantic request fingerprint');
  assertEqual(left.identityKey === changedOutputCap.identityKey, false, 'output cap changes the semantic request fingerprint');
  assertEqual(store.findReusableBranch(changedServiceTier, currentInput), undefined, 'service tier change busts reuse');
  assertEqual(store.findReusableBranch(changedOutputCap, currentInput), undefined, 'output cap change busts reuse');
}

function runCacheControlToolResultSmokeTest(convertMessagesToResponsesInput, ResponseBranchStore) {
  const toolResultWithCacheControl = {
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_asset', [
        new vscodeStub.LanguageModelTextPart('codex-for-copilot.png'),
        new vscodeStub.LanguageModelDataPart(new Uint8Array([123, 125]), 'cache_control')
      ])
    ]
  };
  const toolResultWithoutCacheControl = {
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_asset', [
        new vscodeStub.LanguageModelTextPart('codex-for-copilot.png')
      ])
    ]
  };

  const convertedWithCacheControl = convertMessagesToResponsesInput([toolResultWithCacheControl]);
  const convertedWithoutCacheControl = convertMessagesToResponsesInput([toolResultWithoutCacheControl]);
  assertEqual(
    JSON.stringify(convertedWithCacheControl),
    JSON.stringify(convertedWithoutCacheControl),
    'cache_control does not affect tool result serialization'
  );

  const store = createTestResponseBranchStore(ResponseBranchStore);
  const envelope = reuseEnvelope('reuse-key-cache-control');
  const previousInput = [
    { type: 'message', role: 'user', content: 'Show me the asset name.' },
    convertedWithCacheControl[0]
  ];
  const currentInput = [
    { type: 'message', role: 'user', content: 'Show me the asset name.' },
    convertedWithoutCacheControl[0],
    { type: 'message', role: 'user', content: 'Continue.' }
  ];

  store.recordSuccess(envelope, previousInput, 'resp_cache_control');
  const reusableMatch = store.findReusableBranch(envelope, currentInput);
  assertEqual(reusableMatch?.responseId, 'resp_cache_control', 'cache_control reuse previous response id');
  assertEqual(reusableMatch?.comparison.kind, 'append', 'cache_control reuse comparison kind');
}

function runDanglingToolCallSteerSmokeTest(convertMessagesToResponsesInput) {
  const steeredMessages = [
    {
      role: vscodeStub.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscodeStub.LanguageModelTextPart('I will inspect the file.'),
        new vscodeStub.LanguageModelToolCallPart('call_interrupted', 'read_file', { filePath: 'src/provider.ts' })
      ]
    },
    {
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [new vscodeStub.LanguageModelTextPart('Actually, ignore that and explain the config first.')]
    }
  ];

  const converted = convertMessagesToResponsesInput(steeredMessages);
  assertEqual(converted.some((item) => item.type === 'function_call'), false, 'dangling tool call is not replayed as a protocol function_call');
  assertEqual(
    JSON.stringify(converted),
    JSON.stringify([
      { role: 'assistant', content: 'I will inspect the file.', type: 'message' },
      {
        role: 'assistant',
        content: 'The previous assistant turn was interrupted before tool execution. It had prepared a call to read_file with arguments {"filePath":"src/provider.ts"}, but no tool output was produced.',
        type: 'message'
      },
      { role: 'user', content: 'Actually, ignore that and explain the config first.', type: 'message' }
    ]),
    'steered transcript preserves interrupted tool intent as assistant context'
  );
}

function runNamelessToolCallReplaySmokeTest(convertMessagesToResponsesInput) {
  const corruptedMessages = [
    {
      role: vscodeStub.LanguageModelChatMessageRole.Assistant,
      content: [new vscodeStub.LanguageModelToolCallPart('call_nameless', '', { number: 10 })]
    },
    {
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [new vscodeStub.LanguageModelToolResultPart('call_nameless', [
        new vscodeStub.LanguageModelTextPart('Pull request details.')
      ])]
    },
    {
      role: vscodeStub.LanguageModelChatMessageRole.User,
      content: [new vscodeStub.LanguageModelTextPart('Continue from the available conversation context.')]
    }
  ];

  const converted = convertMessagesToResponsesInput(corruptedMessages);
  assertEqual(JSON.stringify(converted), JSON.stringify([
    {
      role: 'user',
      content: 'Continue from the available conversation context.',
      type: 'message'
    }
  ]), 'nameless tool calls and their outputs are not replayed as invalid protocol items');
}

function runImageToolResultSmokeTest(convertMessagesToResponsesInput) {
  const imageBytes = new Uint8Array([1, 2, 3, 4]);
  const imageMessage = {
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_image', [
        vscodeStub.LanguageModelDataPart.image(imageBytes, 'image/png')
      ])
    ]
  };

  const convertedImageResult = convertMessagesToResponsesInput([imageMessage]);
  assertEqual(convertedImageResult.length, 1, 'image tool result item count');
  assertEqual(convertedImageResult[0].type, 'function_call_output', 'image tool result item type');
  assertEqual(convertedImageResult[0].call_id, 'call_image', 'image tool result call id');
  assertEqual(convertedImageResult[0].output[0].type, 'input_image', 'image tool result content type');
  assertEqual(convertedImageResult[0].output[0].image_url, 'data:image/png;base64,AQIDBA==', 'image tool result data url');

  const dataUrlMessage = {
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_data_url', [
        new vscodeStub.LanguageModelTextPart('data:image/png;base64,AQIDBA==')
      ])
    ]
  };

  const convertedDataUrlResult = convertMessagesToResponsesInput([dataUrlMessage]);
  assertEqual(convertedDataUrlResult[0].output[0].type, 'input_image', 'data url tool result content type');
  assertEqual(convertedDataUrlResult[0].output[0].image_url, 'data:image/png;base64,AQIDBA==', 'data url tool result content value');
}

function runImagePlaceholderReuseSmokeTest(compareResponsesInputHistory, convertMessagesToResponsesInput, ResponseBranchStore) {
  const previousImageResult = convertMessagesToResponsesInput([{
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_prev_image', [
        vscodeStub.LanguageModelDataPart.image(new Uint8Array([1, 2, 3, 4]), 'image/png')
      ])
    ]
  }])[0];

  const replayedImageResult = convertMessagesToResponsesInput([{
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_replayed_image', [
        new vscodeStub.LanguageModelTextPart('[Image was previously shown to you. Image URI: vscode-chat-response-resource://session/tool/call/file.png]')
      ])
    ]
  }])[0];

  const previousInput = [
    { type: 'message', role: 'user', content: 'Analyze this screenshot.' },
    { type: 'function_call', call_id: 'call_prev_image', name: 'view_image', arguments: '{"filePath":"before.png"}' },
    previousImageResult
  ];
  const currentInput = [
    { type: 'message', role: 'user', content: 'Analyze this screenshot.' },
    { type: 'function_call', call_id: 'call_replayed_image', name: 'view_image', arguments: '{"filePath":"before.png"}' },
    replayedImageResult,
    { type: 'message', role: 'user', content: 'Now continue.' }
  ];

  const comparison = compareResponsesInputHistory(previousInput, currentInput);
  assertEqual(comparison.kind, 'append', 'image placeholder comparison kind');
  assertEqual(comparison.matchedPrefixCount, previousInput.length, 'image placeholder matched prefix count');
  assertEqual(JSON.stringify(comparison.appendedInput), JSON.stringify([currentInput[3]]), 'image placeholder delta');

  const store = createTestResponseBranchStore(ResponseBranchStore);
  const envelope = reuseEnvelope('reuse-key-image-placeholder');
  store.recordSuccess(envelope, previousInput, 'resp_image_placeholder');
  const reusableMatch = store.findReusableBranch(envelope, currentInput);
  assertEqual(reusableMatch?.responseId, 'resp_image_placeholder', 'image placeholder reuse previous response id');
  assertEqual(JSON.stringify(reusableMatch?.comparison.appendedInput ?? []), JSON.stringify([currentInput[3]]), 'image placeholder reuse delta');
}

function runImageUriAnnotationReuseSmokeTest(compareResponsesInputHistory, convertMessagesToResponsesInput, ResponseBranchStore) {
  const previousImageResult = convertMessagesToResponsesInput([{
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_prev_image_annotation', [
        vscodeStub.LanguageModelDataPart.image(new Uint8Array([1, 2, 3, 4]), 'image/png'),
        new vscodeStub.LanguageModelTextPart('\n[Image URI: vscode-chat-response-resource://session/tool/call_prev_image_annotation/0/file.png]')
      ])
    ]
  }])[0];

  const replayedImageResult = convertMessagesToResponsesInput([{
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new vscodeStub.LanguageModelToolResultPart('call_replayed_image_annotation', [
        new vscodeStub.LanguageModelTextPart('[Image was previously shown to you. Image URI: vscode-chat-response-resource://session/tool/call_replayed_image_annotation/0/file.png]')
      ])
    ]
  }])[0];

  const previousInput = [
    { type: 'message', role: 'user', content: 'Inspect the first screenshot.' },
    { type: 'function_call', call_id: 'call_prev_image_annotation', name: 'view_image', arguments: '{"filePath":"before.png"}' },
    previousImageResult
  ];
  const currentInput = [
    { type: 'message', role: 'user', content: 'Inspect the first screenshot.' },
    { type: 'function_call', call_id: 'call_replayed_image_annotation', name: 'view_image', arguments: '{"filePath":"before.png"}' },
    replayedImageResult,
    { type: 'message', role: 'user', content: 'Continue from that image.' }
  ];

  const comparison = compareResponsesInputHistory(previousInput, currentInput);
  assertEqual(comparison.kind, 'append', 'image URI annotation comparison kind');
  assertEqual(comparison.matchedPrefixCount, previousInput.length, 'image URI annotation matched prefix count');
  assertEqual(JSON.stringify(comparison.appendedInput), JSON.stringify([currentInput[3]]), 'image URI annotation delta');

  const store = createTestResponseBranchStore(ResponseBranchStore);
  const envelope = reuseEnvelope('reuse-key-image-uri-annotation');
  store.recordSuccess(envelope, previousInput, 'resp_image_uri_annotation');
  const reusableMatch = store.findReusableBranch(envelope, currentInput);
  assertEqual(reusableMatch?.responseId, 'resp_image_uri_annotation', 'image URI annotation reuse previous response id');
  assertEqual(JSON.stringify(reusableMatch?.comparison.appendedInput ?? []), JSON.stringify([currentInput[3]]), 'image URI annotation reuse delta');
}

function createTestResponseBranchStore(ResponseBranchStore) {
  const store = new ResponseBranchStore();
  const recordSuccess = store.recordSuccess.bind(store);
  store.recordSuccess = (envelope, input, responseId, branchId, state) => recordSuccess(
    envelope,
    input,
    responseId,
    branchId,
    state ?? createCompletedBranchState(envelope, input, responseId)
  );
  return store;
}

function createCompletedBranchState(envelope, input, responseId, responseItems = []) {
  return {
    identity: {
      installationId: 'test-installation',
      sessionId: 'test-session',
      threadId: 'test-thread',
      windowId: 'test-window'
    },
    turn: {
      id: `turn-${responseId}`,
      startedAt: Date.now(),
      completed: true
    },
    continuation: {
      fullRequest: {
        model: 'test-model',
        instructions: 'Smoke test instructions',
        input,
        store: false,
        stream: true
      },
      responseId,
      responseItems,
      requestFingerprint: envelope.requestFingerprint,
      catalogHash: envelope.catalogHash,
      turnId: `turn-${responseId}`
    },
    updatedAt: Date.now()
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function reuseEnvelope(identityKey, toolSignatures) {
  return {
    identityKey,
    scopeKey: identityKey,
    requestFingerprint: JSON.stringify({
      protocolSettings: null,
      requestFingerprint: fingerprintFullRequest()
    }),
    effectiveInputBudget: 258400,
    toolSignatures
  };
}

function fingerprintFullRequest() {
  return '{"instructions":"Smoke test instructions","model":"test-model","store":false,"stream":true}';
}
