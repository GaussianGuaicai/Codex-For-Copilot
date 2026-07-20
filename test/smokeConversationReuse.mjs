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
    Assistant: 2
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

const { compareResponsesInputHistory, convertMessagesToResponsesInput, stableSerialize } = require(compareBundlePath);
const { ResponseBranchStore } = require(branchStoreBundlePath);
const { buildResponseBranchReuseEnvelope, buildResponseBranchToolSignatures, getReasoningEffort } = require(providerBundlePath);

try {
  runStableSerializeSmokeTest(stableSerialize);
  runReasoningEffortOptionSmokeTest(getReasoningEffort);
  runCompareHistorySmokeTest(compareResponsesInputHistory);
  runToolCallIdCanonicalizationSmokeTest(compareResponsesInputHistory);
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

function runBranchStoreSmokeTest(ResponseBranchStore) {
  const store = new ResponseBranchStore();
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

  const upgradeStore = new ResponseBranchStore();
  upgradeStore.recordSuccess(standard, previousInput, 'resp_standard');
  assertEqual(upgradeStore.findReusableBranch(standard, appendInput)?.responseId, 'resp_standard', 'same budget reuses branch');
  assertEqual(upgradeStore.findReusableBranch(long, appendInput)?.responseId, 'resp_standard', 'larger budget reuses smaller-budget branch');

  const downgradeStore = new ResponseBranchStore();
  downgradeStore.recordSuccess(long, previousInput, 'resp_long');
  assertEqual(downgradeStore.findReusableBranch(standard, appendInput), undefined, 'smaller budget rejects larger-budget branch');
  const downgradeDiagnostic = downgradeStore.explainReuseMiss(standard, appendInput);
  assertEqual(downgradeDiagnostic?.inputBudgetCompatible, false, 'downgrade diagnostic reports incompatible budget');
  assertEqual(downgradeDiagnostic?.previousEffectiveInputBudget, 950000, 'downgrade diagnostic reports stored budget');
  assertEqual(downgradeDiagnostic?.currentEffectiveInputBudget, 258400, 'downgrade diagnostic reports target budget');

  const legacyStore = new ResponseBranchStore();
  legacyStore.recordSuccess(legacy, previousInput, 'resp_legacy');
  assertEqual(legacyStore.findReusableBranch(standard, appendInput), undefined, 'missing legacy budget fails closed');
}

function runBranchStoreDisableReuseSmokeTest(ResponseBranchStore) {
  const store = new ResponseBranchStore();
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
  const store = new ResponseBranchStore();
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

  const store = new ResponseBranchStore();
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

  const store = new ResponseBranchStore();
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

  const store = new ResponseBranchStore();
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

  const store = new ResponseBranchStore();
  const envelope = reuseEnvelope('reuse-key-image-uri-annotation');
  store.recordSuccess(envelope, previousInput, 'resp_image_uri_annotation');
  const reusableMatch = store.findReusableBranch(envelope, currentInput);
  assertEqual(reusableMatch?.responseId, 'resp_image_uri_annotation', 'image URI annotation reuse previous response id');
  assertEqual(JSON.stringify(reusableMatch?.comparison.appendedInput ?? []), JSON.stringify([currentInput[3]]), 'image URI annotation reuse delta');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function reuseEnvelope(identityKey, toolSignatures) {
  return { identityKey, effectiveInputBudget: 258400, toolSignatures };
}
