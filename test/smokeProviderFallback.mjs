import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-provider-fallback-'));
const bundlePath = join(tempDir, 'provider.cjs');
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

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const { CodexModelProvider } = require(bundlePath);

try {
  await runProviderFallbackSmokeTest();
  await runHttpContinuationRecoverySmokeTest();
  await runToolOutputContinuationRecoverySmokeTest();
  await runProviderCatalogVersionNeutralSmokeTest();
  await runProviderUnavailableScopeSmokeTest();
  await runProviderModelDiscoveryPolicySmokeTest();
  console.log('Smoke test passed: provider keeps catalog discovery separate from runtime availability and temporarily disables rejected models without retrying.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
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

async function runToolOutputContinuationRecoverySmokeTest() {
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
      throw new Error('Expected sol model for tool output continuation recovery test.');
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

    assertEqual(responseRequests.length, 3, 'tool output continuation recovery request count');
    assertEqual(responseRequests[1].previous_response_id, 'resp_initial', 'tool output continuation request response id');
    assertEqual(JSON.stringify(responseRequests[1].input), JSON.stringify([
      { type: 'function_call_output', call_id: 'call_missing', output: 'file contents' }
    ]), 'tool output continuation delta input');
    assertEqual('previous_response_id' in responseRequests[2], false, 'tool output recovery omits previous response id');
    assertEqual(JSON.stringify(responseRequests[2].input), JSON.stringify([
      { role: 'user', content: 'First request', type: 'message' },
      { type: 'function_call', call_id: 'call_missing', name: 'read_file', arguments: '{"filePath":"src/provider.ts"}' },
      { type: 'function_call_output', call_id: 'call_missing', output: 'file contents' }
    ]), 'tool output recovery full input');
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
    } catch {}

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