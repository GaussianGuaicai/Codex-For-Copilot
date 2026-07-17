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
let performanceNow = () => Date.now();
const performanceMock = { now: () => performanceNow() };

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
  await runProviderFallbackSmokeTest();
  await runInterleavedResponsePresentationSmokeTest();
  await runHttpContinuationRecoverySmokeTest();
  await runRequestEnvelopeReuseInvalidationSmokeTest();
  await runToolOutputFullInputReplaySmokeTest();
  await runModelGeneratedToolLoopFullReplaySmokeTest();
  await runProviderCatalogVersionNeutralSmokeTest();
  await runProviderUnavailableScopeSmokeTest();
  await runProviderModelDiscoveryPolicySmokeTest();
  await runProviderStaleModelRefreshDoesNotBlockResponseSmokeTest();
  await runProviderModelIdDoesNotBlockColdDiscoverySmokeTest();
  console.log('Smoke test passed: provider keeps catalog discovery separate from runtime availability and temporarily disables rejected models without retrying.');
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
    const gpt54 = resolvedModels.find((model) => model.requestModel === 'gpt-5.4');
    const spark = resolvedModels.find((model) => model.requestModel === 'gpt-5.3-codex-spark');
    const autoReview = resolvedModels.find((model) => model.requestModel === 'codex-auto-review');
    if (!gpt54 || !spark || !autoReview) {
      throw new Error('Expected GPT-5.4, Spark, and Auto Review model metadata.');
    }

    const formattedActiveContext = (272000).toLocaleString();
    const formattedMaximumContext = (1000000).toLocaleString();
    assertEqual(gpt54.info.maxInputTokens, 272000, 'GPT-5.4 active context');
    assertEqual(
      gpt54.info.detail?.includes(
        `Context: ${formattedActiveContext} tokens (active) | Maximum context: ${formattedMaximumContext} tokens (opt-in)`
      ),
      true,
      'GPT-5.4 active and maximum context detail'
    );
    assertEqual(autoReview.info.maxInputTokens, 272000, 'Auto Review active context');
    assertEqual(
      autoReview.info.detail?.includes(`Maximum context: ${formattedMaximumContext} tokens (opt-in)`),
      true,
      'Auto Review maximum context detail'
    );
    assertEqual(spark.info.id, 'codex::gpt-5.3-codex-spark', 'Spark provider model id');
    assertEqual(spark.info.maxInputTokens, 128000, 'Spark active context');
    assertEqual(spark.info.capabilities?.imageInput, false, 'Spark text-only capability');
    assertEqual(spark.info.capabilities?.toolCalling, true, 'Spark tool capability');
    assertEqual(spark.info.detail?.includes('Maximum context:'), false, 'Spark omits redundant maximum context');

    const discoveredOverride = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4', {
        context_window: 333000,
        max_context_window: 1000000
      })
    ], 'codexAccessToken')[0];
    assertEqual(discoveredOverride.info.maxInputTokens, 333000, 'valid discovered context overrides fixed fallback');

    const fractionalMetadata = buildProviderModels(config, [
      createMockModel('gpt-5.4', 'GPT-5.4', {
        context_window: 0.5,
        max_context_window: 0.5
      })
    ], 'codexAccessToken')[0];
    assertEqual(fractionalMetadata.info.maxInputTokens, 272000, 'fractional context below one uses fixed fallback');
    assertEqual(fractionalMetadata.info.detail?.includes('Maximum context:'), false, 'invalid fractional maximum is omitted');

    const sparkFallback = buildFallbackModel({
      ...config,
      model: 'gpt-5.3-codex-spark'
    }, 'codexAccessToken');
    assertEqual(sparkFallback.requestModel, 'gpt-5.3-codex-spark', 'Spark fallback request model');
    assertEqual(sparkFallback.info.maxInputTokens, 128000, 'Spark fixed fallback context');
    assertEqual(sparkFallback.info.capabilities?.imageInput, false, 'Spark fallback text-only capability');

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
    for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const model = rollbackModels.find((candidate) => candidate.requestModel === slug);
      if (!model) {
        throw new Error(`Expected ${slug} rollback metadata.`);
      }
      assertEqual(model.info.maxInputTokens, 272000, `${slug} keeps authenticated active context`);
      assertEqual(
        model.info.detail?.includes(`Known raw context ceiling: ${formattedKnownCeiling} tokens`),
        true,
        `${slug} shows known raw context ceiling`
      );
      assertEqual(model.info.maxOutputTokens, config.maxOutputTokens, `${slug} output metadata remains configured`);
      assertEqual(model.info.detail?.includes('500,000'), false, `${slug} does not expose inferred total context`);
    }

    const unrelatedModel = rollbackModels.find((model) => model.requestModel === 'gpt-5.6-nova');
    assertEqual(unrelatedModel?.info.detail?.includes('Known raw context ceiling:'), false, 'unrelated GPT-5.6 model is unchanged');

    const apiKeyModels = buildProviderModels(chatGptConfig, rollbackCatalog, 'openaiApiKey');
    assertEqual(
      apiKeyModels.some((model) => model.info.detail?.includes('Known raw context ceiling:')),
      false,
      'API-key catalog omits Codex account ceilings'
    );

    const customBackendModels = buildProviderModels(config, rollbackCatalog, 'codexAccessToken');
    assertEqual(
      customBackendModels.some((model) => model.info.detail?.includes('Known raw context ceiling:')),
      false,
      'custom backend catalog omits ChatGPT Codex ceilings'
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
    }

    const promotedModel = buildProviderModels(chatGptConfig, [
      createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { context_window: 372000, max_context_window: 372000 })
    ], 'codexAccessToken')[0];
    assertEqual(promotedModel.info.maxInputTokens, 372000, 'future 372K catalog value becomes active');
    assertEqual(promotedModel.info.detail?.includes('Known raw context ceiling:'), false, 'active 372K omits redundant known ceiling');

    const fallbackCeiling = buildFallbackModel({
      ...chatGptConfig,
      model: 'gpt-5.6-sol'
    }, 'codexAccessToken');
    assertEqual(fallbackCeiling.info.maxInputTokens, 272000, 'fallback keeps conservative active context');
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
    assertEqual(secondParts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join(''), 'Tool result received.', 'tool loop continues once');
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
    } catch {}

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
  const requestedModels = [];
  const selectedModels = [];

  configValues.disabledModels = ['gpt-5.6-terra'];
  configValues.modelAliases = { 'gpt-5.6-luna': 'gpt-5.6-sol' };

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          createMockModel('gpt-5.6-sol', 'GPT-5.6-Sol', { multi_agent_version: 'v2' }),
          createMockModel('gpt-5.6-terra', 'GPT-5.6-Terra', { multi_agent_version: 'v2' }),
          createMockModel('gpt-5.6-luna', 'GPT-5.6-Luna', { multi_agent_version: 'v2' })
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
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    assertEqual(models.map((model) => model.id).join(','), 'codex::gpt-5.6-sol', 'model discovery policy filters disabled and aliased source models');

    await provider.provideLanguageModelChatResponse(
      { id: 'codex::gpt-5.6-luna', name: 'GPT-5.6-Luna', family: 'gpt-5.6-luna', version: 'mock', maxInputTokens: 372000 },
      [{ role: vscodeMock.LanguageModelChatMessageRole.User, content: [new vscodeMock.LanguageModelTextPart('Ping')] }],
      {},
      { report() {} },
      token
    );

    assertEqual(requestedModels.join(','), 'gpt-5.6-sol', 'configured alias avoids rejected model request');
    assertEqual(selectedModels.join(','), 'gpt-5.6-sol', 'configured alias updates selected model');
  } finally {
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