import { createServer } from 'node:http';
import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/responsesClient.ts', {
  LanguageModelChatToolMode: { Required: 2 }
});
const { streamResponseText, disposeReusableResponsesWebSockets } = loaded.exports;
let captured;
let server;
try {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = {
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-codex-turn-state': 'opaque-http-state',
      'x-request-id': 'request-test',
      'openai-model': 'gpt-test',
      'x-models-etag': 'etag-test'
    });
    writeEvent(response, { type: 'response.created', response: { id: 'resp-http', status: 'in_progress' } });
    writeEvent(response, { type: 'response.output_text.delta', delta: 'ok' });
    writeEvent(response, { type: 'response.output_item.done', item: { type: 'reasoning', id: 'raw-http' } });
    writeEvent(response, { type: 'response.completed', response: { id: 'resp-http', status: 'completed' } });
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const turnStates = [];
  const rawItems = [];
  await streamResponseText({
    baseURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    apiKey: 'token',
    headers: { 'ChatGPT-Account-ID': 'acct-test' },
    transport: 'http',
    compatibilityProfile: { enabled: true, endpointKey: `http://127.0.0.1:${port}/backend-api/codex/responses` },
    authIdentity: 'auth',
    identity: {
      installationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      threadId: '33333333-3333-4333-8333-333333333333',
      turnId: '44444444-4444-4444-8444-444444444444',
      windowId: '55555555-5555-4555-8555-555555555555'
    },
    turnState: 'prior-http-state',
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)',
    requestCompression: 'disabled',
    omitMaxOutputTokens: true,
    model: 'gpt-test',
    instructions: 'instructions',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    maxOutputTokens: 100,
    token: createCancellationToken(),
    onTextDelta() {},
    onTurnState: (state) => turnStates.push(state),
    onRawResponseItem: (item) => rawItems.push(item)
  });
  assertEqual(captured.headers.originator, 'codex-for-copilot', 'HTTP originator');
  assertEqual(captured.headers['x-codex-turn-state'], 'prior-http-state', 'HTTP Turn State replay');
  assertEqual(captured.headers['x-client-request-id'], captured.body.prompt_cache_key, 'thread header and cache key agree');
  assertEqual(captured.body.client_metadata.turn_id, '44444444-4444-4444-8444-444444444444', 'HTTP client metadata');
  assertEqual(turnStates[0], 'opaque-http-state', 'HTTP Turn State captured');
  assertEqual(rawItems.length, 1, 'HTTP raw item retained');
  console.log('Smoke test passed: HTTP dynamic headers, body identity, response headers, and raw items are correct.');
} finally {
  disposeReusableResponsesWebSockets();
  server?.close();
  await loaded.dispose();
}

function writeEvent(response, event) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() { return { dispose() {} }; }
  };
}
