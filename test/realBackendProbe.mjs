import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const requestedModel = process.env.CODEX_TEST_MODEL || 'gpt-5.5';
const requestedServiceTier = process.env.CODEX_TEST_SERVICE_TIER;
const requestServiceTier = requestedServiceTier === 'fast'
  ? 'priority'
  : requestedServiceTier === 'auto' || requestedServiceTier === undefined
    ? undefined
    : requestedServiceTier;

const tempDir = await mkdtemp(join(tmpdir(), 'codex-model-provider-real-'));
const secretsBundlePath = join(tempDir, 'secrets.cjs');
const responsesBundlePath = join(tempDir, 'responsesClient.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: ['src/secrets.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: secretsBundlePath,
    external: ['vscode']
  });

  await build({
    entryPoints: ['src/responsesClient.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: responsesBundlePath,
    external: ['vscode']
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        workspace: {
          getConfiguration() {
            return {
              get(_key, defaultValue) {
                return defaultValue;
              }
            };
          }
        }
      };
    }

    return moduleLoad.call(this, request, parent, isMain);
  };

  const { getApiCredentials, DEFAULT_USER_AGENT } = require(secretsBundlePath);
  const { streamResponseText } = require(responsesBundlePath);
  const auth = JSON.parse(await readFile(join(process.env.USERPROFILE, '.codex', 'auth.json'), 'utf8'));
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  globalThis.fetch = (input, init = {}) => undiciFetch(input, proxyUrl
    ? {
        ...init,
        dispatcher: init.dispatcher ?? new ProxyAgent(proxyUrl)
      }
    : init);

  const credentials = await getApiCredentials({
    secrets: {
      async get() {
        return 'sk-stored-key-should-not-win';
      }
    }
  });

  if (!credentials) {
    throw new Error('No credentials were resolved from ~/.codex/auth.json.');
  }

  assertEqual(credentials.source, 'codexAuth', 'credential source');
  assertEqual(credentials.apiKey, auth.tokens.access_token, 'resolved access token');
  assertEqual(credentials.headers['User-Agent'], DEFAULT_USER_AGENT, 'default user agent');
  assertEqual(credentials.headers['ChatGPT-Account-ID'], auth.tokens.account_id, 'account id header');
  assertEqual(credentials.omitMaxOutputTokens, true, 'omit max_output_tokens');

  const deltas = [];
  let createdServiceTier = null;
  let completedServiceTier = null;
  await streamResponseText({
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    apiKey: credentials.apiKey,
    headers: credentials.headers,
    omitMaxOutputTokens: credentials.omitMaxOutputTokens,
    model: requestedModel,
    instructions: 'You are a test assistant.',
    ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
    input: [{ role: 'user', content: 'Reply with OK only.' }],
    maxOutputTokens: 32,
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
    onTextDelta: (text) => deltas.push(text),
    onResponseCreated: (response) => {
      createdServiceTier = response.service_tier ?? null;
    },
    onResponseCompleted: (response) => {
      completedServiceTier = response.service_tier ?? null;
    }
  });

  assertEqual(deltas.join('').trim(), 'OK', 'real backend output');
  console.log(JSON.stringify({
    model: requestedModel,
    requestedServiceTier: requestedServiceTier ?? null,
    requestServiceTier: requestServiceTier ?? null,
    createdServiceTier,
    completedServiceTier,
    output: deltas.join('').trim()
  }));
} finally {
  Module._load = moduleLoad;
  delete globalThis.fetch;
  await rm(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
