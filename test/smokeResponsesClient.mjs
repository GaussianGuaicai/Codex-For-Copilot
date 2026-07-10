import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-provider-'));
const bundlePath = join(tempDir, 'responsesClient.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/responsesClient.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: ['vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      LanguageModelChatToolMode: {
        Required: 2
      }
    };
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const { streamResponseText } = require(bundlePath);

let capturedRequest;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  capturedRequest = {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    userAgent: request.headers['user-agent'],
    accountId: request.headers['chatgpt-account-id'],
    body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
  };

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  response.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
  response.write('data: {"type":"response.output_text.delta","delta":" world"}\n\n');
  response.write('data: {"type":"response.completed","response":{"id":"resp_mock","object":"response","status":"completed"}}\n\n');
  response.write('data: [DONE]\n\n');
  response.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const deltas = [];

  await streamResponseText({
    baseURL: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    apiKey: 'test-api-key',
    headers: {
      'User-Agent': 'local.codex-for-copilot Codex for Copilot',
      'ChatGPT-Account-ID': 'acct-test'
    },
    omitMaxOutputTokens: true,
    model: 'gpt-5.5',
    instructions: 'Smoke test instructions',
    input: [{ role: 'user', content: 'Ping' }],
    maxOutputTokens: 32,
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
    onTextDelta: (text) => deltas.push(text)
  });

  assertEqual(capturedRequest.method, 'POST', 'method');
  assertEqual(capturedRequest.url, '/backend-api/codex/responses', 'request path');
  assertEqual(capturedRequest.authorization, 'Bearer test-api-key', 'authorization header');
  assertEqual(capturedRequest.userAgent, 'local.codex-for-copilot Codex for Copilot', 'user agent');
  assertEqual(capturedRequest.accountId, 'acct-test', 'ChatGPT account id header');
  assertEqual(capturedRequest.body.model, 'gpt-5.5', 'model');
  assertEqual(capturedRequest.body.instructions, 'Smoke test instructions', 'top-level instructions');
  assertEqual(capturedRequest.body.store, false, 'store flag');
  assertEqual(capturedRequest.body.stream, true, 'stream flag');
  assertEqual('max_output_tokens' in capturedRequest.body, false, 'max output tokens omitted for Codex account auth');
  assertEqual(JSON.stringify(capturedRequest.body.input), JSON.stringify([{ role: 'user', content: 'Ping' }]), 'input');
  assertEqual(deltas.join(''), 'hello world', 'streamed text');

  console.log('Smoke test passed: request shape and streaming deltas are correct.');
} finally {
  Module._load = moduleLoad;
  server.close();
  await rm(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
