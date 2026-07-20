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

  let responseRequestCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/backend-api/codex/models')) {
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
      response.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 11 }));
      return;
    }

    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, '/backend-api/codex/responses');
    assert(request.headers.authorization?.startsWith('Bearer '), 'Missing bearer authorization header.');
    assert.strictEqual(request.headers['user-agent'], 'local.codex-for-copilot Codex for Copilot');
    assert.strictEqual(body.instructions, 'Extension host smoke instructions');
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.store, false);
    assert.strictEqual(body.model, 'gpt-5.4');
    assert.strictEqual('max_output_tokens' in body, false);
    assert.strictEqual(Object.keys(body).some((key) => key.toLowerCase().includes('context')), false);
    assert.strictEqual(JSON.stringify(body).includes('::context='), false);
    responseRequestCount += 1;

    if (responseRequestCount === 1) {
      assert.strictEqual(body.previous_response_id, undefined);
      assert.deepStrictEqual(body.input, [{ type: 'message', role: 'user', content: 'Profile start' }]);
      writeTextResponse(response, 'standard reply', 'resp_profile_standard');
      return;
    }

    if (responseRequestCount === 2) {
      assert.strictEqual(body.previous_response_id, 'resp_profile_standard');
      assert.deepStrictEqual(body.input, [{ type: 'message', role: 'user', content: 'Expand context' }]);
      writeTextResponse(response, 'long reply', 'resp_profile_long');
      return;
    }

    if (responseRequestCount === 3) {
      assert.strictEqual(body.previous_response_id, undefined, 'Long-to-standard downgrade must start a new chain.');
      assert.deepStrictEqual(body.input, [
        { type: 'message', role: 'user', content: 'Profile start' },
        { type: 'message', role: 'assistant', content: 'standard reply' },
        { type: 'message', role: 'user', content: 'Expand context' },
        { type: 'message', role: 'assistant', content: 'long reply' },
        { type: 'message', role: 'user', content: 'Return to standard' }
      ]);
      writeTextResponse(response, 'downgrade reply', 'resp_profile_downgrade');
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    if (responseRequestCount === 4) {
      assert.strictEqual(body.previous_response_id, undefined);
      response.write('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_extension_host","type":"function_call","call_id":"call_extension_host","name":"extension_host_smoke_tool","arguments":""}}\n\n');
      response.write('data: {"type":"response.function_call_arguments.done","item_id":"fc_extension_host","call_id":"call_extension_host","name":"extension_host_smoke_tool","arguments":"{\\"value\\":\\"ping\\"}"}\n\n');
      response.write('data: {"type":"response.completed","response":{"id":"resp_tool_loop","object":"response","status":"completed"}}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    assert.strictEqual(responseRequestCount, 5, 'Expected five language-model requests.');
    assert.strictEqual(body.previous_response_id, undefined, 'HTTP tool-result recovery must use complete replay.');
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
  let originalIncludeHiddenModels;
  try {
    await listen(server);
    const address = server.address();
    config = vscode.workspace.getConfiguration('codexModelProvider');
    originalBaseURL = config.inspect('baseURL')?.globalValue;
    originalInstructions = config.inspect('instructions')?.globalValue;
    originalTransport = config.inspect('transport')?.globalValue;
    originalIncludeHiddenModels = config.inspect('includeHiddenModels')?.globalValue;
    await config.update('baseURL', `http://127.0.0.1:${address.port}/backend-api/codex/responses`, vscode.ConfigurationTarget.Global);
    await config.update('instructions', 'Extension host smoke instructions', vscode.ConfigurationTarget.Global);
    await config.update('transport', 'http', vscode.ConfigurationTarget.Global);
    await config.update('includeHiddenModels', true, vscode.ConfigurationTarget.Global);

    const models = await vscode.lm.selectChatModels({ vendor: 'codex-for-copilot' });
    const standardModel = models.find((model) => model.id === 'codex::gpt-5.4');
    const longModel = models.find((model) => model.id === 'codex::gpt-5.4::context=1000000');
    assert(standardModel, 'Hidden GPT-5.4 standard profile was not selectable.');
    assert(longModel, 'Hidden GPT-5.4 long profile was not selectable.');
    assert.strictEqual(models.length, 2);
    assert.strictEqual(standardModel.name, 'GPT-5.4');
    assert.strictEqual(standardModel.family, 'gpt-5.4');
    assert.strictEqual(standardModel.maxInputTokens, 258400);
    assert.strictEqual(longModel.name, 'GPT-5.4 (Long context)');
    assert.strictEqual(longModel.family, 'gpt-5.4');
    assert.strictEqual(longModel.maxInputTokens, 950000);

    assert.strictEqual(await collectText(await standardModel.sendRequest([
      vscode.LanguageModelChatMessage.User('Profile start')
    ])), 'standard reply');
    assert.strictEqual(await collectText(await longModel.sendRequest([
      vscode.LanguageModelChatMessage.User('Profile start'),
      vscode.LanguageModelChatMessage.Assistant('standard reply'),
      vscode.LanguageModelChatMessage.User('Expand context')
    ])), 'long reply');
    assert.strictEqual(await collectText(await standardModel.sendRequest([
      vscode.LanguageModelChatMessage.User('Profile start'),
      vscode.LanguageModelChatMessage.Assistant('standard reply'),
      vscode.LanguageModelChatMessage.User('Expand context'),
      vscode.LanguageModelChatMessage.Assistant('long reply'),
      vscode.LanguageModelChatMessage.User('Return to standard')
    ])), 'downgrade reply');

    assert.strictEqual(await standardModel.countTokens('Ping'), 11);
    const tool = {
      name: 'extension_host_smoke_tool',
      description: 'Returns a deterministic smoke-test value.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      }
    };
    const toolResponse = await standardModel.sendRequest(
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

    const response = await standardModel.sendRequest([
      vscode.LanguageModelChatMessage.User('Ping'),
      vscode.LanguageModelChatMessage.Assistant([toolCalls[0]]),
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(toolCalls[0].callId, [new vscode.LanguageModelTextPart('tool result')])
      ])
    ], { tools: [tool] });
    assert.strictEqual(await collectText(response), 'VS Code tool-loop smoke passed');
    assert.strictEqual(responseRequestCount, 5);

    if (process.env.CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH) {
      await writeFile(process.env.CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH, JSON.stringify({ passed: true }));
    }
    console.log(`Extension host smoke passed: profiles, token counting, and tool loop completed with ${standardModel.vendor}/${standardModel.id}.`);
  } finally {
    if (config) {
      await config.update('baseURL', originalBaseURL, vscode.ConfigurationTarget.Global);
      await config.update('instructions', originalInstructions, vscode.ConfigurationTarget.Global);
      await config.update('transport', originalTransport, vscode.ConfigurationTarget.Global);
      await config.update('includeHiddenModels', originalIncludeHiddenModels, vscode.ConfigurationTarget.Global);
    }
    await closeServer(server);
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  }
}

async function collectText(response) {
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text;
}

function writeTextResponse(response, text, responseId) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed' } })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

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

module.exports = { run };
