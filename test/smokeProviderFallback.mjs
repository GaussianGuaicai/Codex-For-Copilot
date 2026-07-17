import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-provider-fallback-'));
const bundlePath = join(tempDir, 'provider.cjs');
const modelsBundlePath = join(tempDir, 'models.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

const configValues = {
  baseURL: '',
  clientVersion: '0.0.0',
  credentialsSource: 'secretStorage',
  transport: 'http',
  model: 'gpt-5.5',
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

  return moduleLoad.call(this, request, parent, isMain);
};

const { CodexModelProvider } = require(bundlePath);
const { buildFallbackModel, buildProviderModels, effectiveInputTokens, fetchAvailableModels } = require(modelsBundlePath);

try {
  await runModelCatalogMetadataSmokeTest();
  await runProviderLongContextSelectionSmokeTest();
  await runProviderFallbackSmokeTest();
  await runHttpContinuationRecoverySmokeTest();
  await runProviderCatalogVersionNeutralSmokeTest();
  await runProviderUnavailableScopeSmokeTest();
  await runProviderModelDiscoveryPolicySmokeTest();
  console.log('Smoke test passed: provider advertises truthful context profiles, sends real model slugs, and keeps runtime availability policy intact.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

async function runModelCatalogMetadataSmokeTest() {
  const catalog = [
    createMockModel('gpt-5.4', 'GPT-5.4', {
      context_window: 272000,
      max_context_window: 1000000,
      input_modalities: ['text', 'image']
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
    })
  ];
  let catalogRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      catalogRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: catalog }));
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
    const accountCatalog = await fetchAvailableModels(config, {
      ...sharedCredentials,
      kind: 'codexAccessToken'
    }, token);
    const apiKeyCatalog = await fetchAvailableModels(config, {
      ...sharedCredentials,
      kind: 'openaiApiKey',
      omitMaxOutputTokens: false
    }, token);

    assertEqual(
      accountCatalog.map((model) => model.slug).join(','),
      'gpt-5.4,gpt-5.3-codex-spark,codex-auto-review',
      'Codex account catalog retains API-ineligible account models and hidden Auto Review'
    );
    assertEqual(
      apiKeyCatalog.map((model) => model.slug).join(','),
      'gpt-5.4,codex-auto-review',
      'API-key catalog filters API-ineligible models while retaining Auto Review policy'
    );

    const resolvedModels = buildProviderModels(config, accountCatalog, 'codexAccessToken');
    const gpt54 = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.4');
    const gpt54Long = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.4::context=1000000');
    const spark = resolvedModels.find((model) => model.info.id === 'codex::gpt-5.3-codex-spark');
    const autoReview = resolvedModels.find((model) => model.info.id === 'codex::codex-auto-review');
    if (!gpt54 || !gpt54Long || !spark || !autoReview) {
      throw new Error('Expected GPT-5.4 standard/long, Spark, and Auto Review model metadata.');
    }

    const formattedActiveContext = (272000).toLocaleString();
    const formattedActiveUsable = (258400).toLocaleString();
    const formattedMaximumContext = (1000000).toLocaleString();
    assertEqual(effectiveInputTokens(333001), 316350, 'effective input budget floors to 95 percent');
    assertEqual(gpt54.info.maxInputTokens, 258400, 'GPT-5.4 standard effective input budget');
    assertEqual(
      gpt54.info.detail?.includes(
        `Standard context: ${formattedActiveUsable} usable tokens (${formattedActiveContext}-token raw active window) | Maximum context: ${formattedMaximumContext} tokens (opt-in)`
      ),
      true,
      'GPT-5.4 standard detail distinguishes usable, active, and maximum context'
    );
    assertEqual(gpt54Long.info.name, 'GPT-5.4 (Long context)', 'GPT-5.4 long profile name');
    assertEqual(gpt54Long.info.maxInputTokens, 950000, 'GPT-5.4 long effective input budget');
    assertEqual(gpt54Long.requestModel, 'gpt-5.4', 'GPT-5.4 long profile keeps real request model');
    assertEqual(
      gpt54Long.info.detail?.includes('Long context: 950,000 usable tokens (1,000,000-token window)'),
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
    assertEqual(autoReview.info.maxInputTokens, 258400, 'Auto Review standard effective input budget');
    assertEqual(
      autoReview.info.detail?.includes(`Maximum context: ${formattedMaximumContext} tokens (opt-in)`),
      true,
      'Auto Review maximum context detail'
    );
    assertEqual(spark.info.id, 'codex::gpt-5.3-codex-spark', 'Spark provider model id');
    assertEqual(spark.info.maxInputTokens, 121600, 'Spark standard effective input budget');
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
    assertEqual(discoveredOverride?.info.maxInputTokens, 316350, 'valid discovered context gets a 95-percent effective budget');
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
    assertEqual(sparkFallback.info.maxInputTokens, 121600, 'Spark effective fixed fallback context');
    assertEqual(sparkFallback.info.capabilities?.imageInput, false, 'Spark fallback text-only capability');

    const defaultFallback = buildFallbackModel(config, 'codexAccessToken');
    assertEqual(defaultFallback.info.maxInputTokens, 258400, 'default fallback uses effective context budget');
    assertEqual(
      defaultFallback.info.detail?.includes(`Standard context: ${formattedActiveUsable} usable tokens (${formattedActiveContext}-token raw active window)`),
      true,
      'fallback detail distinguishes usable and raw selected window'
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
      assertEqual(standardModel.info.maxInputTokens, 258400, `${slug} advertises effective standard context`);
      assertEqual(
        standardModel.info.detail?.includes(`Known raw context ceiling: ${formattedKnownCeiling} tokens`),
        true,
        `${slug} shows known raw context ceiling`
      );
      assertEqual(longModel.info.maxInputTokens, 353400, `${slug} advertises exact long effective context`);
      assertEqual(longModel.requestModel, slug, `${slug} long profile keeps real request model`);
      assertEqual(longModel.info.name, `${standardModel.info.name} (Long context)`, `${slug} long profile name`);
      assertEqual(
        longModel.info.detail?.includes('Long context: 353,400 usable tokens (372,000-token window)'),
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
      'GPT-5.6-Sol First,GPT-5.6-Sol First (Long context)',
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
    assertEqual(promotedModel.info.maxInputTokens, 353400, 'future 372K catalog value gets an effective standard budget');
    assertEqual(promotedModel.info.detail?.includes('Known raw context ceiling:'), false, 'active 372K omits redundant known ceiling');
    assertEqual(promotedModels.length, 1, 'active 372K catalog does not duplicate the long profile');

    const activeMillionModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.4', 'GPT-5.4', { context_window: 1000000, max_context_window: 1000000 })
    ], 'codexAccessToken');
    assertEqual(activeMillionModels.length, 1, 'active GPT-5.4 1M catalog does not duplicate the long profile');
    assertEqual(activeMillionModels[0].info.maxInputTokens, 950000, 'active GPT-5.4 1M standard budget is effective');

    const nearMatchModels = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.4-preview', 'GPT-5.4 Preview', { context_window: 272000, max_context_window: 1000000 })
    ], 'codexAccessToken');
    assertEqual(nearMatchModels.length, 1, 'non-exact GPT-5.4 slug has no long profile');

    const fallbackCeiling = buildFallbackModel({
      ...chatGptConfig,
      model: 'gpt-5.6-sol'
    }, 'codexAccessToken');
    assertEqual(fallbackCeiling.info.maxInputTokens, 258400, 'fallback keeps conservative effective context');
    assertEqual(
      fallbackCeiling.info.detail?.includes(`Known raw context ceiling: ${formattedKnownCeiling} tokens`),
      true,
      'fallback shows known raw context ceiling'
    );
    assertEqual(catalogRequestCount, 2, 'credential-kind catalog request count');
  } finally {
    server.close();
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
    writeSseResponse(
      response,
      responseRequests.length === 1 ? 'first reply' : 'long reply',
      responseRequests.length === 1 ? 'resp_standard' : 'resp_long'
    );
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

    assertEqual(responseRequests.length, 2, 'standard-to-long request count');
    assertEqual(selectedModels.join(','), 'gpt-5.4,gpt-5.4', 'both profiles resolve to the real selected model');
    assertEqual(responseRequests[0].model, 'gpt-5.4', 'standard profile sends real backend model');
    assertEqual(responseRequests[1].model, 'gpt-5.4', 'long profile sends real backend model');
    assertEqual(responseRequests[1].previous_response_id, 'resp_standard', 'long profile reuses the standard profile branch');
    assertEqual(
      JSON.stringify(responseRequests[1].input),
      JSON.stringify([{ role: 'user', content: 'Follow up', type: 'message' }]),
      'long profile continuation sends only appended input'
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

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
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

  const outputChannel = {
    debug() {},
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

    try {
      await provider.provideLanguageModelChatResponse(
        novaModel,
        [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] }],
        {},
        { report() {} },
        token
      );
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }

    const refreshedModels = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(requestedModels.join(','), 'gpt-5.6-nova', 'request order without retry');
    assertEqual(selectedModels.join(','), 'gpt-5.6-nova', 'selected model does not silently change');
    assertEqual(refreshedModels.some((item) => item.id === 'codex::gpt-5.6-nova'), false, 'rejected model hidden after temporary disable');
    assertEqual(warnings.some((entry) => entry.message === 'response model unavailable'), true, 'unavailable warning emitted');
    assertEqual(thrownMessage.includes('hidden temporarily from the model picker'), true, 'clear unavailable-model error');
  } finally {
    server.close();
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
    server.close();
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
    server.close();
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
    server.close();
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function runProviderModelDiscoveryPolicySmokeTest() {
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
        id: 'codex::gpt-5.4::context=999999::reasoning=high',
        name: 'GPT-5.4 (Stale long context)',
        family: 'gpt-5.4',
        version: 'mock',
        maxInputTokens: 949999
      },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] }],
      {},
      { report() {} },
      token
    );

    assertEqual(requestedModels.join(','), 'gpt-5.6-sol', 'stale profile suffix is never sent and alias applies to the real slug');
    assertEqual(selectedModels.join(','), 'gpt-5.6-sol', 'profile alias updates selected model to the real slug');
    assertEqual(requestedReasoningEfforts.join(','), 'high', 'profile alias preserves parsed reasoning effort');
  } finally {
    configValues.disabledModels = [];
    configValues.modelAliases = {};
    server.close();
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