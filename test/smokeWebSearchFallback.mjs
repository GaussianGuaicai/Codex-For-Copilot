import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-web-search-'));
const bundlePath = join(tempDir, 'webSearchExecutor.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

const configValues = {
  baseURL: '',
  clientVersion: '0.0.0',
  credentialsSource: 'secretStorage',
  transport: 'http',
  requestCompression: 'disabled',
  model: 'gpt-5.5',
  includeHiddenModels: false,
  instructions: 'Smoke test instructions',
  defaultServiceTier: 'auto',
  defaultReasoningEffort: 'auto',
  maxOutputTokens: 32,
  disabledModels: [],
  modelAliases: {},
  modelPricingUsdPerMTok: {},
  webSearchExternalAccess: true,
  webSearchContextSize: 'default',
  webSearchAllowedDomains: [],
  webSearchStatusDetail: 'actionsAndSources',
  webSearchStatusMaxSources: 3
};

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CancellationError';
  }
}

const vscodeMock = {
  version: '1.104.0',
  CancellationError,
  LanguageModelChatToolMode: { Required: 2 },
  workspace: {
    getConfiguration(section) {
      if (section === 'http') {
        return { get: () => undefined };
      }
      if (section !== 'codexModelProvider') {
        throw new Error(`Unexpected configuration section: ${section}`);
      }
      return {
        get(key, defaultValue) {
          return key in configValues ? configValues[key] : defaultValue;
        }
      };
    }
  }
};

await build({
  entryPoints: ['src/hostedTools/webSearchExecutor.ts'],
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

const { executeWebSearch } = require(bundlePath);

try {
  await runFallbackRequestShapeSmokeTest();
  await runCancellationSmokeTest();
  await runBackendErrorSmokeTest();
  console.log('Smoke test passed: Web Search fallback uses one isolated hosted web_search request.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function createContext() {
  return {
    secrets: {
      async get() {
        return 'test-api-key';
      }
    },
    extension: { packageJSON: { version: '1.9.0' } }
  };
}

function createCancellationToken(canceled = false) {
  return {
    isCancellationRequested: canceled,
    onCancellationRequested() {
      return { dispose() {} };
    }
  };
}

function createMockModel(slug, displayName) {
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
    ]
  };
}

function writeJsonResponse(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function createWebSearchResponse() {
  return {
    id: 'resp_web_search',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-5.5',
    output_text: 'Synthesized answer.',
    output: [
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: {
          type: 'search',
          queries: ['latest news'],
          sources: [
            { type: 'url', url: 'https://example.com/a' },
            { type: 'url', url: 'https://example.com/a' },
            { type: 'url', url: 'file:///not-allowed' }
          ]
        }
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: 'Synthesized answer.',
          annotations: [{
            type: 'url_citation',
            url: 'https://example.com/b',
            title: 'Example B',
            start_index: 0,
            end_index: 1
          }]
        }]
      }
    ]
  };
}

async function runFallbackRequestShapeSmokeTest() {
  const responseRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      writeJsonResponse(response, 200, { models: [createMockModel('gpt-5.5', 'GPT-5.5')] });
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    responseRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    writeJsonResponse(response, 200, createWebSearchResponse());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;

  try {
    const result = await executeWebSearch('latest news', createCancellationToken(), { context: createContext() });

    assertEqual(responseRequests.length, 1, 'fallback issues exactly one Responses request');
    const body = responseRequests[0];
    assertEqual(body.model, 'gpt-5.5', 'fallback uses the configured model');
    assertEqual(body.tools.length, 1, 'fallback sends exactly one tool');
    assertEqual(body.tools[0].type, 'web_search', 'fallback uses the hosted web_search tool');
    assertEqual(body.tool_choice, 'required', 'fallback forces the hosted web_search tool');
    assertEqual(
      body.include.includes('web_search_call.action.sources'),
      true,
      'fallback requests web search sources'
    );
    assertEqual(body.input[0].content, 'latest news', 'fallback sends the query as user input');
    assertEqual(body.previous_response_id, undefined, 'fallback never uses conversation continuation');
    assertEqual(body.stream, undefined, 'fallback uses a non-streaming request');

    assertEqual(result.answer, 'Synthesized answer.', 'fallback returns the synthesized answer');
    assertEqual(result.sources.length, 2, 'fallback deduplicates and sanitizes sources');
    assertEqual(result.sources[0].url, 'https://example.com/a', 'fallback keeps the first search source');
    assertEqual(result.sources[1].url, 'https://example.com/b', 'fallback keeps the citation source');
    assertEqual(result.sources[1].title, 'Example B', 'fallback keeps the citation title');
  } finally {
    await closeServer(server);
  }
}

async function runCancellationSmokeTest() {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    writeJsonResponse(response, 200, createWebSearchResponse());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;

  try {
    let rejection;
    try {
      await executeWebSearch('cancel me', createCancellationToken(true), { context: createContext() });
    } catch (error) {
      rejection = error;
    }
    assertEqual(rejection instanceof CancellationError, true, 'pre-cancelled fallback rejects with a cancellation error');
    assertEqual(requestCount, 0, 'pre-cancelled fallback never reaches the backend');
  } finally {
    await closeServer(server);
  }
}

async function runBackendErrorSmokeTest() {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
      writeJsonResponse(response, 200, { models: [createMockModel('gpt-5.5', 'GPT-5.5')] });
      return;
    }
    for await (const _chunk of request) {
      // Consume the request before returning the deterministic failure.
    }
    writeJsonResponse(response, 500, { error: { message: 'backend exploded' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configValues.baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;

  try {
    let rejection;
    try {
      await executeWebSearch('fail me', createCancellationToken(), { context: createContext() });
    } catch (error) {
      rejection = error;
    }
    assertEqual(rejection instanceof Error, true, 'backend failure rejects with an error');
    assertEqual(
      rejection.message.includes('OpenAI server error while contacting'),
      true,
      'backend failure is normalized through the shared Responses error path'
    );
  } finally {
    await closeServer(server);
  }
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
