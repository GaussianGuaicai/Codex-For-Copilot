import { createServer } from 'node:http';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexFetchAdapter.ts');
let server;
try {
  const {
    createCodexFetchAdapter,
    isCodexCompressionRuntimeAvailable,
    resetCodexFetchCapabilities
  } = loaded.exports;
  let requestCount = 0;
  const encodings = [];
  server = createServer(async (request, response) => {
    requestCount += 1;
    encodings.push(request.headers['content-encoding'] ?? 'identity');
    for await (const _chunk of request) {}
    if (requestCount === 1 && request.headers['content-encoding'] === 'zstd') {
      response.writeHead(415);
      response.end('unsupported');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const adapter = createCodexFetchAdapter({
    endpointKey: `http://127.0.0.1:${port}`,
    compatibilityEnabled: true,
    compression: 'enabled',
    compressionThresholdBytes: 1
  });
  const response = await adapter(`http://127.0.0.1:${port}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'large enough' })
  });
  assertEqual(response.status, 200, 'compression rejection recovers');
  resetCodexFetchCapabilities(`http://127.0.0.1:${port}`);
  const resetResponse = await adapter(`http://127.0.0.1:${port}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'large enough' })
  });
  assertEqual(resetResponse.status, 200, 'capability reset re-enables requests');
  if (isCodexCompressionRuntimeAvailable()) {
    assertEqual(encodings.join(','), 'zstd,identity,zstd', 'zstd retries once uncompressed and resumes after reset');
  } else {
    assertEqual(encodings.join(','), 'identity,identity', 'runtime fallback is lossless');
  }

  await runOrdinaryBadRequestSmokeTest(
    createCodexFetchAdapter,
    isCodexCompressionRuntimeAvailable,
    resetCodexFetchCapabilities
  );
  console.log('Smoke test passed: request compression uses Zstd when available and safely retries uncompressed.');
} finally {
  server?.close();
  await loaded.dispose();
}

async function runOrdinaryBadRequestSmokeTest(
  createCodexFetchAdapter,
  isCodexCompressionRuntimeAvailable,
  resetCodexFetchCapabilities
) {
  let requestCount = 0;
  const encodings = [];
  const ordinaryErrorServer = createServer(async (request, response) => {
    requestCount += 1;
    encodings.push(request.headers['content-encoding'] ?? 'identity');
    for await (const _chunk of request) {}
    if (requestCount === 1) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'previous_response_id is invalid' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });

  await new Promise((resolve) => ordinaryErrorServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = ordinaryErrorServer.address().port;
    const endpoint = `http://127.0.0.1:${port}`;
    resetCodexFetchCapabilities(endpoint);
    const adapter = createCodexFetchAdapter({
      endpointKey: endpoint,
      compatibilityEnabled: true,
      compression: 'enabled',
      compressionThresholdBytes: 1
    });
    const firstResponse = await adapter(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'large enough' })
    });
    const secondResponse = await adapter(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'large enough' })
    });

    assertEqual(firstResponse.status, 400, 'ordinary bad request is not retried as a compression failure');
    assertEqual(secondResponse.status, 200, 'ordinary bad request does not disable future compression');
    if (isCodexCompressionRuntimeAvailable()) {
      assertEqual(encodings.join(','), 'zstd,zstd', 'ordinary bad request retains compression capability');
    } else {
      assertEqual(encodings.join(','), 'identity,identity', 'runtime fallback remains uncompressed');
    }
  } finally {
    ordinaryErrorServer.close();
  }
}
