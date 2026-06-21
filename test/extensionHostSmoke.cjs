const assert = require('node:assert');
const { createServer } = require('node:http');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('local.codex-model-provider');
  assert(extension, 'Extension is not registered in VS Code.');

  await extension.activate();
  assert(extension.isActive, 'Extension did not activate.');

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, '/backend-api/codex/responses');
    assert(request.headers.authorization?.startsWith('Bearer '), 'Missing bearer authorization header.');
    assert.strictEqual(request.headers['user-agent'], 'local.codex-model-provider/0.0.1 Codex-Extension');
    assert.strictEqual(body.instructions, 'Extension host smoke instructions');
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.store, false);
    assert.strictEqual('max_output_tokens' in body, false);

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write('data: {"type":"response.output_text.delta","delta":"VS Code"}\n\n');
    response.write('data: {"type":"response.output_text.delta","delta":" smoke passed"}\n\n');
    response.write('data: {"type":"response.completed","response":{"id":"resp_mock","object":"response","status":"completed"}}\n\n');
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const config = vscode.workspace.getConfiguration('codexModelProvider');
  const originalBaseURL = config.inspect('baseURL')?.globalValue;
  const originalInstructions = config.inspect('instructions')?.globalValue;

  try {
    await config.update('baseURL', `http://127.0.0.1:${address.port}/backend-api/codex/responses`, vscode.ConfigurationTarget.Global);
    await config.update('instructions', 'Extension host smoke instructions', vscode.ConfigurationTarget.Global);

    const models = await vscode.lm.selectChatModels({ vendor: 'codex-model-provider' });
    assert(models.length > 0, 'No codex-model-provider language model was selectable.');
    assert.strictEqual(models[0].name, 'GPT-5.5-Codex');
    assert.strictEqual(models[0].family, 'codex-model-provider');

    const response = await models[0].sendRequest([vscode.LanguageModelChatMessage.User('Ping')]);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }

    assert.strictEqual(text, 'VS Code smoke passed');
    console.log(`Extension host smoke passed: selected and streamed with ${models[0].vendor}/${models[0].id}.`);
  } finally {
    await config.update('baseURL', originalBaseURL, vscode.ConfigurationTarget.Global);
    await config.update('instructions', originalInstructions, vscode.ConfigurationTarget.Global);
    server.close();
  }
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}

module.exports = { run };
