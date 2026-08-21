import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-provider-fallback-'));
const bundlePath = join(tempDir, 'provider.cjs');
const modelsBundlePath = join(tempDir, 'models.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);
let performanceNow = () => Date.now();
const performanceMock = { now: () => performanceNow() };
const warningMessages = [];

const configValues = {
  baseURL: '',
  clientVersion: '0.0.0',
  credentialsSource: 'secretStorage',
  transport: 'http',
  model: 'gpt-5.5',
  includeHiddenModels: false,
  instructions: 'Smoke test instructions',
  defaultServiceTier: 'auto',
  defaultReasoningEffort: 'auto',
  maxOutputTokens: 32,
  disabledModels: [],
  modelAliases: {},
  modelPricingUsdPerMTok: {}
};

class Disposable {
  constructor(func = () => {}) {
    this.func = func;
  }

  dispose() {
    this.func();
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
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

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }

  static json(value, mimeType = 'application/json') {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType);
  }

  static text(value, mimeType = 'text/plain') {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mimeType);
  }
}

class LanguageModelThinkingPart {
  constructor(value, id, metadata) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

const vscodeMock = {
  Disposable,
  EventEmitter,
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
    System: 3
  },
  LanguageModelChatToolMode: {
    Required: 2
  },
  window: {
    async showWarningMessage(message) {
      warningMessages.push(message);
    }
  },
  commands: {
    async executeCommand() {}
  },
  workspace: {
    getConfiguration(section) {
      if (section !== 'codexModelProvider') {
        throw new Error(`Unexpected configuration section: ${section}`);
      }

      return {
        get(key, defaultValue) {
          return key in configValues ? configValues[key] : defaultValue;
        }
      };
    },
    onDidChangeConfiguration() {
      return new Disposable();
    }
  }
};

await build({
  entryPoints: ['src/provider.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: ['vscode']
});

await build({
  entryPoints: ['src/models.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: modelsBundlePath,
  external: ['vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  if (request === 'node:perf_hooks') {
    return { performance: performanceMock };
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const { CodexModelProvider } = require(bundlePath);
const { buildFallbackModel, buildProviderModels, fetchAvailableModels } = require(modelsBundlePath);

try {
  await runModelCatalogMetadataSmokeTest();
  await runProviderMalformedCatalogFallbackSmokeTest();
  await runProviderLongContextSelectionSmokeTest();
  await runProviderFallbackSmokeTest();
  await runInterleavedResponsePresentationSmokeTest();
  await runStatefulMarkerRoundTripSmokeTest();
  await runStatefulMarkerContinuationRecoverySmokeTest();
  await runStatefulMarkerOpaqueRecoverySmokeTest();
  await runStatefulMarkerToolOutputReplaySmokeTest();
  await runStatefulMarkerAutoFallbackOpaqueToolOutputRecoverySmokeTest();
  await runStatefulMarkerRecordFailureSmokeTest();
  await runStatefulMarkerInvalidCompletionIdSmokeTest();
  await runHttpContinuationRecoverySmokeTest();
  await runStructuredHttpContinuationRecoverySmokeTest();
  await runContinuationMissAfterVisibleOutputSmokeTest();
  await runRequestEnvelopeReuseInvalidationSmokeTest();
  await runToolOutputFullInputReplaySmokeTest();
  await runModelGeneratedToolLoopFullReplaySmokeTest();
  await runDanglingCompletedToolCallFullReplaySmokeTest();
  await runCreatedResponseCancellationDoesNotRecordBranchSmokeTest();
  await runProviderCatalogVersionNeutralSmokeTest();
  await runProviderUnavailableScopeSmokeTest();
  await runProviderModelDiscoveryPolicySmokeTest();
  await runProviderNestedAliasPolicySmokeTest();
  await runProviderAuthoritativeCatalogSmokeTest();
  await runProviderStaleModelRefreshDoesNotBlockResponseSmokeTest();
  await runProviderModelIdDoesNotBlockColdDiscoverySmokeTest();
  await runProviderVirtualToolFallbackNotificationSmokeTest();
  await runLocalTokenEstimateDiagnosticSmokeTest();
  console.log('Smoke test passed: provider advertises effective context profiles, sends real model slugs, and preserves runtime availability policy.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

async function runModelCatalogMetadataSmokeTest() {
  const catalog = [
    createMockModel('gpt-5.4', 'GPT-5.4', {
      context_window: 272000,
      max_context_window: 1000000,
      input_modalities: ['text', 'image'],
      visibility: 'hide'
    }),
    createMockModel('gpt-5.4-mini', 'GPT-5.4-Mini', {
      context_window: 272000,
      max_context_window: 272000,
      input_modalities: ['text', 'image'],
      visibility: 'hide'
    }),
    createMockModel('gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark', {
      context_window: 128000,
      max_context_window: 128000,
      input_modalities: ['text'],
      supported_in_api: false
    }),
    createMockModel('codex-auto-review', 'Codex Auto Review', {
      context_window: 272000,
      max_context_window: 1000000,
      input_modalities: ['text', 'image'],
      visibility: 'hide'
    }),
    createMockModel('arbitrary-hidden-model', 'Arbitrary Hidden Model', {
      context_window: 64000,
      max_context_window: 64000,
      visibility: 'hidden'
    })
  ];
  let catalogPayload = { models: catalog };
  let catalogRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      catalogRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(catalogPayload));
      return;
    }

    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const config = {
    ...configValues,
    baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`
  };
  const sharedCredentials = {
    apiKey: 'test-api-key',
    headers: { 'User-Agent': 'model-catalog-smoke' },
    source: 'codexAuth',
    omitMaxOutputTokens: true
  };

  try {
    const token = createCancellationToken();
    const defaultAccountCatalog = await fetchAvailableModels(config, {
      ...sharedCredentials,
      kind: 'codexAccessToken'
    }, token);
    const includeHiddenConfig = { ...config, includeHiddenModels: true };
    const accountCatalog = await fetchAvailableModels(includeHiddenConfig, {
      ...sharedCredentials,
      kind: 'codexAccessToken'
    }, token);
    const apiKeyCatalog = await fetchAvailableModels(includeHiddenConfig, {
      ...sharedCredentials,
      kind: 'openaiApiKey',
      omitMaxOutputTokens: false
    }, token);

    catalogPayload = { models: [] };
    const emptyCatalog = await fetchAvailableModels(config, {
      ...sharedCredentials,
      kind: 'codexAccessToken'
    }, token);
    assertEqual(emptyCatalog.length, 0, 'successful empty catalog remains empty');
    assertEqual(
      buildProviderModels(config, emptyCatalog, 'codexAccessToken').length,
      0,
      'successful empty catalog does not synthesize the configured fallback model'
    );

    catalogPayload = { unexpected: [] };
    let invalidCatalogMessage = '';
    try {
      await fetchAvailableModels(config, {
        ...sharedCredentials,
        kind: 'codexAccessToken'
      }, token);
    } catch (error) {
      invalidCatalogMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(invalidCatalogMessage, 'Model discovery returned an invalid catalog.', 'malformed catalog is treated as discovery failure');

    for (const malformedModels of [[null], [catalog[0], {}]]) {
      catalogPayload = { models: malformedModels };
      let malformedRowMessage = '';
      try {
        await fetchAvailableModels(config, {
          ...sharedCredentials,
          kind: 'codexAccessToken'
        }, token);
      } catch (error) {
        malformedRowMessage = error instanceof Error ? error.message : String(error);
      }
      assertEqual(malformedRowMessage, 'Model discovery returned an invalid catalog.', 'malformed catalog row is treated as discovery failure');
    }
    catalogPayload = { models: catalog };

    assertEqual(
      defaultAccountCatalog.map((model) => model.slug).join(','),
      'gpt-5.3-codex-spark,codex-auto-review',
      'hidden upstream models stay filtered by default while hidden Auto Review remains available'
    );
    assertEqual(
      accountCatalog.map((model) => model.slug).join(','),
      'gpt-5.4,gpt-5.4-mini,gpt-5.3-codex-spark,codex-auto-review,arbitrary-hidden-model',
      'Codex account opt-in retains every structurally valid hidden model and API-ineligible account models'
    );
    assertEqual(
      apiKeyCatalog.map((model) => model.slug).join(','),
      'gpt-5.4,gpt-5.4-mini,codex-auto-review,arbitrary-hidden-model',
      'API-key hidden-model opt-in still filters API-ineligible models'
    );

    const resolvedModels = buildProviderModels(config, accountCatalog, 'codexAccessToken');
    const gpt54 = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.4');
    const gpt54Mini = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.4-mini');
    const spark = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.3-codex-spark');
    const autoReview = resolvedModels.find((model) => model.info.id === 'codex::codex-auto-review');
    if (!gpt54 || !gpt54Mini || !spark || !autoReview) {
      throw new Error('Expected GPT-5.4, GPT-5.4-Mini, Spark, and Auto Review model metadata.');
    }

    const formattedActiveContext = (272000).toLocaleString();
    const formattedMaximumContext = (1000000).toLocaleString();
    const gpt54ContextSize = gpt54.info.configurationSchema?.properties?.contextSize;
    assertEqual(gpt54.rawContextWindow, 272000, 'GPT-5.4 active raw context');
    assertEqual(gpt54.effectiveInputBudget, 258400, 'GPT-5.4 default effective budget');
    assertEqual(gpt54.info.maxInputTokens, 950000, 'GPT-5.4 advertises the maximum selectable budget');
    assertEqual(gpt54ContextSize?.enum.join(','), '258400,950000', 'GPT-5.4 exposes default and long context sizes');
    assertEqual(gpt54ContextSize?.default, 258400, 'GPT-5.4 defaults to the active context size');
    assertEqual(gpt54ContextSize?.group, 'tokens', 'GPT-5.4 context size uses the native token group');
    assertEqual(
      gpt54.info.detail?.includes(
        `Effective input budget: 258,400 tokens | Raw context window: ${formattedActiveContext} tokens (active) | Maximum context: ${formattedMaximumContext} tokens (opt-in)`
      ),
      true,
      'GPT-5.4 detail distinguishes active and maximum context'
    );
    assertEqual(
      resolvedModels.some((model) => model.info.id.includes('::context=')),
      false,
      'long context is no longer a duplicate model profile'
    );
    assertEqual(gpt54Mini.info.maxInputTokens, 258400, 'GPT-5.4-Mini uses the default effective budget');
    assertEqual(autoReview.info.maxInputTokens, 950000, 'Auto Review advertises the discovered maximum budget');
    assertEqual(
      autoReview.info.detail?.includes(`Maximum context: ${formattedMaximumContext} tokens (opt-in)`),
      true,
      'Auto Review maximum context detail'
    );
    assertEqual(
      autoReview.info.configurationSchema?.properties?.contextSize?.enum.join(','),
      '258400,950000',
      'Auto Review uses the discovered maximum as a context-size selector'
    );
    assertEqual(spark.info.id, 'codex::gpt-5.3-codex-spark', 'Spark provider model id');
    assertEqual(spark.info.maxInputTokens, 121600, 'Spark standard effective budget');
    assertEqual(spark.info.capabilities?.imageInput, false, 'Spark text-only capability');
    assertEqual(spark.info.capabilities?.toolCalling, true, 'Spark tool capability');
    assertEqual(spark.info.detail?.includes('Maximum context:'), false, 'Spark omits redundant maximum context');

    const duplicateGpt54Models = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4 First', {
        context_window: 272000,
        max_context_window: 1000000
      }),
      createMockModel('gpt-5.4', 'GPT-5.4 Second', {
        context_window: 272000,
        max_context_window: 1000000
      })
    ], 'codexAccessToken');
    assertEqual(
      duplicateGpt54Models.map((model) => model.info.id).join(','),
      'codex::gpt-5.4',
      'duplicate GPT-5.4 rows yield one model ID'
    );
    assertEqual(
      duplicateGpt54Models.map((model) => model.info.name).join(','),
      'GPT-5.4 First',
      'duplicate GPT-5.4 rows preserve first-seen metadata and order'
    );

    const discoveredOverrideModels = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4', {
        context_window: 333000,
        max_context_window: 1000000
      })
    ], 'codexAccessToken');
    const discoveredOverride = discoveredOverrideModels.find((model) => model.info.id === 'codex::gpt-5.4');
    assertEqual(discoveredOverride?.info.maxInputTokens, 950000, 'valid discovered context preserves the maximum budget');
    assertEqual(
      discoveredOverride?.info.configurationSchema?.properties?.contextSize?.enum.join(','),
      '316350,950000',
      'valid GPT-5.4 maximum becomes a context-size selector'
    );

    const fractionalMetadata = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4', {
        context_window: 0.5,
        max_context_window: 0.5
      })
    ], 'codexAccessToken')[0];
    assertEqual(fractionalMetadata.info.maxInputTokens, 258400, 'fractional context below one uses effective fixed fallback');
    assertEqual(fractionalMetadata.info.detail?.includes('Maximum context:'), false, 'invalid fractional maximum is omitted');

    for (const invalidMaximumContext of [undefined, 272000, 271999, 0.5, '872000', Number.POSITIVE_INFINITY]) {
      const invalidMaximumModel = buildProviderModels(config, [
        createMockModel('invalid-maximum', 'Invalid Maximum', {
          context_window: 272000,
          max_context_window: invalidMaximumContext
        })
      ], 'codexAccessToken')[0];
      assertEqual(
        invalidMaximumModel.info.configurationSchema?.properties?.contextSize,
        undefined,
        `invalid maximum ${String(invalidMaximumContext)} omits the context-size selector`
      );
      assertEqual(invalidMaximumModel.info.maxInputTokens, 258400, `invalid maximum ${String(invalidMaximumContext)} keeps the active budget`);
    }

    const sparkFallback = buildFallbackModel({
      ...config,
      model: 'gpt-5.3-codex-spark'
    }, 'codexAccessToken');
    assertEqual(sparkFallback.requestModel, 'gpt-5.3-codex-spark', 'Spark fallback request model');
    assertEqual(sparkFallback.info.maxInputTokens, 121600, 'Spark fixed fallback effective budget');
    assertEqual(sparkFallback.info.capabilities?.imageInput, false, 'Spark fallback text-only capability');

    const defaultFallback = buildFallbackModel(config, 'codexAccessToken');
    assertEqual(defaultFallback.info.maxInputTokens, 258400, 'default fallback applies the Codex-compatible percentage');
    assertEqual(
      defaultFallback.info.detail?.includes(`Effective input budget: 258,400 tokens | Raw context window: ${formattedActiveContext} tokens`),
      true,
      'fallback detail reports configured context'
    );
    assertEqual(defaultFallback.info.detail?.includes(config.baseURL), true, 'fallback detail retains source URL');

    const chatGptConfig = {
      ...config,
      baseURL: 'https://chatgpt.com/backend-api/codex/responses'
    };
    const rollbackCatalog = [
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { context_window: 272000, max_context_window: 872000 }),
      createMockModel('gpt-5.6-terra', 'GPT-5.6-Terra', { context_window: 272000, max_context_window: 872000 }),
      createMockModel('gpt-5.6-luna', 'GPT-5.6-Luna', { context_window: 272000, max_context_window: 872000 }),
      createMockModel('gpt-5.6-nova', 'GPT-5.6-Nova', { context_window: 272000, max_context_window: 272000 })
    ];
    const rollbackModels = buildProviderModels(chatGptConfig, rollbackCatalog, 'codexAccessToken');
    const formattedGpt56MaximumContext = (872000).toLocaleString();
    assertEqual(rollbackModels.length, 4, 'eligible GPT-5.6 catalog keeps one model per backend model');
    for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const resolvedModel = rollbackModels.find((candidate) => candidate.info.id === `codex::${slug}`);
      const contextSize = resolvedModel?.info.configurationSchema?.properties?.contextSize;
      if (!resolvedModel || !contextSize) {
        throw new Error(`Expected ${slug} metadata with a Context Size selector.`);
      }
      assertEqual(resolvedModel.effectiveInputBudget, 258400, `${slug} retains the default effective budget`);
      assertEqual(resolvedModel.info.maxInputTokens, 828400, `${slug} advertises the maximum selectable budget`);
      assertEqual(contextSize.enum.join(','), '258400,828400', `${slug} exposes standard and long context sizes`);
      assertEqual(contextSize.enumDescriptions[1], 'Long context.', `${slug} labels the discovered maximum as long context`);
      assertEqual(
        resolvedModel.info.detail?.includes(`Maximum context: ${formattedGpt56MaximumContext} tokens (opt-in)`),
        true,
        `${slug} shows the discovered maximum context`
      );
      assertEqual(resolvedModel.info.maxOutputTokens, config.maxOutputTokens, `${slug} output metadata remains configured`);
      assertEqual(resolvedModel.info.detail?.includes('500,000'), false, `${slug} does not expose inferred total context`);
    }
    assertEqual(
      rollbackModels.some((model) => model.info.id.includes('::context=')),
      false,
      'GPT-5.6 models do not expose synthetic long-context IDs'
    );

    const duplicateGpt56Models = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol First', { context_window: 272000, max_context_window: 872000 }),
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol Second', { context_window: 272000, max_context_window: 872000 })
    ], 'codexAccessToken');
    assertEqual(
      duplicateGpt56Models.map((model) => model.info.id).join(','),
      'codex::gpt-5.6-sol',
      'duplicate GPT-5.6 rows yield one model ID'
    );
    assertEqual(
      duplicateGpt56Models.map((model) => model.info.name).join(','),
      'GPT-5.6-Sol First',
      'duplicate GPT-5.6 rows preserve first-seen metadata and order'
    );

    const unrelatedModel = rollbackModels.find((model) => model.info.id === 'codex::gpt-5.6-nova');
    assertEqual(unrelatedModel?.info.configurationSchema?.properties?.contextSize, undefined, 'equal maximum omits the context-size selector');
    assertEqual(
      rollbackModels.some((model) => model.info.id.includes('::context=')),
      false,
      'long context does not create synthetic model IDs'
    );

    const apiKeyModels = buildProviderModels(chatGptConfig, rollbackCatalog, 'openaiApiKey');
    assertEqual(
      apiKeyModels.find((model) => model.requestModel === 'gpt-5.6-sol')?.info.maxInputTokens,
      828400,
      'API-key catalog uses a valid discovered maximum'
    );
    const customBackendModels = buildProviderModels(config, rollbackCatalog, 'codexAccessToken');
    assertEqual(
      customBackendModels.find((model) => model.requestModel === 'gpt-5.6-sol')?.info.maxInputTokens,
      828400,
      'custom backend catalog uses a valid discovered maximum'
    );

    for (const baseURL of [
      'https://chatgpt.com:444/backend-api/codex/responses',
      'https://user@chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses?proxy=1',
      'https://chatgpt.com/backend-api/codex/responses#proxy'
    ]) {
      const models = buildProviderModels({ ...chatGptConfig, baseURL }, rollbackCatalog, 'codexAccessToken');
      assertEqual(
        models.find((model) => model.requestModel === 'gpt-5.6-sol')?.info.maxInputTokens,
        828400,
        `backend ${baseURL} uses the valid discovered maximum`
      );
    }

    const promotedModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { context_window: 372000, max_context_window: 372000 })
    ], 'codexAccessToken');
    const promotedModel = promotedModels[0];
    assertEqual(promotedModel.info.maxInputTokens, 353400, 'active 372K catalog value uses effective budget');
    assertEqual(promotedModel.info.configurationSchema?.properties?.contextSize, undefined, 'equal active and maximum context omit the selector');
    assertEqual(promotedModels.length, 1, 'active 372K catalog does not duplicate the model');

    const activeMillionModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.4', 'GPT-5.4', { context_window: 1000000, max_context_window: 1000000 })
    ], 'codexAccessToken');
    assertEqual(activeMillionModels.length, 1, 'active GPT-5.4 1M catalog does not duplicate the long profile');
    assertEqual(activeMillionModels[0].info.maxInputTokens, 950000, 'active GPT-5.4 1M context uses effective budget');

    const nearMatchModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.4-preview', 'GPT-5.4 Preview', { context_window: 272000, max_context_window: 1000000 })
    ], 'codexAccessToken');
    assertEqual(nearMatchModels[0].info.maxInputTokens, 950000, 'any model with a valid maximum receives the long-context budget');

    const fallbackCeiling = buildFallbackModel({
      ...chatGptConfig,
      model: 'gpt-5.6-sol'
    }, 'codexAccessToken');
    assertEqual(fallbackCeiling.info.maxInputTokens, 258400, 'fallback keeps conservative effective budget');
    assertEqual(
      fallbackCeiling.info.detail?.includes('Maximum context:'),
      false,
      'fallback omits unverified maximum context'
    );
    const percentageOverride = buildProviderModels(config, [
      createMockModel('percentage-override', 'Percentage Override', {
        context_window: 333001,
        max_context_window: 333001,
        effective_context_window_percent: 80.5
      })
    ], 'codexAccessToken')[0];
    assertEqual(percentageOverride.rawContextWindow, 333001, 'explicit percentage preserves raw context');
    assertEqual(percentageOverride.info.maxInputTokens, 268065, 'explicit percentage overrides fallback with exact floor behavior');

    for (const invalidPercent of [0, -1, 100.01, Number.NaN, Number.POSITIVE_INFINITY, '95']) {
      const invalidPercentageModel = buildProviderModels(config, [
        createMockModel('invalid-percentage', 'Invalid Percentage', {
          context_window: 272000,
          effective_context_window_percent: invalidPercent
        })
      ], 'codexAccessToken')[0];
      assertEqual(invalidPercentageModel.info.maxInputTokens, 258400, `invalid percentage ${String(invalidPercent)} falls back to 95`);
    }

    assertEqual(catalogRequestCount, 7, 'visibility, credential-kind, and catalog validation request count');
  } finally {
    server.close();
  }
}

async function runProviderMalformedCatalogFallbackSmokeTest() {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{}] }));
      return;
    }

    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.model = 'gpt-5.5';
  configValues.disabledModels = [];
  configValues.modelAliases = {};

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, createCancellationToken());
    assertEqual(
      models.map((model) => model.id).join(','),
      'codex::gpt-5.5',
      'malformed non-empty catalog uses the explicit discovery-failure fallback'
    );
  } finally {
    await closeServer(server);
  }
}

async function runProviderLongContextSelectionSmokeTest() {
  const responseRequests = [];
  const selectedModels = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('gpt-5.4', 'GPT-5.4', {
            context_window: 272000,
            max_context_window: 1000000,
            input_modalities: ['text', 'image']
          })
        ]
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);
    const replies = [
      ['first reply', 'resp_standard'],
      ['long reply', 'resp_long'],
      ['long follow-up reply', 'resp_long_follow_up'],
      ['downgrade reply', 'resp_downgrade'],
      ['model options seed reply', 'resp_model_options_seed'],
      ['model options follow-up reply', 'resp_model_options_follow_up'],
      ['precedence seed reply', 'resp_precedence_seed'],
      ['precedence follow-up reply', 'resp_precedence_follow_up']
    ];
    const reply = replies[responseRequests.length - 1];
    if (!reply) {
      throw new Error('Unexpected extra context-size request.');
    }
    writeSseResponse(response, reply[0], reply[1]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  configValues.disabledModels = [];
  configValues.modelAliases = {};

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    {
      setSelectedModel(model) {
        selectedModels.push(model);
      }
    },
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((candidate) => candidate.id === 'codex::gpt-5.4');
    const contextSize = model?.configurationSchema?.properties?.contextSize;
    if (!model || !contextSize) {
      throw new Error('Expected one GPT-5.4 model with a Context Size selector.');
    }
    assertEqual(model.maxInputTokens, 950000, 'model advertises maximum context size');
    assertEqual(contextSize.enum.join(','), '258400,950000', 'model exposes standard and long context sizes');
    assertEqual(contextSize.default, 258400, 'model defaults to the active context size');

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] }],
      {},
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] }
      ],
      { modelConfiguration: { contextSize: 950000 } },
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('long reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Long follow up')] }
      ],
      { modelConfiguration: { contextSize: 950000 } },
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('long reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Long follow up')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('long follow-up reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Downgrade')] }
      ],
      {},
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Model options seed')] }],
      { modelConfiguration: { contextSize: 950000 } },
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Model options seed')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('model options seed reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Model options follow up')] }
      ],
      { modelOptions: { contextSize: 950000 } },
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Precedence seed')] }],
      { modelConfiguration: { contextSize: 950000 } },
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Precedence seed')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('precedence seed reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Precedence follow up')] }
      ],
      {
        modelOptions: { contextSize: 258400 },
        modelConfiguration: { contextSize: 950000 }
      },
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 8, 'context-size transition request count');
    assertEqual(selectedModels.join(','), Array(8).fill('gpt-5.4').join(','), 'context sizes resolve to the real backend model');
    for (const body of responseRequests) {
      assertEqual(body.model, 'gpt-5.4', 'context-size request sends the real backend model');
      assertEqual(
        Object.keys(body).some((key) => key.toLowerCase().includes('context')),
        false,
        'context size remains client-side and is not sent as a Responses API parameter'
      );
    }
    assertEqual(responseRequests[1].previous_response_id, 'resp_standard', 'switching to a larger context safely reuses the completed smaller-context response');
    assertEqual(responseRequests[2].previous_response_id, 'resp_long', 'same context size reuses its completed response');
    assertEqual(
      JSON.stringify(responseRequests[2].input),
      JSON.stringify([{ role: 'user', content: 'Long follow up', type: 'message' }]),
      'same context size sends only appended input'
    );
    assertEqual(responseRequests[3].previous_response_id, undefined, 'switching back to the default size starts an isolated chain');
    assertEqual(responseRequests[5].previous_response_id, 'resp_model_options_seed', 'request-time model options select the matching long-context branch');
    assertEqual(
      JSON.stringify(responseRequests[5].input),
      JSON.stringify([{ role: 'user', content: 'Model options follow up', type: 'message' }]),
      'request-time model options preserve incremental continuation input'
    );
    assertEqual(
      responseRequests[7].previous_response_id,
      undefined,
      'request-time model options override conflicting persisted model configuration'
    );
  } finally {
    server.close();
  }
}

async function runProviderFallbackSmokeTest() {
  const requestedModels = [];
  const selectedModels = [];
  const warnings = [];
  let thrownMessage = '';
  let failModelRefresh = false;
  let stallPreRejectionRefresh = false;
  let modelRequestCount = 0;
  let discoverySuccessCount = 0;
  let releasePreRejectionRefresh;
  let resolvePreRejectionRefreshStarted;
  let resolvePreRejectionRefreshCompleted;
  let resolvePostRejectionCacheLookup;
  let staleCacheLookupCount = 0;
  const preRejectionRefreshStarted = new Promise((resolve) => {
    resolvePreRejectionRefreshStarted = resolve;
  });
  const preRejectionRefreshCompleted = new Promise((resolve) => {
    resolvePreRejectionRefreshCompleted = resolve;
  });
  const postRejectionCacheLookup = new Promise((resolve) => {
    resolvePostRejectionCacheLookup = resolve;
  });

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      modelRequestCount += 1;
      const isPreRejectionRefresh = stallPreRejectionRefresh && modelRequestCount === 2;
      if (isPreRejectionRefresh) {
        resolvePreRejectionRefreshStarted();
        await new Promise((resolve) => {
          releasePreRejectionRefresh = resolve;
        });
      }
      if (failModelRefresh && !isPreRejectionRefresh) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'models unavailable' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { multi_agent_version: 'v2' }),
          createMockModel('gpt-5.6-nova', 'GPT-5.6-Nova', { multi_agent_version: 'v2' })
        ]
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestedModels.push(body.model);

    if (body.model === 'gpt-5.6-nova') {
      failModelRefresh = true;
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Model not found gpt-5.6-nova',
          type: 'invalid_request_error',
          param: 'model',
          code: null
        }
      }));
      return;
    }

    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  const originalDateNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  const outputChannel = {
    debug(message, payload) {
      if (message === 'getAvailableModels cache result' && payload?.modelDiscoveryCacheState === 'stale') {
        staleCacheLookupCount += 1;
        if (staleCacheLookupCount === 2) {
          resolvePostRejectionCacheLookup(payload);
        }
      }
      if (message === 'getAvailableModels discovery success') {
        discoverySuccessCount += 1;
        if (discoverySuccessCount === 2) {
          resolvePreRejectionRefreshCompleted();
        }
      }
    },
    info() {},
    warn(message, payload) {
      warnings.push({ message, payload });
    },
    error(message, payload) {
      warnings.push({ message, payload });
    }
  };

  const context = {
    secrets: {
      async get() {
        return 'test-api-key';
      }
    },
    subscriptions: []
  };

  const provider = new CodexModelProvider(
    context,
    outputChannel,
    undefined,
    undefined,
    {
      setSelectedModel(model) {
        selectedModels.push(model);
      }
    },
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const novaModel = models.find((item) => item.id === 'codex::gpt-5.6-nova');

    if (!novaModel) {
      throw new Error('Expected nova model to be discoverable before temporary disable.');
    }

    now += 10 * 60 * 1000 + 1;
    stallPreRejectionRefresh = true;
    const responseAttempt = provider.provideLanguageModelChatResponse(
      novaModel,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] }],
      {},
      { report() {} },
      token
    );
    await preRejectionRefreshStarted;
    try {
      await responseAttempt;
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }

    const rejectionRefreshLookup = await postRejectionCacheLookup;
    assertEqual(rejectionRefreshLookup.refreshStarted, true, 'model rejection starts a versioned refresh instead of joining stale work');
    releasePreRejectionRefresh?.();
    await preRejectionRefreshCompleted;
    await new Promise((resolve) => setImmediate(resolve));
    const refreshedModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(requestedModels.join(','), 'gpt-5.6-nova', 'request order without retry');
    assertEqual(selectedModels.join(','), 'gpt-5.6-nova', 'selected model does not silently change');
    assertEqual(
      refreshedModels.map((item) => item.id).join(','),
      'codex::gpt-5.6-sol',
      'failed refresh retains the authoritative catalog without the rejected model'
    );
    assertEqual(warnings.some((entry) => entry.message === 'response model unavailable'), true, 'unavailable warning emitted');
    assertEqual(thrownMessage.includes('hidden temporarily from the model picker'), true, 'clear unavailable-model error');
  } finally {
    releasePreRejectionRefresh?.();
    Date.now = originalDateNow;
    await closeServer(server);
  }
}

async function runInterleavedResponsePresentationSmokeTest() {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    for await (const _chunk of request) {
      // Consume the request before starting the deterministic event sequence.
    }

    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    send({
      type: 'response.reasoning_text.delta',
      item_id: 'rs_planning',
      output_index: 0,
      content_index: 0,
      delta: 'Optimized ',
      sequence_number: 1
    });
    send({
      type: 'response.reasoning_text.delta',
      item_id: 'rs_planning',
      output_index: 0,
      content_index: 0,
      delta: 'tool selection',
      sequence_number: 2
    });
    send({ type: 'response.output_text.delta', delta: '我先看一下仓库的', sequence_number: 3 });
    send({
      type: 'response.reasoning_text.delta',
      item_id: 'rs_later',
      output_index: 2,
      content_index: 0,
      delta: 'Analyzing',
      sequence_number: 4
    });
    send({ type: 'response.output_text.delta', delta: '结构。', sequence_number: 5 });
    send({ type: 'response.completed', response: { id: 'resp_interleaved', object: 'response', status: 'completed' } });
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected sol model for interleaved response presentation test.');
    }

    const parts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('What is this repository?')] }],
      {},
      { report(part) { parts.push(part); } },
      token
    );

    const presentation = parts
      .filter((part) => part instanceof LanguageModelThinkingPart || part instanceof LanguageModelTextPart)
      .map((part) => part instanceof LanguageModelThinkingPart
        ? { type: 'thinking', value: part.value, id: part.id }
        : { type: 'text', value: part.value });
    assertEqual(JSON.stringify(presentation), JSON.stringify([
      { type: 'thinking', value: 'Optimized tool selection', id: 'rs_planning:reasoning:reasoning-text:0:phase:0' },
      { type: 'text', value: '我先看一下仓库的' },
      { type: 'text', value: '结构。' }
    ]), 'raw reasoning falls back as one bounded Thinking part before visible text');
  } finally {
    await closeServer(server);
  }
}

async function runStatefulMarkerRoundTripSmokeTest() {
  const responseRequests = [];
  const replies = [
    ['seed reply', 'resp_marker_seed', 'msg_marker_seed'],
    ['second reply', 'resp_marker_second', 'msg_marker_second'],
    ['third reply', 'resp_marker_third', 'msg_marker_third']
  ];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const reply = replies[responseRequests.length - 1];
    if (!reply) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unexpected extra marker request.' } }));
      return;
    }
    writeSseResponseWithOutputItem(response, reply[0], reply[1], reply[2]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for official stateful marker coverage.');
    }
    const systemMessage = createSystemMessage('Agent Host instructions');

    const seedParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        systemMessage,
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Initial input')] }
      ],
      {},
      { report(part) { seedParts.push(part); } },
      token
    );
    assertEqual(responseRequests[0].instructions, 'Smoke test instructions\n\nAgent Host instructions', 'configured and Agent Host instructions are preserved');
    assertEqual(JSON.stringify(responseRequests[0].input), JSON.stringify([
      { role: 'user', content: 'Initial input', type: 'message' }
    ]), 'first Agent Host call sends only Responses input');
    const seedMarkerPart = getSingleStatefulMarkerPart(seedParts, 'seed completion');
    assertEqual(decodeStatefulMarker(seedMarkerPart), `${model.id}\\resp_marker_seed`, 'seed marker uses official text encoding');

    const invalidCases = [
      {
        label: 'changed System instructions',
        messages: createAgentHostContinuationMessages(seedMarkerPart, 'Changed Agent Host instructions', 'Changed instruction delta')
      },
      {
        label: 'forged unknown response id',
        messages: createAgentHostContinuationMessages(createStatefulMarkerPart(`${model.id}\\resp_forged`), 'Agent Host instructions', 'Forged delta')
      },
      {
        label: 'model-mismatched marker',
        messages: createAgentHostContinuationMessages(createStatefulMarkerPart('codex::gpt-5.6-luna\\resp_marker_seed'), 'Agent Host instructions', 'Wrong model delta')
      },
      {
        label: 'malformed marker',
        messages: createAgentHostContinuationMessages(createStatefulMarkerPart('missing-delimiter'), 'Agent Host instructions', 'Malformed delta')
      },
      {
        label: 'duplicate leading marker',
        messages: [
          {
            role: vscodeMock.LanguageModelChatMessageRole.Assistant,
            content: [seedMarkerPart, createStatefulMarkerPart(`${model.id}\\resp_other`)]
          },
          systemMessage,
          { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Duplicate delta')] }
        ]
      }
    ];
    for (const invalidCase of invalidCases) {
      await assertLocalMarkerFailure(
        () => provider.provideLanguageModelChatResponse(model, invalidCase.messages, {}, { report() {} }, token),
        responseRequests,
        1,
        invalidCase.label
      );
    }

    const secondParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      createAgentHostContinuationMessages(seedMarkerPart, 'Agent Host instructions', 'Second delta'),
      {},
      { report(part) { secondParts.push(part); } },
      token
    );
    const secondMarkerPart = getSingleStatefulMarkerPart(secondParts, 'second completion');

    const thirdParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      createAgentHostContinuationMessages(secondMarkerPart, 'Agent Host instructions', 'Third delta'),
      {},
      { report(part) { thirdParts.push(part); } },
      token
    );
    const thirdMarkerPart = getSingleStatefulMarkerPart(thirdParts, 'third completion');

    assertEqual(responseRequests.length, 3, 'only valid official marker calls reach Responses');
    assertEqual(responseRequests[1].previous_response_id, 'resp_marker_seed', 'second call selects exact local seed response');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'Second delta', type: 'message' }
    ]), 'second call sends marker-free delta only');
    assertEqual(responseRequests[2].previous_response_id, 'resp_marker_second', 'third call selects accumulated second response');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'Third delta', type: 'message' }
    ]), 'third call sends marker-free delta only');
    assertEqual(decodeStatefulMarker(secondMarkerPart), `${model.id}\\resp_marker_second`, 'second marker uses official text encoding');
    assertEqual(decodeStatefulMarker(thirdMarkerPart), `${model.id}\\resp_marker_third`, 'third marker proves repeated accumulated continuation');

    const originalNow = Date.now;
    Date.now = () => originalNow() + 10 * 60 * 1000 + 1;
    try {
      await assertLocalMarkerFailure(
        () => provider.provideLanguageModelChatResponse(
          model,
          createAgentHostContinuationMessages(thirdMarkerPart, 'Agent Host instructions', 'Expired delta'),
          {},
          { report() {} },
          token
        ),
        responseRequests,
        3,
        'expired marker'
      );
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await closeServer(server);
  }
}

async function runStatefulMarkerContinuationRecoverySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);
    if (responseRequests.length === 1) {
      writeSseResponseWithOutputItem(response, 'recovery seed reply', 'resp_marker_recovery_seed', 'msg_marker_recovery_seed');
      return;
    }
    if (responseRequests.length === 2 && body.previous_response_id) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: 'Untrusted remote detail.',
          param: 'previous_response_id'
        }
      }));
      return;
    }
    if (responseRequests.length === 3) {
      writeSseResponseWithOutputItem(response, 'recovered reply', 'resp_marker_recovered', 'msg_marker_recovered');
      return;
    }
    if (responseRequests.length === 4) {
      writeSseResponseWithOutputItem(response, 'post-recovery reply', 'resp_marker_after_recovery', 'msg_marker_after_recovery');
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Unexpected marker recovery request.' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for official stateful marker recovery coverage.');
    }

    const seedParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [createSystemMessage('Recovery instructions'), {
        role: vscodeMock.LanguageModelChatMessageRole.User,
        content: [new vscodeMock.LanguageModelTextPart('Recovery seed')]
      }],
      {},
      { report(part) { seedParts.push(part); } },
      token
    );
    const seedMarkerPart = getSingleStatefulMarkerPart(seedParts, 'recovery seed');

    const recoveredParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      createAgentHostContinuationMessages(seedMarkerPart, 'Recovery instructions', 'Recovery delta'),
      {},
      { report(part) { recoveredParts.push(part); } },
      token
    );
    const recoveredMarkerPart = getSingleStatefulMarkerPart(recoveredParts, 'recovered completion');

    assertEqual(responseRequests.length, 3, 'marker continuation miss retries once');
    assertEqual(responseRequests[1].previous_response_id, 'resp_marker_recovery_seed', 'marker continuation attempts exact stored response id');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'Recovery delta', type: 'message' }
    ]), 'marker continuation attempt is incremental');
    assertEqual('previous_response_id' in responseRequests[2], false, 'marker recovery full replay omits previous response id');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'Recovery seed', type: 'message' },
      { id: 'msg_marker_recovery_seed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovery seed reply' }] },
      { role: 'user', content: 'Recovery delta', type: 'message' }
    ]), 'marker recovery uses canonical local snapshot input plus response item plus delta');
    assertEqual(decodeStatefulMarker(recoveredMarkerPart), `${model.id}\\resp_marker_recovered`, 'only recovered completion emits a marker');

    const finalParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      createAgentHostContinuationMessages(recoveredMarkerPart, 'Recovery instructions', 'After recovery delta'),
      {},
      { report(part) { finalParts.push(part); } },
      token
    );
    assertEqual(responseRequests.length, 4, 'post-recovery marker reaches backend once');
    assertEqual(responseRequests[3].previous_response_id, 'resp_marker_recovered', 'post-recovery marker selects the newly accumulated snapshot');
    assertEqual(JSON.stringify(responseRequests[3].input), JSON.stringify([
      { role: 'user', content: 'After recovery delta', type: 'message' }
    ]), 'post-recovery continuation remains delta only');
    assertEqual(decodeStatefulMarker(getSingleStatefulMarkerPart(finalParts, 'post-recovery completion')), `${model.id}\\resp_marker_after_recovery`, 'post-recovery marker is emitted');
  } finally {
    await closeServer(server);
  }
}

async function runStatefulMarkerToolOutputReplaySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (responseRequests.length === 1) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_marker_tool',
          type: 'function_call',
          call_id: 'call_marker_tool',
          name: 'read_file',
          arguments: '{"filePath":"src/provider.ts"}'
        }
      });
      send({ type: 'response.completed', response: { id: 'resp_marker_tool_seed', status: 'completed' } });
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    writeSseResponseWithOutputItem(response, 'tool result accepted', 'resp_marker_tool_done', 'msg_marker_tool_done');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for stateful marker tool-output replay coverage.');
    }

    const seedParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [createSystemMessage('Tool marker instructions'), {
        role: vscodeMock.LanguageModelChatMessageRole.User,
        content: [new vscodeMock.LanguageModelTextPart('Read the provider file')]
      }],
      { tools: [{ name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } }] },
      { report(part) { seedParts.push(part); } },
      token
    );
    const markerPart = getSingleStatefulMarkerPart(seedParts, 'tool marker seed');

    const resultParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [markerPart]
        },
        createSystemMessage('Tool marker instructions'),
        {
          role: vscodeMock.LanguageModelChatMessageRole.User,
          content: [new vscodeMock.LanguageModelToolResultPart(
            'call_marker_tool',
            [new vscodeMock.LanguageModelTextPart('provider source')]
          )]
        }
      ],
      { tools: [{ name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } }] },
      { report(part) { resultParts.push(part); } },
      token
    );

    assertEqual(responseRequests.length, 2, 'HTTP marker tool-output request count');
    assertEqual('previous_response_id' in responseRequests[1], false, 'HTTP marker tool output uses canonical full replay');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'Read the provider file', type: 'message' },
      {
        id: 'fc_marker_tool',
        type: 'function_call',
        call_id: 'call_marker_tool',
        name: 'read_file',
        arguments: '{"filePath":"src/provider.ts"}'
      },
      { type: 'function_call_output', call_id: 'call_marker_tool', output: 'provider source' }
    ]), 'HTTP marker tool output replays prior input, stored call, and current output');
    assertEqual(
      decodeStatefulMarker(getSingleStatefulMarkerPart(resultParts, 'tool marker completion')),
      `${model.id}\\resp_marker_tool_done`,
      'HTTP marker tool replay emits the completed marker'
    );
  } finally {
    await closeServer(server);
  }
}

async function runStatefulMarkerAutoFallbackOpaqueToolOutputRecoverySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(426);
      response.end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);
    if (responseRequests.length === 1) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const item = {
        id: 'fc_marker_auto_opaque',
        type: 'function_call',
        call_id: 'call_marker_auto_opaque',
        name: 'read_file',
        arguments: '{"filePath":"src/provider.ts"}'
      };
      send({ type: 'response.output_item.added', output_index: 0, item });
      send({
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: 0,
        name: item.name,
        arguments: item.arguments
      });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: 'resp_marker_auto_opaque_seed', status: 'completed' } });
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    if (responseRequests.length === 2 && body.previous_response_id) {
      response.writeHead(400);
      response.end();
      return;
    }
    const responseIndex = responseRequests.length;
    writeSseResponseWithOutputItem(
      response,
      responseIndex === 3 ? 'opaque tool recovery accepted' : 'opaque disable follow-up accepted',
      responseIndex === 3 ? 'resp_marker_auto_opaque_recovered' : 'resp_marker_auto_opaque_followup',
      responseIndex === 3 ? 'msg_marker_auto_opaque_recovered' : 'msg_marker_auto_opaque_followup'
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'auto';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );
  const tools = [{ name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } }];

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for auto-fallback opaque tool-output recovery coverage.');
    }

    const seedParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [createSystemMessage('Auto opaque tool instructions'), {
        role: vscodeMock.LanguageModelChatMessageRole.User,
        content: [new vscodeMock.LanguageModelTextPart('Read through auto fallback')]
      }],
      { tools },
      { report(part) { seedParts.push(part); } },
      token
    );
    const markerPart = getSingleStatefulMarkerPart(seedParts, 'auto opaque tool seed');

    const recoveredParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [markerPart]
        },
        createSystemMessage('Auto opaque tool instructions'),
        {
          role: vscodeMock.LanguageModelChatMessageRole.User,
          content: [new vscodeMock.LanguageModelToolResultPart(
            'call_marker_auto_opaque',
            [new vscodeMock.LanguageModelTextPart('provider source through auto fallback')]
          )]
        }
      ],
      { tools },
      { report(part) { recoveredParts.push(part); } },
      token
    );

    assertEqual(responseRequests.length, 3, 'auto opaque tool recovery sends seed, incremental, and canonical HTTP requests');
    assertEqual(
      responseRequests[1].previous_response_id,
      'resp_marker_auto_opaque_seed',
      'auto fallback first attempts incremental tool-output continuation'
    );
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { type: 'function_call_output', call_id: 'call_marker_auto_opaque', output: 'provider source through auto fallback' }
    ]), 'auto fallback sends only the incremental tool output before opaque rejection');
    assertEqual('previous_response_id' in responseRequests[2], false, 'auto opaque tool recovery omits the rejected response id');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'Read through auto fallback', type: 'message' },
      {
        id: 'fc_marker_auto_opaque',
        type: 'function_call',
        call_id: 'call_marker_auto_opaque',
        name: 'read_file',
        arguments: '{"filePath":"src/provider.ts"}'
      },
      { type: 'function_call_output', call_id: 'call_marker_auto_opaque', output: 'provider source through auto fallback' }
    ]), 'auto opaque tool recovery replays the canonical call and output exactly once');
    assertEqual(
      getStatefulMarkers(recoveredParts).length,
      0,
      'auto opaque tool recovery emits no marker while reuse remains disabled until expiry'
    );

    const followUpParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        createSystemMessage('Auto opaque tool instructions'),
        {
          role: vscodeMock.LanguageModelChatMessageRole.User,
          content: [new vscodeMock.LanguageModelTextPart('Read through auto fallback')]
        },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelToolCallPart(
            'call_marker_auto_opaque',
            'read_file',
            { filePath: 'src/provider.ts' }
          )]
        },
        {
          role: vscodeMock.LanguageModelChatMessageRole.User,
          content: [new vscodeMock.LanguageModelToolResultPart(
            'call_marker_auto_opaque',
            [new vscodeMock.LanguageModelTextPart('provider source through auto fallback')]
          )]
        },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelTextPart('opaque tool recovery accepted')]
        },
        {
          role: vscodeMock.LanguageModelChatMessageRole.User,
          content: [new vscodeMock.LanguageModelTextPart('Continue after opaque tool recovery')]
        }
      ],
      { tools },
      { report(part) { followUpParts.push(part); } },
      token
    );
    assertEqual(responseRequests.length, 4, 'opaque disable follow-up reaches HTTP once');
    assertEqual(
      'previous_response_id' in responseRequests[3],
      false,
      'opaque disable follow-up does not reuse the recovered response before expiry'
    );
    assertEqual(
      getStatefulMarkers(followUpParts).length,
      0,
      'opaque disable follow-up still emits no marker before expiry'
    );
  } finally {
    configValues.transport = 'http';
    await closeServer(server);
  }
}

async function runStatefulMarkerOpaqueRecoverySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);
    if (responseRequests.length === 1) {
      writeSseResponseWithOutputItem(response, 'opaque seed reply', 'resp_marker_opaque_seed', 'msg_marker_opaque_seed');
      return;
    }
    if (responseRequests.length === 2 && body.previous_response_id) {
      response.writeHead(400);
      response.end();
      return;
    }
    writeSseResponseWithOutputItem(response, 'opaque recovery reply', 'resp_marker_opaque_recovered', 'msg_marker_opaque_recovered');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for opaque stateful marker recovery coverage.');
    }

    const seedParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [createSystemMessage('Opaque recovery instructions'), {
        role: vscodeMock.LanguageModelChatMessageRole.User,
        content: [new vscodeMock.LanguageModelTextPart('Opaque seed')]
      }],
      {},
      { report(part) { seedParts.push(part); } },
      token
    );
    const seedMarkerPart = getSingleStatefulMarkerPart(seedParts, 'opaque recovery seed');

    const recoveredParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      createAgentHostContinuationMessages(seedMarkerPart, 'Opaque recovery instructions', 'Opaque delta'),
      {},
      { report(part) { recoveredParts.push(part); } },
      token
    );

    assertEqual(responseRequests.length, 3, 'opaque marker continuation retries once');
    assertEqual(responseRequests[1].previous_response_id, 'resp_marker_opaque_seed', 'opaque recovery first attempts the stored response');
    assertEqual('previous_response_id' in responseRequests[2], false, 'opaque recovery replays without previous response id');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'Opaque seed', type: 'message' },
      { id: 'msg_marker_opaque_seed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'opaque seed reply' }] },
      { role: 'user', content: 'Opaque delta', type: 'message' }
    ]), 'opaque recovery uses the canonical local snapshot');
    assertEqual(getStatefulMarkers(recoveredParts).length, 0, 'opaque HTTP rejection emits no marker while reuse remains disabled');
  } finally {
    await closeServer(server);
  }
}

async function runStatefulMarkerRecordFailureSmokeTest() {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    for await (const _chunk of request) {
      // Drain the request body before completing the response.
    }
    writeSseResponse(response, 'completed before local record failure', 'resp_marker_record_failure');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for stateful marker record-failure coverage.');
    }

    provider.responseBranchStore.recordSuccess = () => {
      throw new Error('Synthetic branch record failure');
    };
    const parts = [];
    let failureMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        model,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Do not emit an unrecorded marker.')] }],
        {},
        { report(part) { parts.push(part); } },
        token
      );
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }

    assertEqual(failureMessage, 'Synthetic branch record failure', 'branch record failure is surfaced');
    assertEqual(getStatefulMarkers(parts).length, 0, 'branch record failure emits no stateful marker');
  } finally {
    await closeServer(server);
  }
}

async function runStatefulMarkerInvalidCompletionIdSmokeTest() {
  const responseRequests = [];
  const responseIds = ['resp_invalid\u0001', 'r'.repeat(513), 'resp_valid_after_invalid'];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const responseId = responseIds[responseRequests.length - 1];
    if (!responseId) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unexpected invalid completion-id request.' } }));
      return;
    }
    writeSseResponseWithOutputItem(
      response,
      `reply ${responseRequests.length}`,
      responseId,
      `msg_invalid_completion_${responseRequests.length}`
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for invalid completion-id coverage.');
    }

    const messages = [];
    for (let index = 0; index < responseIds.length; index += 1) {
      messages.push({
        role: vscodeMock.LanguageModelChatMessageRole.User,
        content: [new vscodeMock.LanguageModelTextPart(`request ${index + 1}`)]
      });
      const parts = [];
      await provider.provideLanguageModelChatResponse(
        model,
        messages,
        {},
        { report(part) { parts.push(part); } },
        token
      );
      assertEqual(
        getStatefulMarkers(parts).length,
        index === responseIds.length - 1 ? 1 : 0,
        `completion id ${index + 1} marker count`
      );
      if (index < responseIds.length - 1) {
        messages.push({
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelTextPart(`reply ${index + 1}`)]
        });
      }
    }

    assertEqual(responseRequests.length, 3, 'invalid completion IDs do not cause retries');
    assertEqual('previous_response_id' in responseRequests[1], false, 'control-bearing response ID is not recorded');
    assertEqual('previous_response_id' in responseRequests[2], false, 'oversized response ID is not recorded');
  } finally {
    await closeServer(server);
  }
}

async function runHttpContinuationRecoverySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);

    if (body.previous_response_id) {
      response.writeHead(400);
      response.end();
      return;
    }

    writeSseResponse(response, responseRequests.length === 1 ? 'first reply' : 'recovered reply', responseRequests.length === 1 ? 'resp_initial' : 'resp_recovered');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected sol model for HTTP continuation recovery test.');
    }

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] }],
      {},
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] }
      ],
      {},
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 3, 'continuation recovery request count');
    assertEqual(responseRequests[1].previous_response_id, 'resp_initial', 'continuation request response id');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([{ role: 'user', content: 'Follow up', type: 'message' }]), 'continuation delta input');
    assertEqual('previous_response_id' in responseRequests[2], false, 'recovery request omits previous response id');
    assertEqual(
      JSON.stringify(responseRequests[2].input),
      JSON.stringify([
        { role: 'user', content: 'First request', type: 'message' },
        { role: 'assistant', content: 'first reply', type: 'message' },
        { role: 'user', content: 'Follow up', type: 'message' }
      ]),
      'recovery request full input'
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('recovered reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('One more request')] }
      ],
      {},
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 4, 'disabled continuation avoids another rejected request');
    assertEqual('previous_response_id' in responseRequests[3], false, 'disabled continuation omits previous response id');
    assertEqual(
      JSON.stringify(responseRequests[3].input),
      JSON.stringify([
        { role: 'user', content: 'First request', type: 'message' },
        { role: 'assistant', content: 'first reply', type: 'message' },
        { role: 'user', content: 'Follow up', type: 'message' },
        { role: 'assistant', content: 'recovered reply', type: 'message' },
        { role: 'user', content: 'One more request', type: 'message' }
      ]),
      'disabled continuation full input'
    );
  } finally {
    await closeServer(server);
  }
}

async function runStructuredHttpContinuationRecoverySmokeTest() {
  const responseRequests = [];
  const warnings = [];
  const infoMessages = [];
  const failureMessages = [];
  const remoteErrorMessage = 'Remote secret continuation detail must not be logged.';
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);

    if (responseRequests.length === 1) {
      writeSseResponse(response, 'first structured reply', 'resp_structured_initial');
      return;
    }

    if (responseRequests.length === 2 && body.previous_response_id) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: remoteErrorMessage,
          param: 'previous_response_id'
        }
      }));
      return;
    }

    if (responseRequests.length === 3) {
      writeSseResponse(response, 'structured recovered reply', 'resp_structured_recovered');
      return;
    }

    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Unexpected extra continuation recovery request.' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    {
      debug() {},
      info(message) {
        infoMessages.push(message);
      },
      warn(message, payload) {
        warnings.push({ message, payload });
      },
      error(message) {
        failureMessages.push(message);
      }
    },
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected sol model for structured continuation recovery test.');
    }

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Structured first request')] }],
      {},
      { report() {} },
      token
    );

    const recoveredParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Structured first request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first structured reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Structured follow up')] }
      ],
      {},
      { report(part) { recoveredParts.push(part); } },
      token
    );

    assertEqual(responseRequests.length, 3, 'structured continuation retries once with full history');
    assertEqual(responseRequests[1].previous_response_id, 'resp_structured_initial', 'structured continuation response id');
    assertEqual(
      JSON.stringify(responseRequests[1].input),
      JSON.stringify([{ role: 'user', content: 'Structured follow up', type: 'message' }]),
      'structured continuation sends only appended input first'
    );
    assertEqual('previous_response_id' in responseRequests[2], false, 'structured recovery omits previous response id');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'Structured first request', type: 'message' },
      { role: 'assistant', content: 'first structured reply', type: 'message' },
      { role: 'user', content: 'Structured follow up', type: 'message' }
    ]), 'structured recovery replays full input');
    assertEqual(
      recoveredParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''),
      'structured recovered reply',
      'structured recovery reports only recovered output'
    );

    const resetWarnings = warnings.filter((entry) => entry.message === 'response continuation reset');
    assertEqual(resetWarnings.length, 1, 'structured continuation emits one reset warning');
    assertEqual(
      resetWarnings[0].payload.reason,
      'Responses API could not find previous_response_id.',
      'structured reset warning uses the fixed classifier message'
    );
    assertEqual(JSON.stringify(resetWarnings).includes(remoteErrorMessage), false, 'structured reset warning omits remote error text');
    assertEqual(infoMessages.filter((message) => message === 'response completed').length, 2, 'seed and recovered requests complete once each');
    assertEqual(failureMessages.length, 0, 'recovered continuation emits no provider failure');
  } finally {
    await closeServer(server);
  }
}

async function runContinuationMissAfterVisibleOutputSmokeTest() {
  const responseRequests = [];
  const warnings = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);

    if (responseRequests.length === 1) {
      writeSseResponse(response, 'visible first reply', 'resp_visible_initial');
      return;
    }

    if (responseRequests.length === 3) {
      writeSseResponse(response, 'new chain reply', 'resp_visible_new_chain');
      return;
    }

    if (responseRequests.length > 3) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Visible output must prevent replay.' } }));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write(`data: ${JSON.stringify({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_visible_summary',
      output_index: 0,
      summary_index: 0,
      delta: 'partial visible reasoning'
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_visible_failed',
        status: 'failed',
        error: {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: 'Remote failure after visible output.',
          param: 'previous_response_id'
        }
      }
    })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    {
      debug() {},
      info() {},
      warn(message, payload) {
        warnings.push({ message, payload });
      },
      error() {}
    },
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected sol model for visible continuation failure test.');
    }

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Visible first request')] }],
      {},
      { report() {} },
      token
    );

    const visibleParts = [];
    let capturedError;
    try {
      await provider.provideLanguageModelChatResponse(
        model,
        [
          { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Visible first request')] },
          { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('visible first reply')] },
          { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Visible follow up')] }
        ],
        {},
        { report(part) { visibleParts.push(part); } },
        token
      );
    } catch (error) {
      capturedError = error;
    }

    assertEqual(capturedError?.message, 'Responses API could not find previous_response_id.', 'visible continuation miss surfaces once');
    assertEqual(responseRequests.length, 2, 'visible continuation miss is never replayed');
    assertEqual(responseRequests[1].previous_response_id, 'resp_visible_initial', 'visible continuation uses prior response');
    assertEqual(
      visibleParts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value).join(''),
      'partial visible reasoning',
      'visible reasoning continuation output is emitted once'
    );
    assertEqual(
      warnings.some((entry) => entry.message === 'response continuation reset'),
      false,
      'visible continuation miss emits no reset warning'
    );

    const nextParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Visible first request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('visible first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Visible follow up')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('partial visible output')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Start a new chain')] }
      ],
      {},
      { report(part) { nextParts.push(part); } },
      token
    );

    assertEqual(responseRequests.length, 3, 'next turn issues one new-chain request');
    assertEqual('previous_response_id' in responseRequests[2], false, 'next turn does not reuse stale response id');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'Visible first request', type: 'message' },
      { role: 'assistant', content: 'visible first reply', type: 'message' },
      { role: 'user', content: 'Visible follow up', type: 'message' },
      { role: 'assistant', content: 'partial visible output', type: 'message' },
      { role: 'user', content: 'Start a new chain', type: 'message' }
    ]), 'next turn sends full input after stale branch invalidation');
    assertEqual(
      nextParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''),
      'new chain reply',
      'next turn reports only new-chain output'
    );
    assertEqual(
      visibleParts.filter((part) => part instanceof LanguageModelThinkingPart).map((part) => part.value).join(''),
      'partial visible reasoning',
      'visible reasoning continuation output remains unduplicated after the next turn'
    );
    assertEqual(
      warnings.some((entry) => entry.message === 'response continuation reset'),
      false,
      'new-chain request emits no continuation reset warning'
    );
  } finally {
    await closeServer(server);
  }
}

async function runRequestEnvelopeReuseInvalidationSmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);
    writeSseResponse(
      response,
      responseRequests.length === 1 ? 'first reply' : 'second reply',
      responseRequests.length === 1 ? 'resp_envelope_initial' : 'resp_envelope_changed'
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const originalDefaultServiceTier = configValues.defaultServiceTier;
  const originalMaxOutputTokens = configValues.maxOutputTokens;
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  configValues.defaultServiceTier = 'auto';
  configValues.maxOutputTokens = 32;

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected sol model for request envelope reuse test.');
    }

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] }],
      {},
      { report() {} },
      token
    );

    configValues.defaultServiceTier = 'fast';
    configValues.maxOutputTokens = 64;
    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] }
      ],
      {},
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 2, 'request envelope invalidation request count');
    assertEqual('previous_response_id' in responseRequests[1], false, 'request envelope change omits previous response id');
    assertEqual(responseRequests[1].service_tier, 'priority', 'request envelope change applies new service tier');
    assertEqual(responseRequests[1].max_output_tokens, 64, 'request envelope change applies new output cap');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'First request', type: 'message' },
      { role: 'assistant', content: 'first reply', type: 'message' },
      { role: 'user', content: 'Follow up', type: 'message' }
    ]), 'request envelope change replays full input');
  } finally {
    configValues.defaultServiceTier = originalDefaultServiceTier;
    configValues.maxOutputTokens = originalMaxOutputTokens;
    await closeServer(server);
  }
}

async function runToolOutputFullInputReplaySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);

    if (body.previous_response_id) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'No tool call found for function call output with call_id call_missing.',
          param: 'input'
        }
      }));
      return;
    }

    writeSseResponse(response, responseRequests.length === 1 ? 'first reply' : 'recovered reply', responseRequests.length === 1 ? 'resp_initial' : 'resp_recovered');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected sol model for tool output full-input replay test.');
    }

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] }],
      {},
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelToolCallPart('call_missing', 'read_file', { filePath: 'src/provider.ts' })]
        },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelToolResultPart('call_missing', [new vscodeMock.LanguageModelTextPart('file contents')])]
        }
      ],
      {},
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 2, 'tool output full-input replay request count');
    assertEqual('previous_response_id' in responseRequests[1], false, 'tool output full-input replay omits previous response id');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'First request', type: 'message' },
      { type: 'function_call', call_id: 'call_missing', name: 'read_file', arguments: '{"filePath":"src/provider.ts"}' },
      { type: 'function_call_output', call_id: 'call_missing', output: 'file contents' }
    ]), 'tool output full-input replay');
  } finally {
    await closeServer(server);
  }
}

async function runModelGeneratedToolLoopFullReplaySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (responseRequests.length === 1) {
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_tool_loop',
          type: 'function_call',
          call_id: 'call_tool_loop',
          name: 'read_file',
          arguments: ''
        }
      });
      send({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_tool_loop',
        output_index: 0,
        name: '',
        arguments: '{"filePath":"src/provider.ts"}'
      });
      send({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_tool_loop',
          type: 'function_call',
          call_id: 'call_tool_loop',
          name: 'read_file',
          arguments: '{"filePath":"src/provider.ts"}'
        }
      });
      send({ type: 'response.completed', response: { id: 'resp_tool_loop', status: 'completed' } });
    } else {
      send({ type: 'response.output_text.delta', delta: 'Tool result received.' });
      send({ type: 'response.completed', response: { id: 'resp_tool_loop_final', status: 'completed' } });
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const tool = {
    name: 'read_file',
    description: 'Reads a workspace file.',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath']
    }
  };
  const infoEvents = [];
  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    {
      debug(message, data) {
        infoEvents.push({ message, data });
      },
      info(message, data) {
        infoEvents.push({ message, data });
      },
      warn() {},
      error() {}
    },
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for generated tool-loop coverage.');
    }

    const firstParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Read provider.ts.')] }],
      { tools: [tool] },
      { report(part) { firstParts.push(part); } },
      token
    );

    const toolCalls = firstParts.filter((part) => part instanceof LanguageModelToolCallPart);
    assertEqual(toolCalls.length, 1, 'model-generated tool call is reported once');
    assertEqual(toolCalls[0].callId, 'call_tool_loop', 'model-generated tool call id');
    assertEqual(toolCalls[0].name, 'read_file', 'model-generated tool call name');
    const firstRequestStart = infoEvents.find((event) => event.message === 'provideLanguageModelChatResponse start');
    assertEqual(firstRequestStart?.data?.toolMode, null, 'omitted tool mode remains distinguishable in diagnostics');
    assertEqual(JSON.stringify(firstRequestStart?.data?.toolNames), JSON.stringify(['read_file']), 'request diagnostics record the delivered tool names');

    const secondParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Read provider.ts.')] },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelToolCallPart('call_tool_loop', 'read_file', { filePath: 'src/provider.ts' })]
        },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelToolResultPart('call_tool_loop', [new vscodeMock.LanguageModelTextPart('file contents')])]
        }
      ],
      { tools: [tool] },
      { report(part) { secondParts.push(part); } },
      token
    );

    assertEqual(responseRequests.length, 2, 'model-generated tool loop request count');
    assertEqual('previous_response_id' in responseRequests[1], false, 'tool loop full replay omits previous response id');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'Read provider.ts.', type: 'message' },
      { type: 'function_call', call_id: 'call_tool_loop', name: 'read_file', arguments: '{"filePath":"src/provider.ts"}' },
      { type: 'function_call_output', call_id: 'call_tool_loop', output: 'file contents' }
    ]), 'tool loop replays matching call and output');
    const secondRequestStart = infoEvents.filter((event) => event.message === 'provideLanguageModelChatResponse start')[1];
    const observedToolResults = secondRequestStart?.data?.observedToolResults;
    assertEqual(observedToolResults.length, 1, 'tool result observation is recorded once');
    assertEqual(observedToolResults[0].callId, 'call_tool_loop', 'observed tool result call id');
    assertEqual(observedToolResults[0].name, 'read_file', 'observed tool result name');
    assertEqual(typeof observedToolResults[0].reportedToResultObservedMs, 'number', 'observed tool result latency is numeric');
    assertEqual(typeof observedToolResults[0].responseCompletedToResultObservedMs, 'number', 'VS Code tool-loop latency after provider completion is numeric');
    assertEqual(observedToolResults[0].resultBytes > 0, true, 'observed tool result size is recorded');
    assertEqual(secondParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''), 'Tool result received.', 'tool loop continues once');

  } finally {
    configValues.transport = 'http';
    await closeServer(server);
  }
}

async function runDanglingCompletedToolCallFullReplaySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));

    if (responseRequests.length === 1) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_dangling',
          type: 'function_call',
          call_id: 'call_dangling',
          name: 'lookup_fixture',
          arguments: ''
        }
      });
      send({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_dangling',
        output_index: 0,
        name: '',
        arguments: '{"key":"sample"}'
      });
      send({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_dangling',
          type: 'function_call',
          call_id: 'call_dangling',
          name: 'lookup_fixture',
          arguments: '{"key":"sample"}'
        }
      });
      send({ type: 'response.completed', response: { id: 'resp_dangling_anchor', status: 'completed' } });
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    writeSseResponse(response, 'Full replay complete.', 'resp_dangling_replayed');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const tool = {
    name: 'lookup_fixture',
    description: 'Looks up a synthetic fixture.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key']
    }
  };
  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for dangling completed tool-call coverage.');
    }

    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Start tool turn.')] }],
      { tools: [tool] },
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Start tool turn.')] },
        {
          role: vscodeMock.LanguageModelChatMessageRole.Assistant,
          content: [new vscodeMock.LanguageModelToolCallPart('call_dangling', 'lookup_fixture', { key: 'sample' })]
        },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Use a different approach.')] }
      ],
      { tools: [tool] },
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 2, 'dangling completed tool-call request count');
    assertEqual('previous_response_id' in responseRequests[1], false, 'dangling completed tool call omits previous response id');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'Start tool turn.', type: 'message' },
      {
        role: 'assistant',
        content: 'The previous assistant turn was interrupted before tool execution. It had prepared a call to lookup_fixture with arguments {"key":"sample"}, but no tool output was produced.',
        type: 'message'
      },
      { role: 'user', content: 'Use a different approach.', type: 'message' }
    ]), 'dangling completed tool call sends normalized full input');
  } finally {
    await closeServer(server);
  }
}

async function runCreatedResponseCancellationDoesNotRecordBranchSmokeTest() {
  const responseRequests = [];
  const infoMessages = [];
  let canceledToken;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));

    if (responseRequests.length === 1) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.write(`data: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_created_only', status: 'in_progress' }
      })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    writeSseResponse(response, 'Fresh response complete.', 'resp_after_cancellation');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    {
      trace(message) {
        if (message.startsWith('[provider] response created ')) {
          canceledToken?.cancel();
        }
      },
      debug() {},
      info(message) {
        infoMessages.push(message);
      },
      warn() {},
      error() {}
    },
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const discoveryToken = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, discoveryToken);
    const model = models.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected model for created-response cancellation coverage.');
    }

    canceledToken = createMutableCancellationToken();
    const createdOnlyParts = [];
    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Cancel this turn.')] }],
      {},
      { report(part) { createdOnlyParts.push(part); } },
      canceledToken
    );
    assertEqual(canceledToken.isCancellationRequested, true, 'response.created triggers deterministic cancellation');
    assertEqual(getStatefulMarkers(createdOnlyParts).length, 0, 'created-only cancellation emits no marker');

    await provider.provideLanguageModelChatResponse(
      model,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Cancel this turn.')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Start again.')] }
      ],
      {},
      { report() {} },
      createCancellationToken()
    );

    assertEqual(responseRequests.length, 2, 'created-response cancellation request count');
    assertEqual('previous_response_id' in responseRequests[1], false, 'created-only response id is not reused');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { role: 'user', content: 'Cancel this turn.', type: 'message' },
      { role: 'user', content: 'Start again.', type: 'message' }
    ]), 'request after created-response cancellation sends full input');
    assertEqual(infoMessages.includes('response reuse miss'), false, 'created-only response is never recorded as a branch');
  } finally {
    await closeServer(server);
  }
}

async function runProviderCatalogVersionNeutralSmokeTest() {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { multi_agent_version: 'v2' }),
          createMockModel('gpt-5.6-luna', 'GPT-5.6-Luna', { multi_agent_version: 'v1' })
        ]
      }));
      return;
    }

    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = 'https://chatgpt.com/backend-api/codex/responses';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const targetUrl = new URL(requestUrl);
    targetUrl.protocol = 'http:';
    targetUrl.hostname = '127.0.0.1';
    targetUrl.port = String(address.port);
    return originalFetch(targetUrl, init);
  };

  try {
    const token = createCancellationToken();
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(models.map((model) => model.id).join(','), 'codex::gpt-5.6-sol,codex::gpt-5.6-luna', 'multi-agent version does not affect discovery visibility');
  } finally {
    globalThis.fetch = originalFetch;
    await closeServer(server);
  }
}

async function runProviderUnavailableScopeSmokeTest() {
  const requestedModels = [];

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol'),
          createMockModel('gpt-5.6-luna', 'GPT-5.6-Luna')
        ]
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestedModels.push(`${configValues.transport}:${body.model}`);

    if (body.model === 'gpt-5.6-luna') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Model not found gpt-5.6-luna',
          type: 'invalid_request_error',
          param: 'model',
          code: null
        }
      }));
      return;
    }

    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const initialModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const lunaModel = initialModels.find((item) => item.id === 'codex::gpt-5.6-luna');
    if (!lunaModel) {
      throw new Error('Expected luna model to be discoverable before scoped unavailability check.');
    }

    try {
      await provider.provideLanguageModelChatResponse(
        lunaModel,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      assertEqual(error instanceof Error, true, 'scoped unavailability request throws an Error');
    }

    const httpModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(httpModels.some((item) => item.id === 'codex::gpt-5.6-luna'), false, 'same transport hides temporarily unavailable model');

    configValues.transport = 'websocket';
    const websocketModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(websocketModels.some((item) => item.id === 'codex::gpt-5.6-luna'), true, 'temporarily unavailable cache is scoped by transport');
    assertEqual(requestedModels.join(','), 'http:gpt-5.6-luna', 'scoped unavailability test issues only one failing request');
  } finally {
    configValues.transport = 'http';
    await closeServer(server);
  }
}

function createCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    }
  };
}

function createMutableCancellationToken() {
  let canceled = false;
  const listeners = new Set();
  return {
    get isCancellationRequested() {
      return canceled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      if (canceled) {
        return;
      }
      canceled = true;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

function writeSseResponse(response, text, responseId) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed' } })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function writeSseResponseWithOutputItem(response, text, responseId, itemId) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
  response.write(`data: ${JSON.stringify({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: itemId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    }
  })}\n\n`);
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed' } })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function runProviderVirtualToolFallbackNotificationSmokeTest() {
  const savedConfig = { ...configValues };
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.5', 'GPT-5.5')] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    writeSseResponse(response, 'virtual fallback', `resp_virtual_${responseRequests.length}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  Object.assign(configValues, {
    baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    transport: 'http',
    model: 'gpt-5.5',
    nativeToolSearch: 'enabled',
    disabledModels: [],
    modelAliases: {}
  });
  const globalState = new Map();
  const provider = new CodexModelProvider(
    {
      secrets: { async get() { return 'test-api-key'; } },
      globalState: { get: (key) => globalState.get(key), update: async (key, value) => globalState.set(key, value) },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );
  const virtualTool = { name: 'activate_group_workspace', description: 'Activate workspace tools', inputSchema: { type: 'object' } };
  const warningCount = warningMessages.length;

  try {
    const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, createCancellationToken());
    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Inspect the workspace.')] }],
      { tools: [virtualTool] },
      { report() {} },
      createCancellationToken()
    );
    await provider.provideLanguageModelChatResponse(
      model,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Inspect the workspace again.')] }],
      { tools: [virtualTool] },
      { report() {} },
      createCancellationToken()
    );

    assertEqual(responseRequests[0].tools[0].name, 'activate_group_workspace', 'Virtual Tool fallback preserves the VS Code placeholder for this request');
    assertEqual(warningMessages.length, warningCount + 1, 'Virtual Tool fallback warns once for a persistent placeholder set');
    assertEqual(
      warningMessages.at(-1)?.includes('falling back to VS Code Virtual Tools'),
      true,
      'Virtual Tool fallback explains the actual runtime behavior to the user'
    );
  } finally {
    Object.assign(configValues, savedConfig);
    delete configValues.nativeToolSearch;
    await closeServer(server);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function isStatefulMarkerPart(part) {
  return part instanceof LanguageModelDataPart && part.mimeType.toLowerCase() === 'stateful_marker';
}

function getStatefulMarkers(parts) {
  return parts
    .filter(isStatefulMarkerPart)
    .map((part) => decodeStatefulMarker(part));
}

function getSingleStatefulMarkerPart(parts, label) {
  const markers = parts.filter(isStatefulMarkerPart);
  assertEqual(markers.length, 1, `${label} emits exactly one marker`);
  return markers[0];
}

function decodeStatefulMarker(part) {
  return new TextDecoder('utf-8', { fatal: true }).decode(part.data);
}

function createStatefulMarkerPart(value) {
  return vscodeMock.LanguageModelDataPart.text(value, 'stateful_marker');
}

function createSystemMessage(instructions) {
  return {
    role: vscodeMock.LanguageModelChatMessageRole.System,
    content: [new vscodeMock.LanguageModelTextPart(instructions)]
  };
}

function createAgentHostContinuationMessages(markerPart, instructions, delta) {
  return [
    {
      role: vscodeMock.LanguageModelChatMessageRole.Assistant,
      content: [markerPart]
    },
    createSystemMessage(instructions),
    {
      role: vscodeMock.LanguageModelChatMessageRole.User,
      content: [new vscodeMock.LanguageModelTextPart(delta)]
    }
  ];
}

async function assertLocalMarkerFailure(request, responseRequests, expectedRequestCount, label) {
  let failureMessage = '';
  try {
    await request();
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }
  assertEqual(failureMessage, 'Stateful continuation marker could not be resolved locally.', `${label} uses the fixed local error`);
  assertEqual(responseRequests.length, expectedRequestCount, `${label} sends zero backend requests`);
}

async function runProviderModelDiscoveryPolicySmokeTest() {
  const responseRequests = [];
  const requestedModels = [];
  const requestedReasoningEfforts = [];
  const selectedModels = [];

  configValues.disabledModels = ['gpt-5.4'];
  configValues.modelAliases = {};

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('gpt-5.4', 'GPT-5.4', {
            context_window: 272000,
            max_context_window: 1000000
          }),
          createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { multi_agent_version: 'v2' })
        ]
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responseRequests.push(body);
    requestedModels.push(body.model);
    requestedReasoningEfforts.push(body.reasoning?.effort ?? 'none');
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write('data: {"type":"response.output_text.delta","delta":"alias ok"}\n\n');
    response.write('data: {"type":"response.completed","response":{"id":"resp_alias","object":"response","status":"completed"}}\n\n');
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    {
      setSelectedModel(model) {
        selectedModels.push(model);
      }
    },
    undefined
  );

  try {
    const token = createCancellationToken();
    const disabledModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      disabledModels.map((model) => model.id).join(','),
      'codex::gpt-5.6-sol',
      'disabling a real slug filters both standard and long profiles'
    );

    configValues.disabledModels = ['gpt-5.4', 'gpt-5.6-sol'];
    const allDisabledModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(allDisabledModels.length, 0, 'disabling every discovered slug returns an empty picker catalog');

    let allDisabledResponseMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        {
          id: 'codex::gpt-5.4',
          name: 'GPT-5.4',
          family: 'gpt-5.4',
          version: 'mock',
          maxInputTokens: 258400
        },
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Disabled')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      allDisabledResponseMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(
      allDisabledResponseMessage,
      'No Codex models are available after applying the configured discovery policy.',
      'stale selection cannot bypass an all-disabled catalog'
    );
    assertEqual(requestedModels.length, 0, 'all-disabled stale selection never reaches Responses');

    configValues.disabledModels = [];
    configValues.modelAliases = { 'gpt-5.4': 'gpt-5.6-sol' };
    const aliasedModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      aliasedModels.map((model) => model.id).join(','),
      'codex::gpt-5.6-sol',
      'aliasing a real slug filters both standard and long source profiles'
    );

    await provider.provideLanguageModelChatResponse(
      {
        id: 'codex::gpt-5.4::reasoning=high',
        name: 'GPT-5.4 (Stale alias source)',
        family: 'gpt-5.4',
        version: 'mock',
        maxInputTokens: 258400
      },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] }],
      {},
      { report() {} },
      token
    );

    assertEqual(requestedModels.join(','), 'gpt-5.6-sol', 'stale profile suffix is never sent and alias applies to the real slug');
    assertEqual(selectedModels.join(','), 'gpt-5.6-sol', 'profile alias updates selected model to the real slug');
    assertEqual(requestedReasoningEfforts.join(','), 'high', 'profile alias preserves parsed reasoning effort');

    const aliasTargetModel = aliasedModels.find((model) => model.id === 'codex::gpt-5.6-sol');
    if (!aliasTargetModel) {
      throw new Error('Expected the alias target model in the filtered catalog.');
    }
    await provider.provideLanguageModelChatResponse(
      { ...aliasTargetModel, id: `${aliasTargetModel.id}::reasoning=high` },
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('alias ok')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] }
      ],
      {},
      { report() {} },
      token
    );
    assertEqual(requestedModels.join(','), 'gpt-5.6-sol,gpt-5.6-sol', 'alias target handles the follow-up request');
    assertEqual(selectedModels.join(','), 'gpt-5.6-sol,gpt-5.6-sol', 'alias target remains selected for follow-up');
    assertEqual(
      responseRequests[1].previous_response_id,
      'resp_alias',
      'authoritative catalog supplies the alias target budget for compatible reuse'
    );
    assertEqual(
      JSON.stringify(responseRequests[1].input),
      JSON.stringify([{ role: 'user', content: 'Follow up', type: 'message' }]),
      'authoritative alias target budget keeps the compatible follow-up incremental'
    );
  } finally {
    configValues.disabledModels = [];
    configValues.modelAliases = {};
    await closeServer(server);
  }
}

async function runProviderNestedAliasPolicySmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('alias-a', 'Alias A'),
          createMockModel('alias-b', 'Alias B'),
          createMockModel('alias-d', 'Alias D'),
          createMockModel('alias-c', 'Alias C')
        ]
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    writeSseResponse(response, 'nested alias ok', `resp_nested_${responseRequests.length}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  configValues.disabledModels = [];
  configValues.modelAliases = {
    'alias-a': 'alias-b',
    'alias-b': 'alias-c'
  };

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const chainedModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      chainedModels.map((model) => model.id).join(','),
      'codex::alias-d,codex::alias-c',
      'nested aliases hide their sources while retaining unrelated and final target models'
    );

    await provider.provideLanguageModelChatResponse(
      {
        id: 'codex::alias-a',
        name: 'Alias A (Stale)',
        family: 'alias-a',
        version: 'mock',
        maxInputTokens: 258400
      },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Resolve nested alias')] }],
      {},
      { report() {} },
      token
    );
    assertEqual(responseRequests[0]?.model, 'alias-c', 'stale nested alias resolves through the post-policy catalog');

    configValues.modelAliases = {
      'alias-a': 'alias-b',
      'alias-b': 'alias-a'
    };
    const cyclicModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      cyclicModels.map((model) => model.id).join(','),
      'codex::alias-d,codex::alias-c',
      'cyclic alias sources are hidden while unrelated models remain available'
    );

    let cyclicAliasMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        {
          id: 'codex::alias-a',
          name: 'Alias A (Stale cycle)',
          family: 'alias-a',
          version: 'mock',
          maxInputTokens: 258400
        },
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Reject alias cycle')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      cyclicAliasMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(
      cyclicAliasMessage,
      'Model alias cycle detected for "alias-a".',
      'stale cyclic alias is rejected instead of falling back to an unrelated model'
    );
    assertEqual(responseRequests.length, 1, 'cyclic alias never reaches Responses');

    configValues.modelAliases = {
      'alias-a': 'alias-missing',
      'alias-missing': 'alias-external'
    };
    const undiscoveredTargetModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      undiscoveredTargetModels.map((model) => model.id).join(','),
      'codex::alias-a,codex::alias-b,codex::alias-d,codex::alias-c',
      'alias source remains visible when its terminal target is not in discovery'
    );

    await provider.provideLanguageModelChatResponse(
      {
        id: 'codex::alias-a',
        name: 'Alias A (External target)',
        family: 'alias-a',
        version: 'mock',
        maxInputTokens: 258400
      },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Resolve external alias')] }],
      {},
      { report() {} },
      token
    );
    assertEqual(
      responseRequests[1]?.model,
      'alias-a',
      'authoritative catalog keeps the discovered source when the terminal alias target is unavailable'
    );
  } finally {
    configValues.disabledModels = [];
    configValues.modelAliases = {};
    await closeServer(server);
  }
}

async function runProviderAuthoritativeCatalogSmokeTest() {
  let catalog = [];
  let failDiscovery = false;
  let stallDiscovery = false;
  let notifyStalledDiscoveryStarted;
  let releaseStalledDiscovery;
  let modelRequestCount = 0;
  let responseRequestCount = 0;
  let tokenCountRequestCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      modelRequestCount += 1;
      if (failDiscovery) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'models unavailable' } }));
        return;
      }
      if (stallDiscovery) {
        notifyStalledDiscoveryStarted?.();
        await new Promise((resolve) => {
          releaseStalledDiscovery = resolve;
        });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: catalog }));
      return;
    }

    for await (const _chunk of request) {
      // Consume the request before returning the deterministic response.
    }
    if (request.url?.endsWith('/responses/input_tokens')) {
      tokenCountRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 999 }));
      return;
    }

    responseRequestCount += 1;
    writeSseResponse(response, 'unexpected stale response', 'resp_unexpected_stale');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  configValues.disabledModels = [];
  configValues.modelAliases = {};
  const originalDateNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );
  const staleModel = {
    id: 'codex::gpt-5.4',
    name: 'GPT-5.4 (Stale)',
    family: 'gpt-5.4',
    version: 'mock',
    maxInputTokens: 258400
  };

  try {
    const token = createCancellationToken();
    const emptyModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(emptyModels.length, 0, 'successful empty catalog is authoritative');

    let staleResponseMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        staleModel,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Do not send')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      staleResponseMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(
      staleResponseMessage,
      'No Codex models are available after applying the configured discovery policy.',
      'authoritative empty catalog rejects a stale provider model id'
    );
    assertEqual(responseRequestCount, 0, 'authoritative empty catalog never reaches Responses');

    const emptyCatalogTokenCount = await provider.provideTokenCount(staleModel, '12345678', token);
    assertEqual(emptyCatalogTokenCount, 2, 'empty catalog token count uses the local estimate');
    assertEqual(tokenCountRequestCount, 0, 'empty catalog token count skips the official endpoint');

    catalog = [createMockModel('gpt-5.4', 'GPT-5.4')];
    configValues.disabledModels = ['gpt-5.4'];
    const allFilteredModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(allFilteredModels.length, 0, 'all-filtered catalog is authoritative');

    const allFilteredTokenCount = await provider.provideTokenCount(staleModel, '12345678', token);
    assertEqual(allFilteredTokenCount, 2, 'all-filtered token count uses the local estimate');
    assertEqual(tokenCountRequestCount, 0, 'all-filtered token count skips the official endpoint');

    catalog = [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')];
    configValues.disabledModels = [];
    configValues.clientVersion = 'non-empty-test';
    const nonEmptyModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(nonEmptyModels.map((model) => model.id).join(','), 'codex::gpt-5.6-sol', 'non-empty authoritative catalog');

    let missingModelMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        staleModel,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Reject missing stale model')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      missingModelMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(
      missingModelMessage,
      'Selected Codex model "gpt-5.4" is not available in the authoritative model catalog.',
      'non-empty authoritative catalog rejects a missing stale model'
    );
    assertEqual(responseRequestCount, 0, 'missing stale model never reaches Responses');

    const missingModelTokenCount = await provider.provideTokenCount(staleModel, '12345678', token);
    assertEqual(missingModelTokenCount, 2, 'missing authoritative model token count uses the local estimate');
    assertEqual(tokenCountRequestCount, 0, 'missing authoritative model token count skips the official endpoint');

    const prefixStaleModel = {
      ...staleModel,
      id: 'codex::gpt-5.6-sol-preview',
      family: 'gpt-5.6-sol-preview'
    };
    let prefixModelMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        prefixStaleModel,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Reject prefix-like stale model')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      prefixModelMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(
      prefixModelMessage,
      'Selected Codex model "gpt-5.6-sol-preview" is not available in the authoritative model catalog.',
      'authoritative catalog rejects implicit prefix remapping'
    );
    assertEqual(responseRequestCount, 0, 'prefix-like stale model never reaches Responses');

    const prefixModelTokenCount = await provider.provideTokenCount(prefixStaleModel, '12345678', token);
    assertEqual(prefixModelTokenCount, 2, 'prefix-like stale model token count uses the local estimate');
    assertEqual(tokenCountRequestCount, 0, 'prefix-like stale model token count skips the official endpoint');

    const modelRequestsBeforeFailedRefresh = modelRequestCount;
    now += 60 * 60 * 1000 + 1;
    failDiscovery = true;
    const expiredCatalogTokenCount = await provider.provideTokenCount(staleModel, '12345678', token);
    assertEqual(expiredCatalogTokenCount, 2, 'failed refresh retains the expired authoritative catalog');
    assertEqual(modelRequestCount, modelRequestsBeforeFailedRefresh + 1, 'expired authoritative catalog attempts one refresh');
    assertEqual(tokenCountRequestCount, 0, 'failed authoritative refresh skips the official endpoint for a missing model');

    let expiredCatalogResponseMessage = '';
    try {
      await provider.provideLanguageModelChatResponse(
        staleModel,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Still reject missing stale model')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      expiredCatalogResponseMessage = error instanceof Error ? error.message : String(error);
    }
    assertEqual(
      expiredCatalogResponseMessage,
      'Selected Codex model "gpt-5.4" is not available in the authoritative model catalog.',
      'failed refresh does not replace authoritative catalog with fallback'
    );
    assertEqual(responseRequestCount, 0, 'failed authoritative refresh never enables stale Responses requests');

    failDiscovery = false;
    configValues.clientVersion = 'cancel-test';
    const canceledToken = {
      isCancellationRequested: true,
      onCancellationRequested() {
        return { dispose() {} };
      }
    };
    let cancellationRejected = false;
    try {
      await provider.provideTokenCount(staleModel, '12345678', canceledToken);
    } catch {
      cancellationRejected = true;
    }
    assertEqual(cancellationRejected, true, 'canceled discovery rejects instead of returning an estimate');

    const postCancellationModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      postCancellationModels.map((model) => model.id).join(','),
      'codex::gpt-5.6-sol',
      'canceled discovery does not cache a synthetic fallback catalog'
    );

    configValues.clientVersion = 'concurrent-cancel-test';
    stallDiscovery = true;
    const stalledDiscoveryStarted = new Promise((resolve) => {
      notifyStalledDiscoveryStarted = resolve;
    });
    const leaderToken = createMutableCancellationToken();
    const canceledLeader = provider.provideTokenCount(staleModel, '12345678', leaderToken);
    await stalledDiscoveryStarted;
    const uncanceledFollower = provider.provideLanguageModelChatInformation({ silent: true }, token);
    await Promise.resolve();
    leaderToken.cancel();
    releaseStalledDiscovery?.();

    const concurrentResults = await Promise.allSettled([canceledLeader, uncanceledFollower]);
    assertEqual(concurrentResults[0].status, 'rejected', 'canceled discovery leader rejects');
    assertEqual(concurrentResults[1].status, 'fulfilled', 'uncanceled discovery follower survives leader cancellation');
    assertEqual(
      concurrentResults[1].status === 'fulfilled'
        ? concurrentResults[1].value.map((model) => model.id).join(',')
        : '',
      'codex::gpt-5.6-sol',
      'uncanceled discovery follower receives the shared catalog'
    );

    stallDiscovery = false;
    notifyStalledDiscoveryStarted = undefined;
    releaseStalledDiscovery = undefined;
    const postConcurrentCancellationModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(
      postConcurrentCancellationModels.map((model) => model.id).join(','),
      'codex::gpt-5.6-sol',
      'independent cancellation leaves the shared catalog cached'
    );

    configValues.clientVersion = 'concurrent-follower-cancel-test';
    stallDiscovery = true;
    const followerCancellationDiscoveryStarted = new Promise((resolve) => {
      notifyStalledDiscoveryStarted = resolve;
    });
    const uncanceledLeader = provider.provideLanguageModelChatInformation({ silent: true }, token);
    await followerCancellationDiscoveryStarted;
    const followerToken = createMutableCancellationToken();
    const canceledFollower = provider.provideTokenCount(staleModel, '12345678', followerToken);
    await Promise.resolve();
    followerToken.cancel();
    releaseStalledDiscovery?.();

    const followerCancellationResults = await Promise.allSettled([uncanceledLeader, canceledFollower]);
    assertEqual(followerCancellationResults[0].status, 'fulfilled', 'uncanceled discovery leader survives follower cancellation');
    assertEqual(followerCancellationResults[1].status, 'rejected', 'canceled discovery follower stops waiting independently');

    stallDiscovery = false;
    notifyStalledDiscoveryStarted = undefined;
    releaseStalledDiscovery = undefined;
  } finally {
    releaseStalledDiscovery?.();
    Date.now = originalDateNow;
    configValues.clientVersion = '0.0.0';
    configValues.disabledModels = [];
    configValues.modelAliases = {};
    await closeServer(server);
  }
}

async function runProviderStaleModelRefreshDoesNotBlockResponseSmokeTest() {
  let responseRequestCount = 0;
  let resolveResponseRequest;
  const responseRequestStarted = new Promise((resolve) => {
    resolveResponseRequest = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unexpected request.' } }));
      return;
    }

    for await (const _chunk of request) {
      // Consume the request before emitting the deterministic stream.
    }
    responseRequestCount += 1;
    resolveResponseRequest();
    writeSseResponse(response, 'stale cache response', 'resp_stale_cache');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let now = 1_000;
  let modelRequestCount = 0;
  let resolveRefreshStarted;
  const refreshStarted = new Promise((resolve) => {
    resolveRefreshStarted = resolve;
  });
  let resolveBackgroundRefresh;
  const backgroundRefresh = new Promise((resolve) => {
    resolveBackgroundRefresh = resolve;
  });
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  Date.now = () => now;
  globalThis.fetch = async (input, init) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (new URL(requestUrl).pathname.endsWith('/models')) {
      modelRequestCount += 1;
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({
          models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')]
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      resolveRefreshStarted();
      await backgroundRefresh;
      return new Response(JSON.stringify({
        models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return originalFetch(input, init);
  };

  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(),
    undefined,
    undefined,
    undefined,
    undefined
  );

  try {
    const token = createCancellationToken();
    const initialModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const model = initialModels.find((item) => item.id === 'codex::gpt-5.6-sol');
    if (!model) {
      throw new Error('Expected a discovered model for stale-cache coverage.');
    }

    now += 10 * 60 * 1000 + 1;
    const response = provider.provideLanguageModelChatResponse(
      { ...model, id: 'gpt-5.6-sol' },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Continue without waiting for /models.')] }],
      {},
      { report() {} },
      token
    );

    await Promise.all([refreshStarted, responseRequestStarted]);
    assertEqual(modelRequestCount, 2, 'stale cache starts one background model refresh');
    assertEqual(responseRequestCount, 1, 'stale cache does not block the Responses request');

    resolveBackgroundRefresh();
    await response;
  } finally {
    resolveBackgroundRefresh?.();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    await closeServer(server);
  }
}

async function runProviderModelIdDoesNotBlockColdDiscoverySmokeTest() {
  let modelRequestCount = 0;
  let responseRequestCount = 0;
  let resolveModelRequestStarted;
  const modelRequestStarted = new Promise((resolve) => {
    resolveModelRequestStarted = resolve;
  });
  let resolveResponseRequestStarted;
  const responseRequestStarted = new Promise((resolve) => {
    resolveResponseRequestStarted = resolve;
  });
  let resolveModelResponse;
  const modelResponse = new Promise((resolve) => {
    resolveModelResponse = resolve;
  });
  const requestedModels = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      modelRequestCount += 1;
      resolveModelRequestStarted();
      await modelResponse;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol')] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequestCount += 1;
    requestedModels.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).model);
    resolveResponseRequestStarted();
    writeSseResponse(response, 'direct model response', 'resp_direct_model');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  configValues.transport = 'http';
  configValues.modelAliases = { 'gpt-5.6-luna': 'gpt-5.6-sol' };
  const latencySnapshots = [];
  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    {
      debug(message, payload) {
        if (message === 'response latency') {
          latencySnapshots.push(payload);
        }
      },
      info() {},
      warn() {},
      error() {}
    },
    undefined,
    undefined,
    undefined,
    undefined
  );
  let responsePromise;

  try {
    const token = createCancellationToken();
    const performanceValues = [100, 110, 116, 125, 130, 131];
    performanceNow = () => performanceValues.shift() ?? 132;
    responsePromise = provider.provideLanguageModelChatResponse(
      { id: 'codex::gpt-5.6-luna', name: 'GPT-5.6-Luna', family: 'gpt-5.6-luna', version: 'mock', maxInputTokens: 372000 },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Continue from the selected model.')] }],
      {},
      { report() {} },
      token
    );

    const firstRequest = await Promise.race([
      modelRequestStarted.then(() => 'models'),
      responseRequestStarted.then(() => 'response')
    ]);
    assertEqual(firstRequest, 'response', 'provider model id bypasses cold model discovery');
    assertEqual(modelRequestCount, 0, 'provider model id does not request /models before Responses');
    assertEqual(responseRequestCount, 1, 'provider model id reaches Responses');
    assertEqual(requestedModels.join(','), 'gpt-5.6-sol', 'provider model id applies configured alias directly');
    await responsePromise;
    assertEqual(latencySnapshots.length, 1, 'provider emits one latency snapshot');
    assertEqual(latencySnapshots[0].context.requestBuildMs, 25, 'provider request build timing starts after message conversion');
  } finally {
    resolveModelResponse();
    await responsePromise?.catch(() => undefined);
    performanceNow = () => Date.now();
    configValues.modelAliases = {};
    await closeServer(server);
  }
}

async function runLocalTokenEstimateDiagnosticSmokeTest() {
  const originalBaseURL = configValues.baseURL;
  const logs = [];
  configValues.baseURL = 'https://chatgpt.com/backend-api/codex/responses';
  const provider = new CodexModelProvider(
    {
      secrets: {
        async get() {
          return 'test-api-key';
        }
      },
      subscriptions: []
    },
    createOutputChannel(logs),
    undefined,
    undefined,
    undefined,
    undefined
  );
  const model = {
    id: 'codex::gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    family: 'gpt-5.6-luna',
    version: 'mock',
    maxInputTokens: 258400
  };

  try {
    const token = createCancellationToken();
    await provider.provideTokenCount(model, '12345678', token);
    await provider.provideTokenCount(model, '12345678', token);
    const localEstimateLogs = logs.filter((entry) => entry.level === 'trace'
      && entry.message.includes('provideTokenCount using local estimate (first occurrence)'));
    assertEqual(localEstimateLogs.length, 1, 'known local token-count estimate is logged only once');
    assertEqual(localEstimateLogs[0].message.includes('subsequentOccurrencesSuppressed'), true, 'local estimate log explains suppression');
  } finally {
    configValues.baseURL = originalBaseURL;
  }
}

function createMockModel(slug, displayName, overrides = {}) {
  return {
    slug,
    display_name: displayName,
    description: 'Mock model',
    context_window: 372000,
    input_modalities: ['text'],
    supported_in_api: true,
    visibility: 'list',
    comp_hash: 'mockhash',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Low reasoning' },
      { effort: 'medium', description: 'Medium reasoning' }
    ],
    ...overrides
  };
}

function createOutputChannel(logs) {
  const record = (level) => (message) => logs?.push({ level, message });
  return {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error')
  };
}
