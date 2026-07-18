const assert = require('node:assert');
const { createServer } = require('node:http');
const { writeFile } = require('node:fs/promises');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('local.codex-for-copilot');
  assert(extension, 'Extension is not registered in VS Code.');

  await extension.activate();
  assert(extension.isActive, 'Extension did not activate.');

  let responseRequestCount = 0;
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
            visibility: 'list',
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
    responseRequestCount += 1;

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    if (responseRequestCount === 1) {
      assert.strictEqual(body.previous_response_id, undefined);
      response.write('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_extension_host","type":"function_call","call_id":"call_extension_host","name":"extension_host_smoke_tool","arguments":""}}\n\n');
      response.write('data: {"type":"response.function_call_arguments.done","item_id":"fc_extension_host","call_id":"call_extension_host","name":"extension_host_smoke_tool","arguments":"{\\"value\\":\\"ping\\"}"}\n\n');
      response.write('data: {"type":"response.completed","response":{"id":"resp_tool_loop","object":"response","status":"completed"}}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    assert.strictEqual(responseRequestCount, 2, 'Expected exactly two language-model requests.');
    assert.strictEqual(body.previous_response_id, undefined, 'Default tool-result recovery must use complete replay.');
    assert.deepStrictEqual(body.input.slice(-2), [
      {
        type: 'function_call',
        call_id: 'call_extension_host',
        name: 'extension_host_smoke_tool',
        arguments: '{"value":"ping"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_extension_host',
        output: 'tool result'
      }
    ]);
    response.write('data: {"type":"response.reasoning_text.delta","delta":"Reasoning...","output_index":0,"content_index":0}\n\n');
    response.write('data: {"type":"response.output_text.delta","delta":"VS Code"}\n\n');
    response.write('data: {"type":"response.output_text.delta","delta":" tool-loop smoke passed"}\n\n');
    response.write('data: {"type":"response.completed","response":{"id":"resp_mock","object":"response","status":"completed","usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}\n\n');
    response.write('data: [DONE]\n\n');
    response.end();
  });

  let config;
  let originalBaseURL;
  let originalInstructions;
  let originalTransport;
  try {
    await listen(server);
    const address = server.address();
    config = vscode.workspace.getConfiguration('codexModelProvider');
    originalBaseURL = config.inspect('baseURL')?.globalValue;
    originalInstructions = config.inspect('instructions')?.globalValue;
    originalTransport = config.inspect('transport')?.globalValue;
    await config.update('baseURL', `http://127.0.0.1:${address.port}/backend-api/codex/responses`, vscode.ConfigurationTarget.Global);
    await config.update('instructions', 'Extension host smoke instructions', vscode.ConfigurationTarget.Global);
    await config.update('transport', 'http', vscode.ConfigurationTarget.Global);

    const models = await vscode.lm.selectChatModels({ vendor: 'codex-for-copilot' });
    assert(models.length > 0, 'No codex-for-copilot language model was selectable.');
    assert.strictEqual(models[0].name, 'GPT-5.4 (Codex)');
    assert.strictEqual(models[0].id, 'codex-for-copilot::gpt-5.4');
    assert.strictEqual(models[0].family, 'gpt-5.4');
    assert.strictEqual(models[0].maxInputTokens, 272000);
    assert.strictEqual(models.length, 1);
    assert.strictEqual(await models[0].countTokens('Ping'), 11);

    const tool = {
      name: 'extension_host_smoke_tool',
      description: 'Returns a deterministic smoke-test value.',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value']
      }
    };
    const toolResponse = await models[0].sendRequest(
      [vscode.LanguageModelChatMessage.User('Ping')],
      { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required }
    );
    const toolCalls = [];
    for await (const part of toolResponse.stream) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
      }
    }
    assert.strictEqual(toolCalls.length, 1, 'Expected exactly one streamed tool call.');
    assert.strictEqual(toolCalls[0].callId, 'call_extension_host');
    assert.strictEqual(toolCalls[0].name, 'extension_host_smoke_tool');
    assert.deepStrictEqual(toolCalls[0].input, { value: 'ping' });

    const response = await models[0].sendRequest([
      vscode.LanguageModelChatMessage.User('Ping'),
      vscode.LanguageModelChatMessage.Assistant([toolCalls[0]]),
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(
          toolCalls[0].callId,
          [new vscode.LanguageModelTextPart('tool result')]
        )
      ])
    ], { tools: [tool] });
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }

    assert.strictEqual(text, 'VS Code tool-loop smoke passed');
    if (process.env.CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH) {
      await writeFile(process.env.CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH, JSON.stringify({ passed: true }));
    }
    console.log(`Extension host smoke passed: selected, invoked one tool, and recovered with ${models[0].vendor}/${models[0].id}.`);
  } finally {
    if (config) {
      await config.update('baseURL', originalBaseURL, vscode.ConfigurationTarget.Global);
      await config.update('instructions', originalInstructions, vscode.ConfigurationTarget.Global);
      await config.update('transport', originalTransport, vscode.ConfigurationTarget.Global);
    }
    await closeServer(server);
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  }
}

module.exports = { run };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(resolve));
}
