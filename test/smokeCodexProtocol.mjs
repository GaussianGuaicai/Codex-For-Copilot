import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexProtocol.ts');
try {
  const {
    CODEX_RESPONSES_WEBSOCKET_BETA,
    buildCodexRequestHeaders,
    createCodexTurnMetadata,
    getCodexCompatibilityProfile,
    stableSerializeCodexMetadata
  } = loaded.exports;
  const identity = {
    installationId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    turnId: '44444444-4444-4444-8444-444444444444',
    windowId: '55555555-5555-4555-8555-555555555555'
  };
  const metadata = stableSerializeCodexMetadata(createCodexTurnMetadata(identity));
  const headers = buildCodexRequestHeaders({
    credentialsHeaders: { 'ChatGPT-Account-ID': 'acct-test' },
    identity,
    turnMetadata: metadata,
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)'
  }, 'websocket');
  assertEqual(CODEX_RESPONSES_WEBSOCKET_BETA, 'responses_websockets=2026-02-06', 'beta baseline');
  assertEqual(headers['OpenAI-Beta'], CODEX_RESPONSES_WEBSOCKET_BETA, 'beta header');
  assertEqual(headers.originator, 'codex-for-copilot', 'truthful originator');
  assertEqual(headers['session-id'], identity.sessionId, 'session header');
  assertEqual(headers['x-codex-turn-state'], undefined, 'turn state omitted initially');
  assertEqual(metadata, stableSerializeCodexMetadata(createCodexTurnMetadata(identity)), 'stable metadata');
  assertEqual(getCodexCompatibilityProfile('https://chatgpt.com/backend-api/codex/responses', { kind: 'codexAccessToken' }).enabled, true, 'Codex profile enabled');
  assertEqual(getCodexCompatibilityProfile('https://api.openai.com/v1', { kind: 'openaiApiKey' }).enabled, false, 'BYOK profile disabled');
  console.log('Smoke test passed: Codex protocol constants, headers, gating, and metadata are stable.');
} finally {
  await loaded.dispose();
}
