import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-logger-'));
const bundlePath = join(tempDir, 'codexLogger.cjs');
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/codexLogger.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath
});

try {
  const { createCodexLogger } = require(bundlePath);
  const events = [];
  const sink = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map((level) => [level, (message) => events.push({ level, message })]));
  const root = createCodexLogger(sink, 'extension');
  const operation = root.child('provider').operation('chat.response', { requestModel: 'gpt-test' });
  const circular = { marker: 'safe' };
  circular.self = circular;
  const unreadable = {};
  Object.defineProperty(unreadable, 'value', { enumerable: true, get() { throw new Error('getter should not escape'); } });
  const error = new Error('Request failed: access_token=ACCESS_TOKEN_SENTINEL');
  error.cause = new Error('Bearer AUTHORIZATION_SENTINEL');

  operation.info('response.started', {
    headers: { Authorization: 'AUTHORIZATION_SENTINEL', Cookie: 'COOKIE_SENTINEL' },
    prompt: 'PROMPT_SENTINEL',
    instructions: 'INSTRUCTIONS_SENTINEL',
    toolArguments: { source: 'TOOL_ARGUMENTS_SENTINEL' },
    toolResult: 'TOOL_RESULT_SENTINEL',
    turnState: 'TURN_STATE_SENTINEL',
    previousResponseId: 'response-secret-id',
    circular,
    unreadable
  });
  operation.nextAttempt().warn('transport.fallback', { reason: 'network' });
  operation.error('response.failed', error);

  assert.equal(events.length, 3, 'logger should route each event once');
  const payloads = events.map(({ message }) => {
    const match = /^\[provider\] [^ ]+ (.+)$/.exec(message);
    assert.ok(match, `structured event format: ${message}`);
    return JSON.parse(match[1]);
  });
  assert.equal(payloads[0].operationId, payloads[1].operationId, 'retry should retain operation id');
  assert.equal(payloads[0].sessionId, payloads[2].sessionId, 'child loggers should retain session id');
  assert.equal(payloads[0].attempt, 1, 'first attempt number');
  assert.equal(payloads[1].attempt, 2, 'retry attempt number');
  assert.equal(payloads[0].headers.Authorization.present, true, 'authorization is presence-only');
  assert.equal(payloads[0].prompt.bytes, 'PROMPT_SENTINEL'.length, 'prompt is summarized');
  assert.equal(payloads[0].turnState.present, true, 'turn state is never emitted');
  assert.equal(payloads[0].circular.self, '[circular]', 'circular references are safe');
  assert.equal(payloads[0].unreadable.value, '[unreadable]', 'throwing getters are safe');
  assert.equal(payloads[0].previousResponseId.length, 12, 'response identifiers are hashed');
  assert.equal(payloads[2].error.cause.message.includes('[redacted]'), true, 'error cause credentials are redacted');
  const output = events.map(({ message }) => message).join('\n');
  for (const secret of ['AUTHORIZATION_SENTINEL', 'COOKIE_SENTINEL', 'PROMPT_SENTINEL', 'INSTRUCTIONS_SENTINEL', 'TOOL_ARGUMENTS_SENTINEL', 'TOOL_RESULT_SENTINEL', 'TURN_STATE_SENTINEL', 'ACCESS_TOKEN_SENTINEL']) {
    assert.equal(output.includes(secret), false, `secret must not appear in logs: ${secret}`);
  }
  const throwingSink = { trace() { throw new Error('sink failure'); }, debug() { throw new Error('sink failure'); }, info() { throw new Error('sink failure'); }, warn() { throw new Error('sink failure'); }, error() { throw new Error('sink failure'); } };
  assert.doesNotThrow(() => createCodexLogger(throwingSink).info('logger.failure-isolated', { prompt: 'PROMPT_SENTINEL' }), 'logger failures must not affect the caller');
  console.log('Smoke test passed: structured logging keeps operation correlation and redacts sensitive values.');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
