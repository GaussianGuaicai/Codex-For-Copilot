import type { ApiCredentials } from './secrets';

// Protocol baseline: openai/codex@72b41c55fb32f62373e070d6ac0cde7ba563989b.
export const CODEX_PROTOCOL_UPSTREAM_COMMIT = '72b41c55fb32f62373e070d6ac0cde7ba563989b';
export const CODEX_RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';

export const CodexHeader = {
  accountId: 'ChatGPT-Account-ID',
  beta: 'OpenAI-Beta',
  installationId: 'x-codex-installation-id',
  parentThreadId: 'x-codex-parent-thread-id',
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
}

export interface CodexTurnMetadata {
  installation_id: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  window_id: string;
  parent_thread_id: string | null;
  request_kind: 'turn' | 'prewarm';
  source: 'vscode-language-model-provider';
}

export interface CodexDynamicHeaderContext {
  credentialsHeaders?: Record<string, string>;
  identity: CodexRequestIdentity;
  turnMetadata: string;
  turnState?: string;
  extensionVersion: string;
  userAgent: string;
}

export interface CodexWebSocketPreconnectHeaderContext {
  credentialsHeaders?: Record<string, string>;
  extensionVersion: string;
  userAgent: string;
}

export type CodexTransportKind = 'http' | 'websocket';

export function getCodexCompatibilityProfile(
  baseURL: string,
  credentials: Pick<ApiCredentials, 'kind'>
): CodexCompatibilityProfile {
  const normalized = normalizeCodexEndpoint(baseURL);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { enabled: false, endpointKey: normalized };
  }

  const enabled = credentials.kind === 'codexAccessToken'
    && url.protocol === 'https:'
    && url.hostname.toLowerCase() === 'chatgpt.com'
    && /^\/backend-api\/codex(?:\/|$)/.test(url.pathname);
  return {
    enabled,
    endpointKey: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  };
}

export function buildCodexRequestHeaders(
  context: CodexDynamicHeaderContext,
  transport: CodexTransportKind
): Record<string, string> {
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
    [CodexHeader.turnMetadata]: context.turnMetadata
  };

  if (context.identity.parentThreadId) {
    headers[CodexHeader.parentThreadId] = context.identity.parentThreadId;
  }
  if (context.turnState) {
    headers[CodexHeader.turnState] = context.turnState;
  }
  if (transport === 'websocket') {
    headers[CodexHeader.beta] = CODEX_RESPONSES_WEBSOCKET_BETA;
  } else {
    headers.Accept = 'text/event-stream';
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

export function buildCodexWebSocketPreconnectHeaders(
  context: CodexWebSocketPreconnectHeaderContext
): Record<string, string> {
  return {
    ...context.credentialsHeaders,
    'User-Agent': context.userAgent,
    originator: 'codex-for-copilot',
    version: context.extensionVersion,
    [CodexHeader.beta]: CODEX_RESPONSES_WEBSOCKET_BETA
  };
}

export function createCodexTurnMetadata(
  identity: CodexRequestIdentity,
  requestKind: CodexTurnMetadata['request_kind'] = 'turn'
): CodexTurnMetadata {
  return {
    installation_id: identity.installationId,
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    turn_id: identity.turnId,
    window_id: identity.windowId,
    parent_thread_id: identity.parentThreadId ?? null,
    request_kind: requestKind,
    source: 'vscode-language-model-provider'
  };
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
