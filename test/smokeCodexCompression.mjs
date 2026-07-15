import { createServer } from 'node:http';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexFetchAdapter.ts');
let server;
try {
  const { createCodexFetchAdapter, isCodexCompressionRuntimeAvailable } = loaded.exports;
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
  if (isCodexCompressionRuntimeAvailable()) {
    assertEqual(encodings.join(','), 'zstd,identity', 'zstd retries once uncompressed');
  } else {
    assertEqual(encodings.join(','), 'identity', 'runtime fallback is lossless');
  }
  console.log('Smoke test passed: request compression uses Zstd when available and safely retries uncompressed.');
} finally {
  server?.close();
  await loaded.dispose();
}
