import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-model-provider-real-'));
const secretsBundlePath = join(tempDir, 'secrets.cjs');
const responsesBundlePath = join(tempDir, 'responsesClient.mjs');
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
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: responsesBundlePath
  });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return {};
    }

    return moduleLoad.call(this, request, parent, isMain);
  };

  const { getApiCredentials, DEFAULT_USER_AGENT } = require(secretsBundlePath);
  const { streamResponseText } = await import(pathToFileURL(responsesBundlePath).href);
  const auth = JSON.parse(await readFile(join(process.env.USERPROFILE, '.codex', 'auth.json'), 'utf8'));
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

  globalThis.fetch = (input, init = {}) => undiciFetch(input, {
    ...init,
    dispatcher: init.dispatcher ?? new ProxyAgent(proxyUrl)
  });

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
  await streamResponseText({
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    apiKey: credentials.apiKey,
    headers: credentials.headers,
    omitMaxOutputTokens: credentials.omitMaxOutputTokens,
    model: 'gpt-5.5',
    instructions: 'You are a test assistant.',
    input: [{ role: 'user', content: 'Reply with OK only.' }],
    maxOutputTokens: 32,
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
    onTextDelta: (text) => deltas.push(text)
  });

  assertEqual(deltas.join('').trim(), 'OK', 'real backend output');
  console.log('Real backend probe passed: extension credentials and streaming request work with ChatGPT Codex backend.');
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
