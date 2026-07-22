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
    User: 'user',
    Assistant: 'assistant'
  },
  LanguageModelChatToolMode: {
    Required: 2
  },
  window: {
    async showWarningMessage() {
      throw new Error('showWarningMessage should not be called during smokeProviderFallback.');
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
  await runHttpContinuationRecoverySmokeTest();
  await runStructuredHttpContinuationRecoverySmokeTest();
  await runContinuationMissAfterVisibleOutputSmokeTest();
  await runRequestEnvelopeReuseInvalidationSmokeTest();
  await runToolOutputFullInputReplaySmokeTest();
  await runModelGeneratedToolLoopFullReplaySmokeTest();
  await runProviderCatalogVersionNeutralSmokeTest();
  await runProviderUnavailableScopeSmokeTest();
  await runProviderModelDiscoveryPolicySmokeTest();
  await runProviderNestedAliasPolicySmokeTest();
  await runProviderAuthoritativeCatalogSmokeTest();
  await runProviderStaleModelRefreshDoesNotBlockResponseSmokeTest();
  await runProviderModelIdDoesNotBlockColdDiscoverySmokeTest();
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
    const gpt54Long = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.4::context=1000000');
    const gpt54Mini = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.4-mini');
    const spark = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.3-codex-spark');
    const autoReview = resolvedModels.find((model) => model.info.id === 'codex::codex-auto-review');
    if (!gpt54 || !gpt54Long || !gpt54Mini || !spark || !autoReview) {
      throw new Error('Expected GPT-5.4 standard/long, GPT-5.4-Mini, Spark, and Auto Review model metadata.');
    }

    const formattedActiveContext = (272000).toLocaleString();
    const formattedMaximumContext = (1000000).toLocaleString();
    assertEqual(gpt54.rawContextWindow, 272000, 'GPT-5.4 standard raw context');
    assertEqual(gpt54.effectiveInputBudget, 258400, 'GPT-5.4 standard internal effective budget');
    assertEqual(gpt54.info.maxInputTokens, 258400, 'GPT-5.4 standard effective budget');
    assertEqual(
      gpt54.info.detail?.includes(
        `Effective input budget: 258,400 tokens | Raw context window: ${formattedActiveContext} tokens (active) | Maximum context: ${formattedMaximumContext} tokens (opt-in)`
      ),
      true,
      'GPT-5.4 detail distinguishes active and maximum context'
    );
    assertEqual(gpt54Long.info.name, 'GPT-5.4 (Long context)', 'GPT-5.4 long profile name');
    assertEqual(gpt54Long.rawContextWindow, 1000000, 'GPT-5.4 long raw context');
    assertEqual(gpt54Long.effectiveInputBudget, 950000, 'GPT-5.4 long internal effective budget');
    assertEqual(gpt54Long.info.maxInputTokens, 950000, 'GPT-5.4 long effective budget');
    assertEqual(gpt54Long.requestModel, 'gpt-5.4', 'GPT-5.4 long profile keeps real request model');
    assertEqual(
      gpt54Long.info.detail?.includes('Long context: 950,000 tokens effective input budget | Raw context window: 1,000,000 tokens'),
      true,
      'GPT-5.4 long profile detail'
    );
    assertEqual(gpt54Long.info.version, gpt54.info.version, 'GPT-5.4 profiles preserve version metadata');
    assertEqual(gpt54Long.info.tooltip, gpt54.info.tooltip, 'GPT-5.4 profiles preserve tooltip metadata');
    assertEqual(
      JSON.stringify(gpt54Long.info.capabilities),
      JSON.stringify(gpt54.info.capabilities),
      'GPT-5.4 profiles preserve capabilities'
    );
    assertEqual(
      JSON.stringify(gpt54Long.info.configurationSchema),
      JSON.stringify(gpt54.info.configurationSchema),
      'GPT-5.4 profiles preserve reasoning configuration'
    );
    assertEqual(gpt54Mini.info.maxInputTokens, 258400, 'GPT-5.4-Mini uses the default effective budget');
    assertEqual(
      resolvedModels.some((model) => model.info.id.startsWith('codex::gpt-5.4-mini::context=')),
      false,
      'GPT-5.4-Mini omits a redundant long profile'
    );
    assertEqual(autoReview.info.maxInputTokens, 258400, 'Auto Review standard effective budget');
    assertEqual(
      autoReview.info.detail?.includes(`Maximum context: ${formattedMaximumContext} tokens (opt-in)`),
      true,
      'Auto Review maximum context detail'
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
      'codex::gpt-5.4,codex::gpt-5.4::context=1000000',
      'duplicate GPT-5.4 rows yield one standard and one long ID'
    );
    assertEqual(
      duplicateGpt54Models.map((model) => model.info.name).join(','),
      'GPT-5.4 First,GPT-5.4 First (Long context)',
      'duplicate GPT-5.4 rows preserve first-seen metadata and order'
    );

    const discoveredOverrideModels = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4', {
        context_window: 333000,
        max_context_window: 1000000
      })
    ], 'codexAccessToken');
    const discoveredOverride = discoveredOverrideModels.find((model) => model.info.id === 'codex::gpt-5.4');
    assertEqual(discoveredOverride?.info.maxInputTokens, 316350, 'valid discovered context uses the default effective percentage');
    assertEqual(
      discoveredOverrideModels.some((model) => model.info.id === 'codex::gpt-5.4::context=1000000'),
      true,
      'valid GPT-5.4 maximum still adds the long profile'
    );

    const fractionalMetadata = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4', {
        context_window: 0.5,
        max_context_window: 0.5
      })
    ], 'codexAccessToken')[0];
    assertEqual(fractionalMetadata.info.maxInputTokens, 258400, 'fractional context below one uses effective fixed fallback');
    assertEqual(fractionalMetadata.info.detail?.includes('Maximum context:'), false, 'invalid fractional maximum is omitted');

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
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { context_window: 272000, max_context_window: 272000 }),
      createMockModel('gpt-5.6-terra', 'GPT-5.6-Terra', { context_window: 272000, max_context_window: 272000 }),
      createMockModel('gpt-5.6-luna', 'GPT-5.6-Luna', { context_window: 272000, max_context_window: 272000 }),
      createMockModel('gpt-5.6-nova', 'GPT-5.6-Nova', { context_window: 272000, max_context_window: 272000 })
    ];
    const rollbackModels = buildProviderModels(chatGptConfig, rollbackCatalog, 'codexAccessToken');
    const formattedKnownCeiling = (372000).toLocaleString();
    assertEqual(rollbackModels.length, 7, 'eligible GPT-5.6 catalog expands three exact long profiles');
    for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const standardModel = rollbackModels.find((candidate) => candidate.info.id === `codex::${slug}`);
      const longModel = rollbackModels.find((candidate) => candidate.info.id === `codex::${slug}::context=372000`);
      if (!standardModel || !longModel) {
        throw new Error(`Expected ${slug} standard and long metadata.`);
      }
      assertEqual(standardModel.info.maxInputTokens, 258400, `${slug} advertises standard effective budget`);
      assertEqual(
        standardModel.info.detail?.includes(`Known raw context ceiling: ${formattedKnownCeiling} tokens`),
        true,
        `${slug} shows known raw context ceiling`
      );
      assertEqual(longModel.rawContextWindow, 372000, `${slug} retains exact long raw context`);
      assertEqual(longModel.info.maxInputTokens, 353400, `${slug} advertises exact long effective budget`);
      assertEqual(longModel.requestModel, slug, `${slug} long profile keeps real request model`);
      assertEqual(longModel.info.name, `${standardModel.info.name} (Long context) (Experimental)`, `${slug} experimental long profile name`);
      assertEqual(
        longModel.info.detail?.includes('Long context (Experimental): 353,400 tokens effective input budget | Raw context window: 372,000 tokens'),
        true,
        `${slug} long detail is truthful`
      );
      assertEqual(longModel.info.maxOutputTokens, config.maxOutputTokens, `${slug} output metadata remains configured`);
      assertEqual(longModel.info.detail?.includes('500,000'), false, `${slug} does not expose inferred total context`);
    }
    assertEqual(
      rollbackModels.some((model) => model.info.id.includes('context=1000000')),
      false,
      'GPT-5.6 models never expose a 1M profile'
    );

    const duplicateGpt56Models = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol First', { context_window: 272000, max_context_window: 272000 }),
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol Second', { context_window: 272000, max_context_window: 272000 })
    ], 'codexAccessToken');
    assertEqual(
      duplicateGpt56Models.map((model) => model.info.id).join(','),
      'codex::gpt-5.6-sol,codex::gpt-5.6-sol::context=372000',
      'duplicate GPT-5.6 rows yield one standard and one long ID'
    );
    assertEqual(
      duplicateGpt56Models.map((model) => model.info.name).join(','),
      'GPT-5.6-Sol First,GPT-5.6-Sol First (Long context) (Experimental)',
      'duplicate GPT-5.6 rows preserve first-seen metadata and order'
    );

    const unrelatedModel = rollbackModels.find((model) => model.info.id === 'codex::gpt-5.6-nova');
    assertEqual(unrelatedModel?.info.detail?.includes('Known raw context ceiling:'), false, 'unrelated GPT-5.6 model is unchanged');
    assertEqual(
      rollbackModels.some((model) => model.info.id === 'codex::gpt-5.6-nova::context=372000'),
      false,
      'unlisted GPT-5.6 slug has no long profile'
    );

    const apiKeyModels = buildProviderModels(chatGptConfig, rollbackCatalog, 'openaiApiKey');
    assertEqual(
      apiKeyModels.some((model) => model.info.detail?.includes('Known raw context ceiling:')),
      false,
      'API-key catalog omits Codex account ceilings'
    );
    assertEqual(
      apiKeyModels.some((model) => model.info.id.includes('::context=')),
      false,
      'API-key catalog omits GPT-5.6 long profiles'
    );

    const customBackendModels = buildProviderModels(config, rollbackCatalog, 'codexAccessToken');
    assertEqual(
      customBackendModels.some((model) => model.info.detail?.includes('Known raw context ceiling:')),
      false,
      'custom backend catalog omits ChatGPT Codex ceilings'
    );
    assertEqual(
      customBackendModels.some((model) => model.info.id.includes('::context=')),
      false,
      'custom backend catalog omits GPT-5.6 long profiles'
    );

    for (const baseURL of [
      'https://chatgpt.com:444/backend-api/codex/responses',
      'https://user@chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses?proxy=1',
      'https://chatgpt.com/backend-api/codex/responses#proxy'
    ]) {
      const models = buildProviderModels({ ...chatGptConfig, baseURL }, rollbackCatalog, 'codexAccessToken');
      assertEqual(
        models.some((model) => model.info.detail?.includes('Known raw context ceiling:')),
        false,
        `noncanonical backend ${baseURL} omits known ceilings`
      );
      assertEqual(
        models.some((model) => model.info.id.includes('::context=')),
        false,
        `noncanonical backend ${baseURL} omits long profiles`
      );
    }

    const promotedModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { context_window: 372000, max_context_window: 372000 })
    ], 'codexAccessToken');
    const promotedModel = promotedModels[0];
    assertEqual(promotedModel.info.maxInputTokens, 353400, 'future active 372K catalog value uses effective budget');
    assertEqual(promotedModel.info.name.includes('(Experimental)'), false, 'active 372K catalog row is not a synthetic experimental profile');
    assertEqual(promotedModel.info.detail?.includes('Known raw context ceiling:'), false, 'active 372K omits redundant known ceiling');
    assertEqual(promotedModels.length, 1, 'active 372K catalog does not duplicate the long profile');

    const activeMillionModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.4', 'GPT-5.4', { context_window: 1000000, max_context_window: 1000000 })
    ], 'codexAccessToken');
    assertEqual(activeMillionModels.length, 1, 'active GPT-5.4 1M catalog does not duplicate the long profile');
    assertEqual(activeMillionModels[0].info.maxInputTokens, 950000, 'active GPT-5.4 1M context uses effective budget');

    const nearMatchModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.4-preview', 'GPT-5.4 Preview', { context_window: 272000, max_context_window: 1000000 })
    ], 'codexAccessToken');
    assertEqual(nearMatchModels.length, 1, 'non-exact GPT-5.4 slug has no long profile');

    const fallbackCeiling = buildFallbackModel({
      ...chatGptConfig,
      model: 'gpt-5.6-sol'
    }, 'codexAccessToken');
    assertEqual(fallbackCeiling.info.maxInputTokens, 258400, 'fallback keeps conservative effective budget');
    assertEqual(
      fallbackCeiling.info.detail?.includes(`Known raw context ceiling: ${formattedKnownCeiling} tokens`),
      true,
      'fallback shows known raw context ceiling'
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
      ['downgrade reply', 'resp_downgrade']
    ];
    const reply = replies[responseRequests.length - 1];
    if (!reply) {
      throw new Error('Unexpected extra context-profile request.');
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
    const standardModel = models.find((model) => model.id === 'codex::gpt-5.4');
    const longModel = models.find((model) => model.id === 'codex::gpt-5.4::context=1000000');
    if (!standardModel || !longModel) {
      throw new Error('Expected selectable GPT-5.4 standard and long profiles.');
    }
    assertEqual(standardModel.maxInputTokens, 258400, 'standard profile advertises effective budget');
    assertEqual(longModel.maxInputTokens, 950000, 'long profile advertises effective budget');

    await provider.provideLanguageModelChatResponse(
      standardModel,
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] }],
      {},
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      longModel,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] }
      ],
      {},
      { report() {} },
      token
    );

    await provider.provideLanguageModelChatResponse(
      standardModel,
      [
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('First request')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('first reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Follow up')] },
        { role: vscodeMock.LanguageModelChatMessageRole.Assistant, content: [new vscodeMock.LanguageModelTextPart('long reply')] },
        { role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Downgrade')] }
      ],
      {},
      { report() {} },
      token
    );

    assertEqual(responseRequests.length, 3, 'profile transition request count');
    assertEqual(selectedModels.join(','), 'gpt-5.4,gpt-5.4,gpt-5.4', 'all profiles resolve to the real selected model');
    assertEqual(responseRequests[0].model, 'gpt-5.4', 'standard profile sends real backend model');
    assertEqual(responseRequests[1].model, 'gpt-5.4', 'long profile sends real backend model');
    assertEqual(responseRequests[1].previous_response_id, 'resp_standard', 'long profile reuses the standard profile branch');
    assertEqual(
      JSON.stringify(responseRequests[1].input),
      JSON.stringify([{ role: 'user', content: 'Follow up', type: 'message' }]),
      'long profile continuation sends only appended input'
    );
    assertEqual(responseRequests[2].model, 'gpt-5.4', 'downgraded standard profile sends real backend model');
    assertEqual(responseRequests[2].previous_response_id, undefined, 'long-to-standard downgrade starts a new response chain');
    assertEqual(
      JSON.stringify(responseRequests[2].input),
      JSON.stringify([
        { role: 'user', content: 'First request', type: 'message' },
        { role: 'assistant', content: 'first reply', type: 'message' },
        { role: 'user', content: 'Follow up', type: 'message' },
        { role: 'assistant', content: 'long reply', type: 'message' },
        { role: 'user', content: 'Downgrade', type: 'message' }
      ]),
      'long-to-standard downgrade replays full caller history'
    );
    for (const body of responseRequests) {
      assertEqual(
        Object.keys(body).some((key) => key.toLowerCase().includes('context')),
        false,
        'profile request has no context-window field'
      );
      assertEqual(JSON.stringify(body).includes('::context='), false, 'profile request has no synthetic identifier');
    }
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
    },
    info(message) {
      if (message === 'getAvailableModels discovery success') {
        discoverySuccessCount += 1;
        if (discoverySuccessCount === 2) {
          resolvePreRejectionRefreshCompleted();
        }
      }
    },
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
      { type: 'thinking', value: 'Optimized ', id: 'rs_planning:0' },
      { type: 'thinking', value: 'tool selection', id: 'rs_planning:0' },
      { type: 'text', value: '我先看一下仓库的' },
      { type: 'text', value: '结构。' }
    ]), 'interleaved reasoning does not interrupt visible text streaming');
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
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial visible output' })}\n\n`);
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
      visibleParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''),
      'partial visible output',
      'visible continuation output is emitted once'
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
      visibleParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''),
      'partial visible output',
      'visible continuation output remains unduplicated after the next turn'
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
      debug() {},
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
    const recoveryTiming = infoEvents.find((event) => event.message === 'tool result recovery timing');
    assertEqual(recoveryTiming?.data?.toolResults?.length, 1, 'tool recovery timing records one result');
    assertEqual(recoveryTiming?.data?.toolResults?.[0]?.callId, 'call_tool_loop', 'tool recovery timing call id');
    assertEqual(
      typeof recoveryTiming?.data?.toolResults?.[0]?.resultObservedToRequestSentMs,
      'number',
      'tool recovery request latency is numeric'
    );
    assertEqual(secondParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''), 'Tool result received.', 'tool loop continues once');

  } finally {
    configValues.transport = 'http';
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

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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
      debug() {},
      info(message, payload) {
        if (message === 'response latency') {
          latencySnapshots.push(payload);
        }
      },
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

function createOutputChannel() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}
