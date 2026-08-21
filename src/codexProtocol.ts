import type { ApiCredentials } from './secrets';
import type { CodexToolPlan } from './nativeToolSearch/nativeToolTypes';

// Protocol baseline: openai/codex@711a5f8b3a6eb40134146ae9ec22fdcdda5e3170.
export const CODEX_PROTOCOL_UPSTREAM_COMMIT = '711a5f8b3a6eb40134146ae9ec22fdcdda5e3170';
export const CODEX_RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';

export const CodexHeader = {
  accountId: 'ChatGPT-Account-ID',
  beta: 'OpenAI-Beta',
  installationId: 'x-codex-installation-id',
  parentThreadId: 'x-codex-parent-thread-id',
  routingHint: 'x-codex-routing-hint',
  requestId: 'x-client-request-id',
  sessionId: 'session-id',
  threadId: 'thread-id',
  turnMetadata: 'x-codex-turn-metadata',
  turnState: 'x-codex-turn-state',
  windowId: 'x-codex-window-id'
} as const;

export const CodexResponseHeader = {
  modelsEtag: 'x-models-etag',
  reasoningIncluded: 'x-reasoning-included',
  requestId: 'x-request-id',
  serverModel: 'openai-model',
  turnState: 'x-codex-turn-state'
} as const;

export interface CodexCompatibilityProfile {
  enabled: boolean;
  endpointKey: string;
}

export interface CodexRequestIdentity {
  installationId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  windowId: string;
  parentThreadId?: string;
  parentTurnId?: string;
  rootTurnId?: string;
}

export interface CodexToolFunctionMetadata {
  name: string;
  direct: boolean;
  code_mode_name: string | null;
  deferred: boolean;
  source: { kind: 'harness' };
}

export interface CodexToolNamespaceMetadata {
  name: string;
  functions: Record<string, CodexToolFunctionMetadata>;
}

export interface CodexTurnMetadata extends Record<string, unknown> {
  installation_id: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  window_id: string;
  parent_thread_id: string | null;
  parent_turn_id?: string;
  root_turn_id?: string;
  agent_name: string;
  turn_started_at_unix_ms: number;
  tool_namespaces_info?: Record<string, CodexToolNamespaceMetadata>;
  request_kind: 'turn' | 'prewarm';
  source: 'vscode-language-model-provider';
}

export type CodexProtocolProfileName = 'auto' | 'codexCompatible' | 'minimal' | 'custom';

export interface CodexProtocolSettings {
  profile: CodexProtocolProfileName;
  headerOverrides: Record<string, string>;
  clientMetadataOverrides: Record<string, string>;
  turnMetadataOverrides: Record<string, unknown>;
  omitGeneratedHeaders: string[];
  allowUnsafeProtocolOverrides: boolean;
}

export interface CodexProtocolSnapshot {
  identity: CodexRequestIdentity;
  requestKind: CodexTurnMetadata['request_kind'];
  turnMetadata: CodexTurnMetadata;
  clientMetadata: Record<string, string>;
  compatibilityTurnMetadata: string;
  settings: CodexProtocolSettings;
}

export interface CodexEffectiveProtocolDiagnostic {
  profile: CodexProtocolProfileName;
  headers?: Record<string, string>;
  clientMetadata: Record<string, string>;
  turnMetadata: Record<string, unknown>;
}

let lastEffectiveProtocol: CodexEffectiveProtocolDiagnostic | undefined;
let lastEffectiveProtocolIdentityKey: string | undefined;

export interface CodexDynamicHeaderContext {
  credentialsHeaders?: Record<string, string>;
  identity: CodexRequestIdentity;
  turnMetadata: string;
  snapshot?: CodexProtocolSnapshot;
  turnState?: string;
  extensionVersion: string;
  userAgent: string;
}

export interface CodexWebSocketPreconnectHeaderContext {
  credentialsHeaders?: Record<string, string>;
  extensionVersion: string;
  userAgent: string;
  settings?: CodexProtocolSettings;
}

export type CodexTransportKind = 'http' | 'websocket';

export function getCodexCompatibilityProfile(
  baseURL: string,
  credentials: Pick<ApiCredentials, 'kind'>,
  selectedProfile: CodexProtocolProfileName = 'auto'
): CodexCompatibilityProfile {
  const normalized = normalizeCodexEndpoint(baseURL);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { enabled: false, endpointKey: normalized };
  }

  const isCodexEndpoint = credentials.kind === 'codexAccessToken'
    && url.protocol === 'https:'
    && url.hostname.toLowerCase() === 'chatgpt.com'
    && /^\/backend-api\/codex(?:\/|$)/.test(url.pathname);
  const enabled = selectedProfile === 'minimal'
    ? false
    : selectedProfile === 'custom'
      ? url.protocol === 'https:'
      : isCodexEndpoint;
  return {
    enabled,
    endpointKey: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  };
}

export function buildCodexRequestHeaders(
  context: CodexDynamicHeaderContext,
  transport: CodexTransportKind
): Record<string, string> {
  const snapshot = context.snapshot;
  const headers: Record<string, string> = {
    ...context.credentialsHeaders,
    'User-Agent': context.userAgent,
    originator: 'codex-for-copilot',
    version: context.extensionVersion,
    [CodexHeader.requestId]: context.identity.threadId,
    [CodexHeader.sessionId]: context.identity.sessionId,
    [CodexHeader.threadId]: context.identity.threadId,
    [CodexHeader.installationId]: context.identity.installationId,
    [CodexHeader.windowId]: context.identity.windowId,
    [CodexHeader.turnMetadata]: snapshot?.compatibilityTurnMetadata ?? context.turnMetadata
  };

  if (context.identity.parentThreadId) {
    headers[CodexHeader.parentThreadId] = context.identity.parentThreadId;
  }
  if (context.turnState) {
    headers[CodexHeader.turnState] = context.turnState;
  }
  if (snapshot) {
    applyGeneratedHeaderOmissions(headers, snapshot.settings);
    applyHeaderOverrides(headers, snapshot.settings);
  }
  if (transport === 'websocket') {
    headers[CodexHeader.beta] = CODEX_RESPONSES_WEBSOCKET_BETA;
  } else {
    headers.Accept = 'text/event-stream';
    headers['Content-Type'] = 'application/json';
  }

  restoreCredentialHeaders(headers, context.credentialsHeaders);
  if (context.turnState) {
    headers[CodexHeader.turnState] = context.turnState;
  }

  if (snapshot) {
    lastEffectiveProtocol = {
      ...createProtocolDiagnostic(snapshot),
      headers: redactHeaders(headers)
    };
    lastEffectiveProtocolIdentityKey = getSnapshotIdentityKey(snapshot);
  }

  return headers;
}

export function buildCodexWebSocketPreconnectHeaders(
  context: CodexWebSocketPreconnectHeaderContext
): Record<string, string> {
  const headers = {
    ...context.credentialsHeaders,
    'User-Agent': context.userAgent,
    originator: 'codex-for-copilot',
    version: context.extensionVersion,
    [CodexHeader.beta]: CODEX_RESPONSES_WEBSOCKET_BETA
  };
  if (context.settings) {
    applyGeneratedHeaderOmissions(headers, context.settings);
    applyHeaderOverrides(headers, context.settings);
  }
  headers[CodexHeader.beta] = CODEX_RESPONSES_WEBSOCKET_BETA;
  restoreCredentialHeaders(headers, context.credentialsHeaders);
  return headers;
}

export function createCodexTurnMetadata(
  identity: CodexRequestIdentity,
  requestKind: CodexTurnMetadata['request_kind'] = 'turn',
  turnStartedAtUnixMs = Date.now(),
  toolPlan?: CodexToolPlan
): CodexTurnMetadata {
  return {
    installation_id: identity.installationId,
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    turn_id: identity.turnId,
    window_id: identity.windowId,
    parent_thread_id: identity.parentThreadId ?? null,
    ...(identity.parentTurnId ? { parent_turn_id: identity.parentTurnId } : {}),
    ...(identity.rootTurnId ? { root_turn_id: identity.rootTurnId } : {}),
    agent_name: 'codex-for-copilot',
    turn_started_at_unix_ms: turnStartedAtUnixMs,
    ...buildToolNamespacesMetadata(toolPlan),
    request_kind: requestKind,
    source: 'vscode-language-model-provider'
  };
}

export function buildCodexProtocolSnapshot(options: {
  identity: CodexRequestIdentity;
  requestKind?: CodexTurnMetadata['request_kind'];
  turnStartedAtUnixMs?: number;
  toolPlan?: CodexToolPlan;
  settings?: Partial<CodexProtocolSettings>;
}): CodexProtocolSnapshot {
  const requestKind = options.requestKind ?? 'turn';
  const settings = normalizeCodexProtocolSettings(options.settings);
  const generated = createCodexTurnMetadata(
    options.identity,
    requestKind,
    options.turnStartedAtUnixMs,
    options.toolPlan
  );
  const turnMetadata = mergeMetadataOverrides(generated, settings.turnMetadataOverrides, settings.allowUnsafeProtocolOverrides);
  const fullTurnMetadata = stableSerializeCodexMetadata(turnMetadata);
  const compatibilityTurnMetadata = stableSerializeCodexMetadata({
    ...turnMetadata,
    tool_namespaces_info: undefined
  } as CodexTurnMetadata);
  const generatedClientMetadata: Record<string, string> = {
    [CodexHeader.installationId]: String(turnMetadata.installation_id),
    session_id: String(turnMetadata.session_id),
    thread_id: String(turnMetadata.thread_id),
    turn_id: String(turnMetadata.turn_id),
    [CodexHeader.windowId]: String(turnMetadata.window_id),
    [CodexHeader.turnMetadata]: fullTurnMetadata,
    ...(turnMetadata.parent_thread_id
      ? { [CodexHeader.parentThreadId]: String(turnMetadata.parent_thread_id) }
      : {}),
    ...(turnMetadata.parent_turn_id ? { parent_turn_id: String(turnMetadata.parent_turn_id) } : {}),
    ...(turnMetadata.root_turn_id ? { root_turn_id: String(turnMetadata.root_turn_id) } : {})
  };
  const clientMetadata = mergeClientMetadataOverrides(
    generatedClientMetadata,
    settings.clientMetadataOverrides,
    settings.allowUnsafeProtocolOverrides
  );
  const snapshot = { identity: options.identity, requestKind, turnMetadata, clientMetadata, compatibilityTurnMetadata, settings };
  const previousHeaders = lastEffectiveProtocolIdentityKey === getSnapshotIdentityKey(snapshot)
    ? lastEffectiveProtocol?.headers
    : undefined;
  lastEffectiveProtocol = {
    ...createProtocolDiagnostic(snapshot),
    ...(previousHeaders ? { headers: previousHeaders } : {})
  };
  lastEffectiveProtocolIdentityKey = getSnapshotIdentityKey(snapshot);
  return snapshot;
}

export function getLastEffectiveCodexProtocol(): CodexEffectiveProtocolDiagnostic | undefined {
  return lastEffectiveProtocol ? structuredClone(lastEffectiveProtocol) : undefined;
}

export function buildCodexClientMetadataProjection(
  snapshot: CodexProtocolSnapshot,
  websocketRequestStartedAt?: number
): Record<string, string> {
  return {
    ...snapshot.clientMetadata,
    ...(websocketRequestStartedAt === undefined
      ? {}
      : { 'x-codex-ws-stream-request-start-ms': String(websocketRequestStartedAt) })
  };
}

export function normalizeCodexProtocolSettings(
  settings: Partial<CodexProtocolSettings> | undefined
): CodexProtocolSettings {
  return {
    profile: settings?.profile ?? 'auto',
    headerOverrides: { ...settings?.headerOverrides },
    clientMetadataOverrides: { ...settings?.clientMetadataOverrides },
    turnMetadataOverrides: { ...settings?.turnMetadataOverrides },
    omitGeneratedHeaders: [...(settings?.omitGeneratedHeaders ?? [])],
    allowUnsafeProtocolOverrides: settings?.allowUnsafeProtocolOverrides === true
  };
}

const RESERVED_METADATA_KEYS = new Set([
  'installation_id', 'session_id', 'thread_id', 'turn_id', 'window_id', 'request_kind',
  'parent_thread_id', 'parent_turn_id', 'root_turn_id', 'agent_name',
  'tool_namespaces_info', 'turn_started_at_unix_ms', CodexHeader.installationId,
  CodexHeader.windowId, CodexHeader.parentThreadId, CodexHeader.turnMetadata
]);

const ALWAYS_PROTECTED_HEADERS = new Set([
  'authorization', 'chatgpt-account-id', 'host', 'content-length', 'connection', 'upgrade',
  'openai-beta', 'accept', 'content-type', CodexHeader.turnState
].map((value) => value.toLowerCase()));

const SAFE_PROTECTED_HEADERS = new Set([
  CodexHeader.requestId, CodexHeader.sessionId, CodexHeader.threadId, CodexHeader.installationId,
  CodexHeader.windowId, CodexHeader.parentThreadId, CodexHeader.turnMetadata
].map((value) => value.toLowerCase()));

function buildToolNamespacesMetadata(toolPlan: CodexToolPlan | undefined): Partial<CodexTurnMetadata> {
  if (!toolPlan || toolPlan.mode !== 'native-hosted') {
    return {};
  }
  const namespaces: Record<string, CodexToolNamespaceMetadata> = {};
  for (const tool of toolPlan.responseTools) {
    if (tool.type === 'function') {
      addToolFunctionMetadata(namespaces, 'functions', tool.name, true, false);
    } else if (tool.type === 'namespace') {
      for (const nested of tool.tools) {
        addToolFunctionMetadata(namespaces, tool.name, nested.name, true, nested.defer_loading === true);
      }
    } else if (tool.type === 'tool_search') {
      addToolFunctionMetadata(namespaces, 'tool_search', 'tool_search_tool', true, false);
    }
  }
  return Object.keys(namespaces).length > 0 ? { tool_namespaces_info: namespaces } : {};
}

function addToolFunctionMetadata(
  namespaces: Record<string, CodexToolNamespaceMetadata>,
  namespaceName: string,
  functionName: string,
  direct: boolean,
  deferred: boolean
): void {
  const namespace = namespaces[namespaceName] ??= { name: namespaceName, functions: {} };
  namespace.functions[functionName] = {
    name: functionName,
    direct,
    code_mode_name: null,
    deferred,
    source: { kind: 'harness' }
  };
}

function mergeMetadataOverrides(
  generated: CodexTurnMetadata,
  overrides: Record<string, unknown>,
  allowUnsafe: boolean
): CodexTurnMetadata {
  const accepted = Object.fromEntries(Object.entries(overrides)
    .filter(([key, value]) => isValidExtraMetadata(key, value) && (allowUnsafe || !RESERVED_METADATA_KEYS.has(key)))
    .slice(0, 16));
  return { ...generated, ...accepted } as CodexTurnMetadata;
}

function mergeClientMetadataOverrides(
  generated: Record<string, string>,
  overrides: Record<string, string>,
  allowUnsafe: boolean
): Record<string, string> {
  const accepted = Object.fromEntries(Object.entries(overrides)
    .filter(([key, value]) => isValidExtraMetadata(key, value) && (allowUnsafe || !RESERVED_METADATA_KEYS.has(key)))
    .slice(0, 16));
  return { ...generated, ...accepted };
}

function isValidExtraMetadata(key: string, value: unknown): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)
    && (typeof value === 'string' ? Buffer.byteLength(value) <= 128 : isJsonValue(value));
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function applyGeneratedHeaderOmissions(headers: Record<string, string>, settings: CodexProtocolSettings): void {
  for (const name of settings.omitGeneratedHeaders) {
    const normalized = name.toLowerCase();
    if (ALWAYS_PROTECTED_HEADERS.has(normalized) || (!settings.allowUnsafeProtocolOverrides && SAFE_PROTECTED_HEADERS.has(normalized))) {
      continue;
    }
    deleteHeader(headers, name);
  }
}

function applyHeaderOverrides(headers: Record<string, string>, settings: CodexProtocolSettings): void {
  for (const [name, value] of Object.entries(settings.headerOverrides).slice(0, 32)) {
    const normalized = name.toLowerCase();
    if (!isValidHeaderName(name) || !isValidHeaderValue(value)
      || ALWAYS_PROTECTED_HEADERS.has(normalized)
      || normalized.startsWith('sec-websocket-')
      || (!settings.allowUnsafeProtocolOverrides && SAFE_PROTECTED_HEADERS.has(normalized))) {
      continue;
    }
    deleteHeader(headers, name);
    headers[name] = value;
  }
}

function restoreCredentialHeaders(headers: Record<string, string>, credentials: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(credentials ?? {})) {
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'chatgpt-account-id') {
      deleteHeader(headers, name);
      headers[name] = value;
    }
  }
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const normalized = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === normalized) {
      delete headers[existing];
    }
  }
}

function isValidHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function isValidHeaderValue(value: string): boolean {
  return typeof value === 'string' && Buffer.byteLength(value) <= 1024 && !/[\r\n]/.test(value);
}

function createProtocolDiagnostic(snapshot: CodexProtocolSnapshot): CodexEffectiveProtocolDiagnostic {
  return {
    profile: snapshot.settings.profile,
    clientMetadata: redactMetadataRecord(snapshot.clientMetadata),
    turnMetadata: redactObject(snapshot.turnMetadata) as Record<string, unknown>
  };
}

function getSnapshotIdentityKey(snapshot: CodexProtocolSnapshot): string {
  return `${snapshot.identity.threadId}:${snapshot.identity.turnId}:${snapshot.requestKind}`;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const normalized = key.toLowerCase();
    if (normalized === 'authorization' || normalized === 'chatgpt-account-id' || normalized === CodexHeader.turnState) {
      return [key, '<redacted>'];
    }
    if (normalized === CodexHeader.turnMetadata) {
      return [key, redactSerializedMetadata(value)];
    }
    return [key, isIdentityKey(normalized) ? '<redacted:id>' : value];
  }));
}

function redactMetadataRecord(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [
    key,
    key.toLowerCase() === CodexHeader.turnMetadata
      ? redactSerializedMetadata(value)
      : isIdentityKey(key.toLowerCase()) ? '<redacted:id>' : value
  ]));
}

function redactSerializedMetadata(value: string): string {
  try {
    return stableSerializeCodexMetadata(redactObject(JSON.parse(value)) as CodexTurnMetadata);
  } catch {
    return '<redacted:metadata>';
  }
}

function redactObject(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactObject(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([nestedKey, nested]) => [nestedKey, redactObject(nested, nestedKey)]));
  }
  return key && isIdentityKey(key.toLowerCase()) ? '<redacted:id>' : value;
}

function isIdentityKey(key: string): boolean {
  return key === 'session_id' || key === 'thread_id' || key === 'turn_id' || key === 'window_id'
    || key === 'installation_id' || key === 'parent_thread_id' || key === 'parent_turn_id'
    || key === 'root_turn_id' || key === CodexHeader.sessionId || key === CodexHeader.threadId
    || key === CodexHeader.requestId || key === CodexHeader.installationId || key === CodexHeader.windowId
    || key === CodexHeader.parentThreadId;
}

export function stableSerializeCodexMetadata(metadata: CodexTurnMetadata): string {
  return JSON.stringify(sortValue(metadata));
}

export function parseCodexResponseHeaders(headers: Headers): {
  turnState?: string;
  modelsEtag?: string;
  reasoningIncluded: boolean;
  serverModel?: string;
  requestId?: string;
} {
  const get = (name: string) => headers.get(name)?.trim() || undefined;
  return {
    turnState: get(CodexResponseHeader.turnState),
    modelsEtag: get(CodexResponseHeader.modelsEtag),
    reasoningIncluded: get(CodexResponseHeader.reasoningIncluded)?.toLowerCase() === 'true',
    serverModel: get(CodexResponseHeader.serverModel),
    requestId: get(CodexResponseHeader.requestId)
  };
}

export function normalizeCodexEndpoint(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]));
  }
  return value;
}
