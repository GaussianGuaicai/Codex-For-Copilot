import { loadBundled, assertEqual } from './testBundleHelper.mjs';
import { readFile } from 'node:fs/promises';

const loaded = await loadBundled('src/codexProtocol.ts');
const loadedIdentity = await loadBundled('src/codexRequestIdentity.ts');
try {
  const {
    CODEX_RESPONSES_WEBSOCKET_BETA,
    buildCodexProtocolSnapshot,
    buildCodexRequestHeaders,
    buildCodexWebSocketPreconnectHeaders,
    createCodexTurnMetadata,
    getCodexCompatibilityProfile,
    stableSerializeCodexMetadata
  } = loaded.exports;
  const { resolveRequestIdentity, normalizeCustomRequestIdentity, CODEX_IDENTITY_UPSTREAM_COMMIT, CODEX_CLI_COMPATIBLE_VERSION } = loadedIdentity.exports;
  const fixture = JSON.parse(await readFile(new URL('./fixtures/codex-cli-identity.json', import.meta.url), 'utf8'));
  const identity = {
    installationId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    turnId: '44444444-4444-4444-8444-444444444444',
    windowId: '55555555-5555-4555-8555-555555555555'
  };
  const turnStartedAtUnixMs = 1_787_000_000_000;
  const extensionIdentity = { profile: 'extension', originator: 'codex-for-copilot', userAgent: 'codex-for-copilot/1.2.3 (test)', version: '1.2.3', agentName: 'codex-for-copilot', source: 'vscode-language-model-provider' };
  const metadata = stableSerializeCodexMetadata(createCodexTurnMetadata(identity, 'turn', turnStartedAtUnixMs, undefined, extensionIdentity));
  const headers = buildCodexRequestHeaders({
    credentialsHeaders: { 'ChatGPT-Account-ID': 'acct-test' },
    identity,
    turnMetadata: metadata,
    clientIdentity: extensionIdentity
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
    clientIdentity: extensionIdentity,
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
    clientIdentity: extensionIdentity
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
  const cliIdentity = resolveRequestIdentity({ profile: 'codexCliCompatible', extensionVersion: '1.2.3', extensionUserAgent: 'unused', platform: fixture.platform });
  assertEqual(JSON.stringify(cliIdentity), JSON.stringify(fixture.identity), 'pinned CLI identity fixture');
  assertEqual(CODEX_IDENTITY_UPSTREAM_COMMIT, fixture.upstreamCommit, 'identity upstream commit');
  assertEqual(CODEX_CLI_COMPATIBLE_VERSION, fixture.codexVersion, 'compatible Codex version');
  for (const profile of ['extension', 'codexCliCompatible', 'neutral', 'custom']) {
    const clientIdentity = resolveRequestIdentity({ profile, extensionVersion: '1.2.3', extensionUserAgent: 'codex-for-copilot/1.2.3 (test)', custom: { originator: 'third-party', userAgent: 'third-party/4', version: '4', agentName: 'third-party', source: 'gateway' }, platform: fixture.platform });
    const snapshot = buildCodexProtocolSnapshot({ identity, turnStartedAtUnixMs, clientIdentity });
    const http = buildCodexRequestHeaders({ credentialsHeaders: { Authorization: 'Bearer real' }, identity, turnMetadata: snapshot.compatibilityTurnMetadata, snapshot, turnState: 'real-state', clientIdentity }, 'http');
    const websocket = buildCodexRequestHeaders({ credentialsHeaders: { Authorization: 'Bearer real' }, identity, turnMetadata: snapshot.compatibilityTurnMetadata, snapshot, turnState: 'real-state', clientIdentity }, 'websocket');
    const preconnect = buildCodexWebSocketPreconnectHeaders({ credentialsHeaders: { Authorization: 'Bearer real' }, clientIdentity });
    assertEqual(http.originator, websocket.originator, `${profile} transport originator parity`);
    assertEqual(http['User-Agent'], websocket['User-Agent'], `${profile} transport UA parity`);
    assertEqual(preconnect.originator, websocket.originator, `${profile} preconnect originator parity`);
    assertEqual(preconnect['User-Agent'], websocket['User-Agent'], `${profile} preconnect UA parity`);
    if (profile === 'neutral') {
      assertEqual(JSON.stringify({ http, metadata: snapshot.turnMetadata }).includes('codex-for-copilot'), false, 'neutral has no extension branding');
      assertEqual(http['session-id'], identity.sessionId, 'neutral retains protocol identity');
    }
  }
  const malformed = normalizeCustomRequestIdentity({ originator: 'bad\r\nvalue', userAgent: '\u0000bad', source: 'ok', version: 'x'.repeat(129) });
  assertEqual(JSON.stringify(malformed), JSON.stringify({ source: 'ok' }), 'malformed custom identity is removed');
  const unsafeSnapshot = buildCodexProtocolSnapshot({ identity, clientIdentity: extensionIdentity, settings: { allowUnsafeProtocolOverrides: true, headerOverrides: { Authorization: 'fake', 'x-codex-turn-state': 'fake', 'OpenAI-Beta': 'fake', 'Sec-WebSocket-Key': 'fake', 'x-oai-attestation': 'fake' } } });
  const protectedHeaders = buildCodexRequestHeaders({ credentialsHeaders: { Authorization: 'Bearer real' }, identity, snapshot: unsafeSnapshot, turnMetadata: unsafeSnapshot.compatibilityTurnMetadata, turnState: 'real-state', clientIdentity: extensionIdentity }, 'websocket');
  assertEqual(protectedHeaders.Authorization, 'Bearer real', 'unsafe cannot replace credentials');
  assertEqual(protectedHeaders['x-codex-turn-state'], 'real-state', 'unsafe cannot replace Turn State');
  assertEqual(protectedHeaders['OpenAI-Beta'], CODEX_RESPONSES_WEBSOCKET_BETA, 'unsafe cannot replace WebSocket beta');
  assertEqual(protectedHeaders['Sec-WebSocket-Key'], undefined, 'unsafe cannot forge WebSocket security');
  assertEqual(protectedHeaders['x-oai-attestation'], undefined, 'unsafe cannot forge attestation');
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
  await loadedIdentity.dispose();
  await loaded.dispose();
}
