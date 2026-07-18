const assert = require('node:assert');
const { writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const vscode = require('vscode');
const manifest = require('../package.json');

async function run() {
  const extensionId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  const extension = vscode.extensions.getExtension(extensionId);
  assert(extension, 'Extension is not registered in VS Code.');

  await extension.activate();
  assert(extension.isActive, 'Extension did not activate.');

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/backend-api/codex/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          {
            slug: 'gpt-5.4',
            display_name: 'GPT-5.4',
            description: 'Mock Codex model',
            context_window: 272000,
            max_context_window: 1000000,
            input_modalities: ['text'],
            supported_in_api: true,
            visibility: 'hide',
            comp_hash: 'mockhash',
            default_reasoning_level: 'high',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Low reasoning' },
              { effort: 'high', description: 'High reasoning' }
            ]
          }
        ]
      }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    if (request.method === 'POST' && request.url === '/backend-api/codex/responses/input_tokens') {
      assert.strictEqual(request.headers.authorization?.startsWith('Bearer '), true, 'Missing bearer authorization header for token count.');
      assert.strictEqual(request.headers['user-agent'], 'local.codex-for-copilot Codex for Copilot');
      assert.strictEqual(body.model, 'gpt-5.4');
      assert.strictEqual(body.input, 'Ping');

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'response.input_tokens',
        input_tokens: 11
      }));
      return;
    }

    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, '/backend-api/codex/responses');
    assert(request.headers.authorization?.startsWith('Bearer '), 'Missing bearer authorization header.');
    assert.strictEqual(request.headers['user-agent'], 'local.codex-for-copilot Codex for Copilot');
    assert.strictEqual(body.instructions, 'Extension host smoke instructions');
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.store, false);
    assert.strictEqual('max_output_tokens' in body, false);

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write('data: {"type":"response.reasoning_text.delta","delta":"Reasoning...","output_index":0,"content_index":0}\n\n');
    response.write('data: {"type":"response.output_text.delta","delta":"VS Code"}\n\n');
    response.write('data: {"type":"response.output_text.delta","delta":" smoke passed"}\n\n');
    response.write('data: {"type":"response.completed","response":{"id":"resp_mock","object":"response","status":"completed","usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}\n\n');
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const config = vscode.workspace.getConfiguration('codexModelProvider');
  const originalBaseURL = config.inspect('baseURL')?.globalValue;
  const originalInstructions = config.inspect('instructions')?.globalValue;
  const originalTransport = config.inspect('transport')?.globalValue;
  const originalIncludeHiddenModels = config.inspect('includeHiddenModels')?.globalValue;

  try {
    await config.update('baseURL', `http://127.0.0.1:${address.port}/backend-api/codex/responses`, vscode.ConfigurationTarget.Global);
    await config.update('instructions', 'Extension host smoke instructions', vscode.ConfigurationTarget.Global);
    await config.update('transport', 'http', vscode.ConfigurationTarget.Global);
    await config.update('includeHiddenModels', true, vscode.ConfigurationTarget.Global);

    const models = await vscode.lm.selectChatModels({ vendor: 'codex-for-copilot' });
    assert(models.length > 0, 'No codex-for-copilot language model was selectable.');
    assert.strictEqual(models[0].name, 'GPT-5.4');
    assert.strictEqual(models[0].id, 'codex::gpt-5.4');
    assert.strictEqual(models[0].family, 'gpt-5.4');
    assert.strictEqual(models[0].maxInputTokens, 272000);
    assert.strictEqual(models[1].name, 'GPT-5.4 (Long context)');
    assert.strictEqual(models[1].id, 'codex::gpt-5.4::context=1000000');
    assert.strictEqual(models[1].family, 'gpt-5.4');
    assert.strictEqual(models[1].maxInputTokens, 1000000);
    assert.strictEqual(models.length, 2);
    assert.strictEqual(await models[0].countTokens('Ping'), 11);

    const response = await models[0].sendRequest([vscode.LanguageModelChatMessage.User('Ping')]);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }

    assert.strictEqual(text, 'VS Code smoke passed');
    if (process.env.CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH) {
      await writeFile(process.env.CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH, JSON.stringify({ passed: true }));
    }
    console.log(`Extension host smoke passed: selected and streamed with ${models[0].vendor}/${models[0].id}.`);
  } finally {
    await config.update('baseURL', originalBaseURL, vscode.ConfigurationTarget.Global);
    await config.update('instructions', originalInstructions, vscode.ConfigurationTarget.Global);
    await config.update('transport', originalTransport, vscode.ConfigurationTarget.Global);
    await config.update('includeHiddenModels', originalIncludeHiddenModels, vscode.ConfigurationTarget.Global);
    server.close();
  }
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}

module.exports = { run };
