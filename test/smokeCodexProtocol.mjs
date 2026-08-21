import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexProtocol.ts');
try {
  const {
    CODEX_RESPONSES_WEBSOCKET_BETA,
    buildCodexProtocolSnapshot,
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
  const turnStartedAtUnixMs = 1_787_000_000_000;
  const metadata = stableSerializeCodexMetadata(createCodexTurnMetadata(identity, 'turn', turnStartedAtUnixMs));
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
  assertEqual(metadata, stableSerializeCodexMetadata(createCodexTurnMetadata(identity, 'turn', turnStartedAtUnixMs)), 'stable metadata');
  const safeSnapshot = buildCodexProtocolSnapshot({
    identity,
    turnStartedAtUnixMs,
    settings: {
      headerOverrides: { originator: 'custom-client', Authorization: 'must-not-win', 'x-extra': 'yes', 'x-codex-routing-hint': 'route-a' },
      clientMetadataOverrides: { custom_surface: 'vscode', thread_id: 'must-not-win' },
      turnMetadataOverrides: { custom_surface: 'vscode', thread_id: 'must-not-win' }
    }
  });
  const safeHeaders = buildCodexRequestHeaders({
    credentialsHeaders: { Authorization: 'Bearer real', 'ChatGPT-Account-ID': 'acct-test' },
    identity,
    turnMetadata: safeSnapshot.compatibilityTurnMetadata,
    snapshot: safeSnapshot,
    turnState: 'sticky-secret',
    extensionVersion: '1.2.3',
    userAgent: 'codex-for-copilot/1.2.3 (test)'
  }, 'http');
  assertEqual(safeHeaders.originator, 'custom-client', 'safe header override');
  assertEqual(safeHeaders['x-extra'], 'yes', 'extra header override');
  assertEqual(safeHeaders['x-codex-routing-hint'], 'route-a', 'routing hint override');
  assertEqual(safeHeaders.Authorization, 'Bearer real', 'credential override is protected');
  assertEqual(safeHeaders['x-codex-turn-state'], 'sticky-secret', 'Turn State override is protected');
  assertEqual(safeSnapshot.turnMetadata.thread_id, identity.threadId, 'reserved turn metadata is protected');
  assertEqual(safeSnapshot.clientMetadata.thread_id, identity.threadId, 'reserved client metadata is protected');
  assertEqual(safeSnapshot.turnMetadata.custom_surface, 'vscode', 'extra turn metadata is accepted');
  assertEqual(safeSnapshot.clientMetadata.custom_surface, 'vscode', 'extra client metadata is accepted');
  const toolSnapshot = buildCodexProtocolSnapshot({
    identity,
    turnStartedAtUnixMs,
    toolPlan: {
      mode: 'native-hosted',
      responseTools: [{
        type: 'function',
        name: 'open_file',
        description: 'Open',
        parameters: {}
      }, {
        type: 'namespace',
        name: 'workspace_tools',
        description: 'Workspace tools',
        tools: [{ type: 'function', name: 'read_file', description: 'Read', parameters: {}, defer_loading: true }]
      }, { type: 'tool_search' }]
    }
  });
  const fullToolMetadata = JSON.parse(toolSnapshot.clientMetadata['x-codex-turn-metadata']);
  const boundedToolMetadata = JSON.parse(toolSnapshot.compatibilityTurnMetadata);
  assertEqual(fullToolMetadata.tool_namespaces_info.workspace_tools.functions.read_file.deferred, true, 'tool namespace metadata');
  assertEqual(fullToolMetadata.tool_namespaces_info.functions.functions.open_file.direct, true, 'direct function metadata');
  assertEqual(fullToolMetadata.tool_namespaces_info.tool_search.functions.tool_search_tool.direct, true, 'Tool Search metadata');
  assertEqual('tool_namespaces_info' in boundedToolMetadata, false, 'compatibility header omits unbounded tool inventory');
  assertEqual(getCodexCompatibilityProfile('https://chatgpt.com/backend-api/codex/responses', { kind: 'codexAccessToken' }).enabled, true, 'Codex profile enabled');
  assertEqual(getCodexCompatibilityProfile('https://api.openai.com/v1', { kind: 'openaiApiKey' }).enabled, false, 'BYOK profile disabled');
  assertEqual(getCodexCompatibilityProfile('https://gateway.example/v1', { kind: 'openaiApiKey' }, 'custom').enabled, true, 'custom HTTPS profile enabled');
  assertEqual(getCodexCompatibilityProfile('https://chatgpt.com/backend-api/codex/responses', { kind: 'codexAccessToken' }, 'minimal').enabled, false, 'minimal profile disabled');
  console.log('Smoke test passed: Codex protocol constants, headers, gating, and metadata are stable.');
} finally {
  await loaded.dispose();
}
