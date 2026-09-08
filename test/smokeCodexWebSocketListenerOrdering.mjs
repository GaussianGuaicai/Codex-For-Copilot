import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-websocket-listener-ordering-'));
const bundlePath = join(tempDir, 'codexWebSocketSession.cjs');
const originalLoad = Module._load;
const operationOrder = [];
let pendingError;

class FakeResponsesWS {
  constructor() {
    this.socket = {
      readyState: 1,
      platformSocket: {
        once() {}
      }
    };
  }

  stream() {
    operationOrder.push('stream');
    this.streamAttached = true;
    let delivered = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!delivered && pendingError) {
              delivered = true;
              return { done: false, value: { type: 'error', error: pendingError } };
            }
            return new Promise(() => {});
          },
          async return() {
            operationOrder.push('return');
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  sendRaw() {
    operationOrder.push('sendRaw');
    if (!this.streamAttached) {
      throw new Error('Immediate WebSocket error was emitted before the request listener attached.');
    }
    pendingError = new Error('Invalid `previous_response_id`.');
  }

  on() {}

  off() {}

  close() {}
}

await build({
  entryPoints: ['src/codexWebSocketSession.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: ['openai/resources/responses/ws', 'vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai/resources/responses/ws') {
    return { ResponsesWS: FakeResponsesWS };
  }
  if (request === 'vscode') {
    return { LanguageModelChatToolMode: { Required: 2 } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);

try {
  const { CodexWebSocketSession } = require(bundlePath);
  const identity = {
    installationId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    turnId: '44444444-4444-4444-8444-444444444444',
    windowId: '55555555-5555-4555-8555-555555555555'
  };
  const input = [{ type: 'message', role: 'user', content: 'Continue.' }];
  const session = new CodexWebSocketSession({}, {});
  let capturedError;

  try {
    await session.stream({
      request: {
        model: 'gpt-test',
        instructions: 'Smoke test instructions',
        input,
        previous_response_id: 'resp_missing',
        stream: true
      },
      builderOptions: {
        compatibilityEnabled: true,
        identity,
        model: 'gpt-test',
        instructions: 'Smoke test instructions',
        input,
        previousResponseId: 'resp_missing',
        omitMaxOutputTokens: true,
        maxOutputTokens: 32
      },
      identity,
      signal: new AbortController().signal,
      onEvent() {}
    });
  } catch (error) {
    capturedError = error;
  }

  assertEqual(JSON.stringify(operationOrder), JSON.stringify(['stream', 'sendRaw', 'return']), 'managed socket listener lifecycle');
  assertEqual(capturedError?.message, 'Invalid `previous_response_id`.', 'immediate socket error reaches request stream');
  console.log('Smoke test passed: managed WebSocket listeners attach before transmission and release after each request.');
} finally {
  Module._load = originalLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
