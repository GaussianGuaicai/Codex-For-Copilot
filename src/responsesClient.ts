import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  InternalServerError,
  RateLimitError
} from 'openai';
import { ResponsesWS, type ResponsesWSClientOptions } from 'openai/resources/responses/ws';
import type {
  ResponsesClientEvent,
  ResponsesServerEvent,
  ResponseUsage,
  Tool
} from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
import * as vscode from 'vscode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ResponsesInputMessage } from './convertMessages';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { codexFetch } from './auth/codexAuthRequest';
import { proxyAwareFetch } from './proxyFetch';
import { resolveProxyForURL } from './proxy';
import {
  buildCodexWebSocketPreconnectHeaders,
  buildCodexRequestHeaders,
  buildCodexProtocolSnapshot,
  type CodexCompatibilityProfile,
  type CodexProtocolSettings,
  type CodexRequestIdentity
} from './codexProtocol';
import {
  buildCodexResponsesRequest,
  buildCodexResponsesRequestWithMetrics,
  type CodexRequestBuilderOptions
} from './codexRequestBuilder';
import { createCodexFetchAdapter, type RequestCompressionPolicy } from './codexFetchAdapter';
import {
  codexConnectionManager,
  type CodexConnectionOrigin,
  type CodexConnectionScope,
  type CodexConnectionScopeBase
} from './codexConnectionManager';
import type { CodexWebSocketHandshake, CodexWebSocketPreconnectionObserver } from './codexWebSocketSession';
import type { CodexFunctionCallEvent, CodexToolPlan } from './nativeToolSearch/nativeToolTypes';
import {
  extractWebSearchSources,
  projectHostedToolLifecycleEvent,
  type HostedToolLifecycleEvent,
  type WebSearchSource
} from './hostedTools/hostedToolEvents';

const OPENAI_DEFAULT_MAX_RETRIES = 2;
const OPENAI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REUSABLE_WEBSOCKET_TTL_MS = 10 * 60 * 1000;
const MAX_REUSABLE_WEBSOCKETS = 32;
const WEBSOCKET_PREWARM_BUDGET_MS = 400;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = 'previous_response_not_found';
const PREVIOUS_RESPONSE_ID_PARAM = 'previous_response_id';
const INVALID_PREVIOUS_RESPONSE_ID_MESSAGE = 'Invalid previous_response_id.';
const CONTINUATION_MISS_MESSAGE = 'Responses API could not find previous_response_id.';
const MAX_ERROR_TRAVERSAL_NODES = 64;
const MAX_ERROR_TRAVERSAL_DEPTH = 8;
const MAX_ERROR_JSON_LENGTH = 16 * 1024;
const STREAM_RATE_LIMIT_MAX_RETRIES = 1;
const UNREADABLE_ERROR_PROPERTY = Symbol('unreadableErrorProperty');

interface ReusableResponsesWebSocketSession {
  socket: ResponsesWS;
  key?: string;
  inUse: boolean;
  updatedAt: number;
}

const reusableWebSocketSessions = new Map<string, ReusableResponsesWebSocketSession>();

export type ReasoningStreamSource = 'summary' | 'reasoning-text';

export interface ReasoningStreamDelta {
  source: ReasoningStreamSource;
  text: string;
  itemId: string;
  partIndex: number;
  outputIndex: number;
  /**
   * Stable identity for one server-declared reasoning summary part. This is
   * distinct from summary_index when a backend reuses that index for several
   * separately rendered summary entries.
   */
  presentationId?: string;
}

export interface ReasoningStreamLifecycleEvent {
  phase: 'part-added' | 'text-started' | 'text-completed' | 'part-completed';
  source: ReasoningStreamSource;
  itemId: string;
  partIndex: number;
  outputIndex: number;
  presentationId?: string;
  sequenceNumber?: number;
  textLength?: number;
}

export interface CountInputTokensOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  authManager?: CodexAuthManager;
  accountKey?: string;
  model: string;
  input: string | ResponsesInputMessage[];
  token: vscode.CancellationToken;
}

export interface StreamResponseTextOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  authManager?: CodexAuthManager;
  accountKey?: string;
  transport?: 'auto' | 'http' | 'websocket';
  compatibilityProfile?: CodexCompatibilityProfile;
  identity?: CodexRequestIdentity;
  turnState?: string;
  authIdentity?: string;
  extensionVersion?: string;
  userAgent?: string;
  protocolSettings?: CodexProtocolSettings;
  turnStartedAtUnixMs?: number;
  websocketPrewarm?: 'auto' | 'enabled' | 'disabled';
  requestCompression?: RequestCompressionPolicy;
  previousResponseId?: string;
  allowToolOutputContinuation?: boolean;
  store?: boolean;
  omitMaxOutputTokens?: boolean;
  model: string;
  instructions: string;
  serviceTier?: 'default' | 'priority';
  input: ResponsesInputMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
  toolPlan?: CodexToolPlan;
  hostedTools?: readonly Tool[];
  toolMode?: vscode.LanguageModelChatToolMode;
  reasoning?: Reasoning;
  maxOutputTokens: number;
  token: vscode.CancellationToken;
  onTextDelta: (text: string) => void;
  onReasoningDelta?: (delta: ReasoningStreamDelta) => void;
  onReasoningLifecycleEvent?: (event: ReasoningStreamLifecycleEvent) => void;
  onToolCallAdded?: (callId: string, name: string) => void;
  onToolCallArgumentsDelta?: (callId: string, name: string) => void;
  onToolCallArgumentsDone?: (callId: string, name: string) => void;
  onToolCall?: (call: CodexFunctionCallEvent) => void;
  onHostedToolLifecycleEvent?: (event: HostedToolLifecycleEvent) => void;
  onWebSearchSources?: (sources: readonly WebSearchSource[]) => void;
  onRawResponseItem?: (item: unknown) => void;
  onTurnState?: (turnState: string) => void;
  onWebSocketHandshake?: (handshake: CodexWebSocketHandshake) => void;
  onTransportMetrics?: (metrics: Record<string, unknown>) => void;
  onResponseCreated?: (response: {
    id?: string;
    status?: string;
    service_tier?: string | null;
  }) => void;
  onResponseCompleted?: (response: {
    id?: string;
    usage?: ResponseUsage | null;
  }) => void;
  onResponseFailed?: (message: string) => void;
  hasProviderVisibleOutput?: () => boolean;
  onTransportFallback?: (event: {
    from: 'websocket';
    to: 'http';
    reason: string;
  }) => void;
  onWebSocketSession?: (event: {
    reused: boolean;
    origin?: CodexConnectionOrigin;
  }) => void;
}

export interface PreconnectCodexResponsesWebSocketOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  compatibilityProfile: CodexCompatibilityProfile;
  authIdentity: string;
  extensionVersion?: string;
  userAgent?: string;
  protocolSettings?: CodexProtocolSettings;
  onConnected?: CodexWebSocketPreconnectionObserver['onConnected'];
  onError?: CodexWebSocketPreconnectionObserver['onError'];
}

export function isResponsesContinuationMissError(error: unknown): error is ResponsesContinuationMissError {
  return error instanceof ResponsesContinuationMissError;
}

export function isResponsesContinuationMissPayload(error: unknown): boolean {
  let matched = false;
  walkErrorEnvelope(error, (value) => {
    if (typeof value === 'string') {
      matched = value.trim() === INVALID_PREVIOUS_RESPONSE_ID_MESSAGE;
      return !matched;
    }
    if (typeof value !== 'object' || value === null) {
      return true;
    }

    const code = readOwnErrorProperty(value, 'code');
    if (code !== PREVIOUS_RESPONSE_NOT_FOUND_CODE) {
      return true;
    }

    const param = readOwnErrorProperty(value, 'param');
    matched = param === undefined || param === null || param === PREVIOUS_RESPONSE_ID_PARAM;
    return !matched;
  });
  return matched;
}

export function disposeReusableResponsesWebSockets(): void {
  codexConnectionManager.dispose();
  const sessions = new Set(reusableWebSocketSessions.values());
  reusableWebSocketSessions.clear();

  for (const session of sessions) {
    closeReusableWebSocketSession(session);
  }
}

export function preconnectCodexResponsesWebSocket(options: PreconnectCodexResponsesWebSocketOptions): boolean {
  const scope = getManagedPreconnectionScope(options);
  if (!scope) {
    return false;
  }

  const headers = buildCodexWebSocketPreconnectHeaders({
    credentialsHeaders: options.headers,
    extensionVersion: options.extensionVersion ?? '0.0.0',
    userAgent: options.userAgent ?? `codex-for-copilot/${options.extensionVersion ?? '0.0.0'}`,
    settings: options.protocolSettings
  });

  try {
    const client = createOpenAIClient(options);
    return codexConnectionManager.preconnect(scope, client, createResponsesWsOptions(headers, options.baseURL), {
      onConnected: options.onConnected,
      onError: options.onError
    });
  } catch {
    return false;
  }
}

export async function streamResponseText(options: StreamResponseTextOptions): Promise<void> {
  const abortController = new AbortController();
  const cancellation = options.token.onCancellationRequested(() => abortController.abort());
  let visibleActivity = false;
  const visibleCallbacks: Partial<StreamResponseTextOptions> = {
    onTextDelta: (text) => {
      visibleActivity = true;
      options.onTextDelta(text);
    },
    onReasoningDelta: options.onReasoningDelta && ((delta) => {
      visibleActivity = true;
      options.onReasoningDelta!(delta);
    }),
    onToolCallArgumentsDone: options.onToolCallArgumentsDone && ((callId, name) => {
      visibleActivity = true;
      options.onToolCallArgumentsDone!(callId, name);
    }),
    onToolCall: options.onToolCall && ((call) => {
      visibleActivity = true;
      options.onToolCall!(call);
    })
  };
  const trackedOptions = new Proxy(options, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(visibleCallbacks, property)) {
        return Reflect.get(visibleCallbacks, property);
      }
      return Reflect.get(target, property, receiver);
    }
  });

  try {
    if (!options.instructions.trim()) {
      throw new Error('Codex requires a non-empty top-level instructions setting.');
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        await streamResponseTextOnce(trackedOptions, abortController);
        return;
      } catch (error) {
        if (!(error instanceof ResponsesStreamRateLimitError)
          || attempt >= STREAM_RATE_LIMIT_MAX_RETRIES
          || visibleActivity
          || options.hasProviderVisibleOutput?.() === true) {
          throw error;
        }
        options.onTransportMetrics?.({ retryReason: 'stream_rate_limit_exceeded' });
        await waitForRetryDelay(error.retryDelayMs, abortController.signal);
        if (options.token.isCancellationRequested || abortController.signal.aborted) {
          return;
        }
      }
    }
  } catch (error) {
    if (options.token.isCancellationRequested || abortController.signal.aborted) {
      return;
    }

    if (options.previousResponseId) {
      if (error instanceof ResponsesContinuationMissError) {
        throw error;
      }

      if (isResponsesContinuationMissPayload(error)) {
        throw new ResponsesContinuationMissError(
          CONTINUATION_MISS_MESSAGE,
          options.previousResponseId,
          { cause: error instanceof Error ? error : undefined }
        );
      }

      if (isOpaqueHttpContinuationRejection(error)) {
        throw new ResponsesContinuationMissError(
          'Responses API rejected previous_response_id with an opaque HTTP 400 response.',
          options.previousResponseId,
          { cause: error instanceof Error ? error : undefined },
          true
        );
      }

      if (isFunctionCallContinuationIntegrityError(error)) {
        throw new ResponsesContinuationMissError(
          'Responses API rejected continuation because function calls and outputs are inconsistent with previous_response_id.',
          options.previousResponseId,
          { cause: error instanceof Error ? error : undefined }
        );
      }
    }

    if (error instanceof ResponsesStreamRateLimitError) {
      options.onResponseFailed?.(error.message);
    }
    throw normalizeResponsesError(error, options.baseURL);
  } finally {
    cancellation.dispose();
  }
}

async function streamResponseTextOnce(
  options: StreamResponseTextOptions,
  abortController: AbortController
): Promise<void> {
  const transport = options.transport ?? 'http';

  if (transport === 'websocket') {
    await streamResponseTextOverWebSocket(options, abortController);
    return;
  }

  if (transport === 'auto') {
    try {
      await streamResponseTextOverWebSocket(options, abortController);
      return;
    } catch (error) {
      if (!shouldFallbackToHttp(error, options.token, abortController.signal)) {
        throw error;
      }

      const managedScope = getManagedConnectionScope(options);
      if (managedScope) {
        codexConnectionManager.markHttpFallback(managedScope);
      }

      options.onTransportFallback?.({
        from: 'websocket',
        to: 'http',
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await streamResponseTextOverHttp(options, abortController);
}

async function streamResponseTextOverHttp(
  options: StreamResponseTextOptions,
  abortController: AbortController
): Promise<void> {
  const { request, metrics } = buildResponsesCreateRequest(options);
  options.onTransportMetrics?.({ ...metrics });
  const headers = buildDynamicHeaders(options, 'http');
  const client = createOpenAIClient(options, headers);

  const responsePromise = client.responses.create(
    request,
    {
      headers,
      signal: abortController.signal,
      maxRetries: OPENAI_DEFAULT_MAX_RETRIES,
      timeout: OPENAI_DEFAULT_TIMEOUT_MS
    }
  );
  const { data: stream, response, request_id: requestId } = await responsePromise.withResponse();
  const turnState = response.headers.get('x-codex-turn-state')?.trim();
  if (turnState) {
    options.onTurnState?.(turnState);
  }
  options.onTransportMetrics?.({
    transportActual: 'http',
    previousResponseIdUsed: Boolean(options.previousResponseId),
    incrementalInputCount: options.previousResponseId ? options.input.length : 0,
    requestIdPresent: Boolean(requestId),
    turnStateReceived: Boolean(turnState),
    serverModel: response.headers.get('openai-model') ?? undefined,
    modelsEtagPresent: Boolean(response.headers.get('x-models-etag'))
  });
  const handleEvent = createResponsesServerEventHandler(options);
  let sawTerminalEvent = false;

  for await (const event of stream) {
    if (options.token.isCancellationRequested) {
      abortController.abort();
      return;
    }

    if (event.type === 'response.completed'
      || event.type === 'response.failed'
      || event.type === 'response.incomplete'
      || event.type === 'error') {
      sawTerminalEvent = true;
    }
    handleEvent(event);
  }

  if (!sawTerminalEvent && !options.token.isCancellationRequested && !abortController.signal.aborted) {
    throw new Error('Responses HTTP stream ended before a terminal event.');
  }
}

async function streamResponseTextOverWebSocket(
  options: StreamResponseTextOptions,
  abortController: AbortController
): Promise<void> {
  if (options.compatibilityProfile?.enabled && options.identity && options.authIdentity) {
    await streamCodexResponseTextOverManagedWebSocket(options, abortController);
    return;
  }

  evictReusableWebSocketSessions();

  const reusedSession = takeReusableWebSocketSession(options);
  const session = reusedSession ?? createReusableWebSocketSession(options);
  const socket = session.socket;
  let reusableResponseId: string | undefined;
  let keepSession = false;
  const handleEvent = createResponsesServerEventHandler(options);

  options.onWebSocketSession?.({ reused: Boolean(reusedSession) });

  const closeSocket = (code = 1000, reason = 'OK') => {
    releaseReusableWebSocketSession(session, undefined, false);
    try {
      socket.close({ code, reason });
    } catch {
      // Best effort close. The stream iterator will surface any underlying error.
    }
  };

  const abortListener = () => closeSocket(1000, 'cancelled');
  abortController.signal.addEventListener('abort', abortListener, { once: true });

  let sawResponseActivity = false;
  let sawTerminalEvent = false;

  try {
    // Register the SDK error listener before sending on a reused open socket.
    // The backend can reject a bad previous_response_id immediately.
    const stream = socket.stream();
    socket.send(buildResponsesCreateEvent(options));

    for await (const streamEvent of stream) {
      if (options.token.isCancellationRequested) {
        abortController.abort();
        return;
      }

      if (streamEvent.type === 'message') {
        sawResponseActivity = true;
        const message = streamEvent.message;
        handleEvent(message);

        if (message.type === 'response.completed') {
          sawTerminalEvent = true;
          reusableResponseId = message.response.id ?? reusableResponseId;
          keepSession = Boolean(reusableResponseId) && isReusableWebSocketSessionOpen(session);
          return;
        }

        if (message.type === 'response.failed') {
          sawTerminalEvent = true;
          closeSocket();
          return;
        }

        continue;
      }

      if (streamEvent.type === 'error') {
        const mismatchedModel = getMismatchedModelNotFoundName(streamEvent.error, options.model);
        if (mismatchedModel) {
          releaseReusableWebSocketSession(session, undefined, false);
          disposeReusableResponsesWebSockets();
          throw new WebSocketTransportUnavailableError(
            `Responses WebSocket resolved stale model ${mismatchedModel} while requesting ${options.model}.`,
            { cause: streamEvent.error }
          );
        }

        if (options.previousResponseId && isResponsesContinuationMissPayload(streamEvent.error)) {
          releaseReusableWebSocketSession(session, undefined, false);
          throw new ResponsesContinuationMissError(
            CONTINUATION_MISS_MESSAGE,
            options.previousResponseId,
            { cause: streamEvent.error }
          );
        }

        if (!sawResponseActivity && !streamEvent.error.error) {
          releaseReusableWebSocketSession(session, undefined, false);
          throw new WebSocketTransportUnavailableError(streamEvent.error.message, { cause: streamEvent.error });
        }

        releaseReusableWebSocketSession(session, undefined, false);
        throw streamEvent.error;
      }

      if (streamEvent.type === 'close') {
        if (sawTerminalEvent || options.token.isCancellationRequested || abortController.signal.aborted) {
          return;
        }

        const message = streamEvent.reason || `WebSocket closed with code ${streamEvent.code}.`;

        if (!sawResponseActivity) {
          releaseReusableWebSocketSession(session, undefined, false);
          throw new WebSocketTransportUnavailableError(message);
        }

        releaseReusableWebSocketSession(session, undefined, false);
        throw new Error(message);
      }
    }

    if (!sawTerminalEvent && !options.token.isCancellationRequested && !abortController.signal.aborted) {
      releaseReusableWebSocketSession(session, undefined, false);
      throw new Error('Responses WebSocket stream ended before the response completed.');
    }
  } finally {
    abortController.signal.removeEventListener('abort', abortListener);

    if (keepSession) {
      releaseReusableWebSocketSession(session, reusableResponseId, true);
    } else if (!options.token.isCancellationRequested && !abortController.signal.aborted) {
      releaseReusableWebSocketSession(session, undefined, false);
    }
  }
}

async function streamCodexResponseTextOverManagedWebSocket(
  options: StreamResponseTextOptions,
  abortController: AbortController
): Promise<void> {
  const identity = options.identity!;
  const scope = getManagedConnectionScope(options)!;
  if (codexConnectionManager.isHttpFallback(scope)) {
    throw new WebSocketTransportUnavailableError('This Codex session is using its HTTP fallback.');
  }

  const headers = buildDynamicHeaders(options, 'websocket');
  const client = createOpenAIClient(options);
  let managed = codexConnectionManager.getOrCreate(scope, client, createResponsesWsOptions(headers, options.baseURL));
  options.onWebSocketSession?.({ reused: managed.reused, origin: managed.origin });
  const { request, metrics } = buildResponsesCreateRequest(options);
  options.onTransportMetrics?.({ ...metrics });
  const builderOptions = createRequestBuilderOptions(options);
  const handleEvent = createResponsesServerEventHandler(options);

  const prewarmMode = options.websocketPrewarm ?? 'auto';
  if (!managed.reused && prewarmMode === 'auto') {
    options.onTransportMetrics?.({ prewarmResult: 'skipped-auto' });
  }
  if (!managed.reused
    && prewarmMode === 'enabled'
    && !codexConnectionManager.isPrewarmDisabled(scope)) {
    const prewarmStartedAt = Date.now();
    const prewarmController = new AbortController();
    let prewarmTimedOut = false;
    const abortPrewarm = () => prewarmController.abort();
    abortController.signal.addEventListener('abort', abortPrewarm, { once: true });
    const prewarmBudget = setTimeout(() => {
      prewarmTimedOut = true;
      prewarmController.abort();
    }, WEBSOCKET_PREWARM_BUDGET_MS);
    prewarmBudget.unref?.();
    options.onTransportMetrics?.({
      prewarmEnabled: true,
      prewarmStartedAt,
      prewarmBudgetMs: WEBSOCKET_PREWARM_BUDGET_MS
    });
    try {
      const prewarm = await managed.session.prewarm({
        request,
        builderOptions,
        identity,
        allowToolOutputContinuation: false,
        signal: prewarmController.signal,
        onEvent: () => undefined,
        onRequestPrepared: (prepared) => reportManagedWebSocketRequestMetrics(options, prepared),
        onHandshake: (handshake, connectedAt) => {
          options.onWebSocketHandshake?.(handshake);
          options.onTransportMetrics?.({ websocketConnectedAt: connectedAt });
        }
      });
      reportManagedWebSocketResult(options, prewarm, 'prewarm', Date.now() - prewarmStartedAt);
    } catch (error) {
      if (options.token.isCancellationRequested || abortController.signal.aborted) {
        return;
      }
      codexConnectionManager.disablePrewarm(scope);
      codexConnectionManager.closeThread(scope);
      managed = codexConnectionManager.getOrCreate(scope, client, createResponsesWsOptions(headers, options.baseURL));
      options.onTransportMetrics?.({
        prewarmEnabled: true,
        prewarmResult: prewarmTimedOut ? 'timed-out' : 'disabled-after-failure',
        prewarmTimedOut,
        prewarmBudgetMs: WEBSOCKET_PREWARM_BUDGET_MS,
        prewarmLatencyMs: Date.now() - prewarmStartedAt,
        retryReason: error instanceof Error ? error.name : 'unknown'
      });
    } finally {
      clearTimeout(prewarmBudget);
      abortController.signal.removeEventListener('abort', abortPrewarm);
    }
  }

  let visibleActivity = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await managed.session.stream({
        request,
        builderOptions,
        identity,
        allowToolOutputContinuation: options.allowToolOutputContinuation === true,
        signal: abortController.signal,
        onRequestPrepared: (prepared) => reportManagedWebSocketRequestMetrics(options, prepared),
        onHandshake: (handshake, connectedAt) => {
          options.onWebSocketHandshake?.(handshake);
          options.onTransportMetrics?.({ websocketConnectedAt: connectedAt });
        },
        onEvent: (event) => {
          if (event.type === 'response.output_text.delta'
            || event.type === 'response.reasoning_text.delta'
            || (event as unknown as { type?: string }).type === 'response.reasoning_summary_text.delta'
            || event.type === 'response.function_call_arguments.done'
            || (event.type === 'response.output_item.done' && event.item.type === 'function_call')) {
            visibleActivity = true;
          }
          handleEvent(event);
        }
      });
      if (result.handshake?.serverModel && result.handshake.serverModel !== options.model) {
        codexConnectionManager.closeThread(scope);
        throw new WebSocketTransportUnavailableError(
          `Responses WebSocket resolved server model ${result.handshake.serverModel} while requesting ${options.model}.`
        );
      }
      reportManagedWebSocketResult(options, result, 'response');
      return;
    } catch (error) {
      codexConnectionManager.closeThread(scope);
      const classified = classifyManagedWebSocketError(error, options);
      if (attempt === 0 && !visibleActivity && options.authManager && isUnauthorizedError(error)) {
        const currentSnapshot = await options.authManager.getCredentialSnapshot(options.accountKey);
        const snapshot = await options.authManager.recoverFromUnauthorized({
          accountKey: options.accountKey ?? currentSnapshot.accountKey ?? '',
          snapshotRevision: currentSnapshot.revision,
          visibleActivity: false,
          reason: 'websocketUnauthorized'
        });
        options.apiKey = snapshot.accessToken;
        options.headers = {
          ...options.headers,
          ...(snapshot.accountId ? { 'ChatGPT-Account-ID': snapshot.accountId } : {})
        };
        managed = codexConnectionManager.getOrCreate(scope, createOpenAIClient(options), createResponsesWsOptions(buildDynamicHeaders(options, 'websocket'), options.baseURL));
        options.onTransportMetrics?.({ retryReason: 'websocket_unauthorized_recovered' });
        continue;
      }
      if (attempt === 0 && !visibleActivity && /connection limit/i.test(classified.message)) {
        managed = codexConnectionManager.getOrCreate(scope, client, createResponsesWsOptions(headers, options.baseURL));
        options.onTransportMetrics?.({ retryReason: 'websocket_connection_limit_reached' });
        continue;
      }
      if (visibleActivity && classified instanceof WebSocketTransportUnavailableError) {
        throw new WebSocketTransportUnavailableError(classified.message, {
          cause: classified,
          fallbackAllowed: false
        });
      }
      throw classified;
    }
  }
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof AuthenticationError
    || error instanceof APIError && error.status === 401
    || collectErrorMessages(error).some((message) => /\b401\b|unauthori[sz]ed|invalid api key/i.test(message));
}

function reportManagedWebSocketRequestMetrics(
  options: StreamResponseTextOptions,
  prepared: {
    requestBytes: number;
    websocketSerializeMs: number;
    previousResponseIdUsed?: string;
    incrementalInputCount: number;
  }
): void {
  options.onTransportMetrics?.({
    requestBodyBytes: prepared.requestBytes,
    websocketSerializeMs: prepared.websocketSerializeMs,
    previousResponseIdUsed: Boolean(prepared.previousResponseIdUsed),
    incrementalInputCount: prepared.incrementalInputCount
  });
}

function reportManagedWebSocketResult(
  options: StreamResponseTextOptions,
  result: Awaited<ReturnType<import('./codexWebSocketSession').CodexWebSocketSession['stream']>>,
  kind: 'prewarm' | 'response',
  latencyMs?: number
): void {
  if (result.turnState) {
    options.onTurnState?.(result.turnState);
  }
  options.onTransportMetrics?.({
    transportActual: 'websocket',
    connectionReused: result.connectionReused,
    previousResponseIdUsed: Boolean(result.previousResponseIdUsed),
    incrementalInputCount: result.incrementalInputCount,
    requestBodyBytes: result.requestBytes,
    turnStateReceived: Boolean(result.turnState ?? result.handshake?.turnState),
    serverModel: result.handshake?.serverModel,
    modelsEtagPresent: Boolean(result.handshake?.modelsEtag),
    ...(kind === 'prewarm'
      ? { prewarmEnabled: true, prewarmResult: 'success', prewarmLatencyMs: latencyMs, prewarmCompletedAt: Date.now() }
      : {})
  });
}

function classifyManagedWebSocketError(error: unknown, options: StreamResponseTextOptions): Error {
  if (options.previousResponseId && isResponsesContinuationMissPayload(error)) {
    return new ResponsesContinuationMissError(CONTINUATION_MISS_MESSAGE, options.previousResponseId, {
      cause: error instanceof Error ? error : undefined
    });
  }

  const messages = collectErrorMessages(error);
  if (messages.some((message) => /connection limit|websocket_connection_limit_reached/i.test(message))) {
    return new WebSocketTransportUnavailableError('Responses WebSocket connection limit reached.', {
      cause: error instanceof Error ? error : undefined
    });
  }
  if (error instanceof Error) {
    const causeCode = (error as Error & { cause?: { code?: unknown } }).cause?.code;
    if (/websocket/i.test(error.name)
      || typeof causeCode === 'string'
      || /websocket|socket|connection|handshake|closed|terminal event|before the response completed|getaddrinfo/i.test(error.message)) {
      return new WebSocketTransportUnavailableError(error.message, { cause: error });
    }
    return error;
  }
  return new Error(String(error));
}

function createReusableWebSocketSession(options: Pick<StreamResponseTextOptions, 'apiKey' | 'baseURL' | 'headers'>): ReusableResponsesWebSocketSession {
  const client = createOpenAIClient(options);
  const socketOptions = createResponsesWsOptions(options.headers, options.baseURL);

  return {
    socket: new ResponsesWS(client, socketOptions),
    inUse: true,
    updatedAt: Date.now()
  };
}

function takeReusableWebSocketSession(options: Pick<StreamResponseTextOptions, 'previousResponseId'>): ReusableResponsesWebSocketSession | undefined {
  if (!options.previousResponseId) {
    return undefined;
  }

  const session = reusableWebSocketSessions.get(options.previousResponseId);
  if (!session) {
    return undefined;
  }

  reusableWebSocketSessions.delete(options.previousResponseId);
  session.key = undefined;

  if (session.inUse || !isReusableWebSocketSessionOpen(session)) {
    closeReusableWebSocketSession(session);
    return undefined;
  }

  session.inUse = true;
  session.updatedAt = Date.now();
  return session;
}

function releaseReusableWebSocketSession(
  session: ReusableResponsesWebSocketSession,
  responseId: string | undefined,
  keepAlive: boolean
): void {
  if (!keepAlive || !responseId || !isReusableWebSocketSessionOpen(session)) {
    closeReusableWebSocketSession(session);
    return;
  }

  if (session.key) {
    reusableWebSocketSessions.delete(session.key);
  }

  session.inUse = false;
  session.key = responseId;
  session.updatedAt = Date.now();
  reusableWebSocketSessions.set(responseId, session);
  evictReusableWebSocketSessions();
}

function closeReusableWebSocketSession(session: ReusableResponsesWebSocketSession): void {
  if (session.key) {
    reusableWebSocketSessions.delete(session.key);
    session.key = undefined;
  }

  session.inUse = false;
  session.updatedAt = Date.now();

  if (session.socket.socket.readyState === WEBSOCKET_CLOSED || session.socket.socket.readyState === WEBSOCKET_CLOSING) {
    return;
  }

  try {
    session.socket.close({ code: 1000, reason: 'OK' });
  } catch {
    // Best effort close for session disposal.
  }
}

function isReusableWebSocketSessionOpen(session: ReusableResponsesWebSocketSession): boolean {
  return session.socket.socket.readyState === WEBSOCKET_OPEN;
}

function evictReusableWebSocketSessions(): void {
  const now = Date.now();

  for (const [key, session] of reusableWebSocketSessions.entries()) {
    if (session.inUse) {
      continue;
    }

    if (now - session.updatedAt > REUSABLE_WEBSOCKET_TTL_MS || !isReusableWebSocketSessionOpen(session)) {
      reusableWebSocketSessions.delete(key);
      closeReusableWebSocketSession(session);
    }
  }

  if (reusableWebSocketSessions.size <= MAX_REUSABLE_WEBSOCKETS) {
    return;
  }

  const sessionsByAge = [...reusableWebSocketSessions.entries()]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt);

  while (reusableWebSocketSessions.size > MAX_REUSABLE_WEBSOCKETS && sessionsByAge.length > 0) {
    const oldest = sessionsByAge.shift();
    if (!oldest) {
      break;
    }

    reusableWebSocketSessions.delete(oldest[0]);
    closeReusableWebSocketSession(oldest[1]);
  }
}

function createOpenAIClient(
  options: Pick<StreamResponseTextOptions, 'apiKey' | 'baseURL' | 'headers' | 'authManager' | 'accountKey' | 'compatibilityProfile' | 'requestCompression' | 'onTransportMetrics'>,
  defaultHeaders?: Record<string, string>
): OpenAI {
  const compressedFetch = createCodexFetchAdapter({
    endpointKey: options.compatibilityProfile?.endpointKey ?? normalizeBaseURL(options.baseURL),
    compatibilityEnabled: options.compatibilityProfile?.enabled ?? false,
    compression: options.requestCompression ?? 'disabled',
    performFetch: proxyAwareFetch,
    onObservation: (observation) => options.onTransportMetrics?.({
      requestBodyBytes: observation.requestBytes,
      compressedBodyBytes: observation.compressedBytes,
      compressionAttempted: observation.compressionAttempted,
      compressionUsed: observation.compressionUsed,
      networkDurationMs: observation.durationMs,
      responseStatus: observation.responseStatus
    })
  });
  const customFetch: typeof fetch = options.authManager
    ? (input, init) => codexFetch(options.authManager!, input, init, compressedFetch, options.accountKey)
    : compressedFetch;
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: normalizeBaseURL(options.baseURL),
    ...(defaultHeaders ? { defaultHeaders } : {}),
    fetch: customFetch,
    maxRetries: OPENAI_DEFAULT_MAX_RETRIES,
    timeout: OPENAI_DEFAULT_TIMEOUT_MS
  });
}

function buildResponsesCreateRequest(options: StreamResponseTextOptions) {
  return buildCodexResponsesRequestWithMetrics(createRequestBuilderOptions(options));
}

function buildResponsesCreateEvent(options: StreamResponseTextOptions): ResponsesClientEvent {
  const { request: builtRequest, metrics } = buildResponsesCreateRequest(options);
  options.onTransportMetrics?.({ ...metrics });
  const { stream: _stream, client_metadata: _metadata, ...request } = builtRequest;
  return { type: 'response.create', ...request } as ResponsesClientEvent;
}

function createRequestBuilderOptions(options: StreamResponseTextOptions): CodexRequestBuilderOptions {
  return {
    compatibilityEnabled: options.compatibilityProfile?.enabled ?? false,
    identity: options.identity,
    model: options.model,
    instructions: options.instructions,
    input: options.input,
    tools: options.tools,
    toolPlan: options.toolPlan,
    hostedTools: options.hostedTools,
    toolMode: options.toolMode,
    reasoning: options.reasoning,
    serviceTier: options.serviceTier,
    previousResponseId: options.previousResponseId,
    store: options.store,
    omitMaxOutputTokens: options.omitMaxOutputTokens,
    maxOutputTokens: options.maxOutputTokens,
    textVerbosity: 'medium',
    includeEncryptedReasoning: true,
    protocolSettings: options.protocolSettings,
    turnStartedAtUnixMs: options.turnStartedAtUnixMs
  };
}

function buildDynamicHeaders(options: StreamResponseTextOptions, transport: 'http' | 'websocket'): Record<string, string> {
  if (!options.compatibilityProfile?.enabled || !options.identity) {
    return { ...options.headers };
  }
  const snapshot = buildCodexProtocolSnapshot({
    identity: options.identity,
    turnStartedAtUnixMs: options.turnStartedAtUnixMs,
    toolPlan: options.toolPlan,
    settings: options.protocolSettings
  });
  const metadata = snapshot.compatibilityTurnMetadata;
  return buildCodexRequestHeaders({
    credentialsHeaders: options.headers,
    identity: options.identity,
    turnMetadata: metadata,
    snapshot,
    turnState: options.turnState,
    extensionVersion: options.extensionVersion ?? '0.0.0',
    userAgent: options.userAgent ?? `codex-for-copilot/${options.extensionVersion ?? '0.0.0'}`
  }, transport);
}

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function createResponsesWsOptions(headers?: Record<string, string>, baseURL?: string): ResponsesWSClientOptions {
  const proxy = baseURL ? resolveProxyForURL(baseURL) : undefined;
  return {
    ...(headers ? { headers } : {}),
    ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {})
  } as unknown as ResponsesWSClientOptions;
}

export { shouldBypassProxy } from './proxy';

function getManagedConnectionScope(options: StreamResponseTextOptions): CodexConnectionScope | undefined {
  if (!options.compatibilityProfile?.enabled || !options.identity || !options.authIdentity) {
    return undefined;
  }
  return {
    baseURL: normalizeBaseURL(options.baseURL),
    authIdentity: options.authIdentity,
    accountId: getHeader(options.headers, 'chatgpt-account-id'),
    compatibilityProfile: options.compatibilityProfile.endpointKey,
    sessionId: options.identity.sessionId,
    threadId: options.identity.threadId
  };
}

function getManagedPreconnectionScope(
  options: PreconnectCodexResponsesWebSocketOptions
): CodexConnectionScopeBase | undefined {
  if (!options.compatibilityProfile.enabled || !options.authIdentity) {
    return undefined;
  }
  return {
    baseURL: normalizeBaseURL(options.baseURL),
    authIdentity: options.authIdentity,
    accountId: getHeader(options.headers, 'chatgpt-account-id'),
    compatibilityProfile: options.compatibilityProfile.endpointKey
  };
}

export function createResponsesServerEventHandler(
  options: StreamResponseTextOptions
): (event: ResponsesServerEvent) => void {
  const functionCallsByItemId = new Map<string, { callId: string; name: string; namespace?: string }>();
  const reportedFunctionCallItemIds = new Set<string>();
  const summaryPresentationIdsByPart = new Map<string, string>();
  const startedReasoningPresentationIds = new Set<string>();
  let nextSummaryPresentationId = 0;

  const reportFunctionCall = (
    itemId: string,
    callId: string,
    name: string,
    argumentsJson: string,
    namespace?: string
  ) => {
    const normalizedCallId = callId.trim();
    const normalizedName = name.trim();
    if (!normalizedCallId || !normalizedName || reportedFunctionCallItemIds.has(itemId)) {
      return;
    }

    reportedFunctionCallItemIds.add(itemId);
    options.onToolCall?.({
      itemId,
      callId: normalizedCallId,
      name: normalizedName,
      ...(namespace ? { namespace } : {}),
      input: parseToolCallInput(argumentsJson)
    });
  };

  return (event) => {
    const hostedToolEvent = projectHostedToolLifecycleEvent(event);
    if (hostedToolEvent) {
      options.onHostedToolLifecycleEvent?.(hostedToolEvent);
      return;
    }

    const reasoningEvent = event as unknown as Record<string, unknown>;
    if (reasoningEvent.type === 'response.reasoning_summary_part.added') {
      const itemId = typeof reasoningEvent.item_id === 'string' ? reasoningEvent.item_id : '';
      const outputIndex = typeof reasoningEvent.output_index === 'number' ? reasoningEvent.output_index : 0;
      const summaryIndex = typeof reasoningEvent.summary_index === 'number' ? reasoningEvent.summary_index : 0;
      if (itemId) {
        const sequenceNumber = typeof reasoningEvent.sequence_number === 'number'
          ? reasoningEvent.sequence_number
          : ++nextSummaryPresentationId;
        const partKey = getSummaryPartKey(itemId, outputIndex, summaryIndex);
        const presentationId = `summary-part:${sequenceNumber}`;
        summaryPresentationIdsByPart.set(
          partKey,
          presentationId
        );
        options.onReasoningLifecycleEvent?.({
          phase: 'part-added',
          source: 'summary',
          itemId,
          partIndex: summaryIndex,
          outputIndex,
          presentationId,
          sequenceNumber
        });
      }
      return;
    }

    if (reasoningEvent.type === 'response.reasoning_summary_text.done'
      || reasoningEvent.type === 'response.reasoning_text.done') {
      const source: ReasoningStreamSource = reasoningEvent.type === 'response.reasoning_summary_text.done'
        ? 'summary'
        : 'reasoning-text';
      const itemId = typeof reasoningEvent.item_id === 'string' ? reasoningEvent.item_id : '';
      const outputIndex = typeof reasoningEvent.output_index === 'number' ? reasoningEvent.output_index : 0;
      const index = source === 'summary' ? reasoningEvent.summary_index : reasoningEvent.content_index;
      const partIndex = typeof index === 'number' ? index : 0;
      const partKey = getSummaryPartKey(itemId, outputIndex, partIndex);
      const presentationId = source === 'summary' ? summaryPresentationIdsByPart.get(partKey) : undefined;
      const text = typeof reasoningEvent.text === 'string' ? reasoningEvent.text : '';
      if (itemId) {
        options.onReasoningLifecycleEvent?.({
          phase: 'text-completed',
          source,
          itemId,
          partIndex,
          outputIndex,
          presentationId,
          textLength: text.length
        });
      }
      if (source === 'summary') {
        summaryPresentationIdsByPart.delete(partKey);
      }
      return;
    }

    if (reasoningEvent.type === 'response.reasoning_summary_part.done') {
      const itemId = typeof reasoningEvent.item_id === 'string' ? reasoningEvent.item_id : '';
      const outputIndex = typeof reasoningEvent.output_index === 'number' ? reasoningEvent.output_index : 0;
      const summaryIndex = typeof reasoningEvent.summary_index === 'number' ? reasoningEvent.summary_index : 0;
      const partKey = getSummaryPartKey(itemId, outputIndex, summaryIndex);
      const presentationId = summaryPresentationIdsByPart.get(partKey);
      if (itemId) {
        options.onReasoningLifecycleEvent?.({
          phase: 'part-completed',
          source: 'summary',
          itemId,
          partIndex: summaryIndex,
          outputIndex,
          presentationId,
          sequenceNumber: typeof reasoningEvent.sequence_number === 'number'
            ? reasoningEvent.sequence_number
            : undefined
        });
      }
      summaryPresentationIdsByPart.delete(partKey);
      return;
    }

    if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
      const item = event.item as typeof event.item & { namespace?: string };
      if (event.item.id) {
        functionCallsByItemId.set(event.item.id, {
          callId: event.item.call_id,
          name: event.item.name,
          namespace: item.namespace
        });
        options.onToolCallAdded?.(event.item.call_id, event.item.name);
      }
      return;
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const functionCall = functionCallsByItemId.get(event.item_id);
      if (functionCall) {
        options.onToolCallArgumentsDelta?.(functionCall.callId, functionCall.name);
      }
      return;
    }

    if (event.type === 'response.function_call_arguments.done') {
      const functionCall = functionCallsByItemId.get(event.item_id);
      if (functionCall) {
        options.onToolCallArgumentsDone?.(
          functionCall.callId,
          firstNonEmptyString(functionCall.name, event.name)
        );
        reportFunctionCall(
          event.item_id,
          functionCall.callId,
          firstNonEmptyString(functionCall.name, event.name),
          event.arguments,
          functionCall.namespace
        );
      }
      return;
    }

    handleResponsesServerEvent(
      event,
      options,
      reportFunctionCall,
      (itemId, outputIndex, summaryIndex) => {
        const partKey = getSummaryPartKey(itemId, outputIndex, summaryIndex);
        const existingPresentationId = summaryPresentationIdsByPart.get(partKey);
        if (existingPresentationId) {
          return existingPresentationId;
        }

        const presentationId = `summary-fallback:${++nextSummaryPresentationId}`;
        summaryPresentationIdsByPart.set(partKey, presentationId);
        return presentationId;
      },
      (lifecycleEvent) => {
        const presentationKey = `${lifecycleEvent.source}:${lifecycleEvent.itemId}:${lifecycleEvent.outputIndex}:${lifecycleEvent.presentationId ?? lifecycleEvent.partIndex}`;
        if (startedReasoningPresentationIds.has(presentationKey)) {
          return;
        }
        startedReasoningPresentationIds.add(presentationKey);
        options.onReasoningLifecycleEvent?.(lifecycleEvent);
      }
    );
  };
}

function getSummaryPartKey(itemId: string, outputIndex: number, summaryIndex: number): string {
  return `${itemId}:${outputIndex}:${summaryIndex}`;
}

function firstNonEmptyString(...values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? '';
}

function handleResponsesServerEvent(
  event: ResponsesServerEvent,
  options: StreamResponseTextOptions,
  reportFunctionCall: (itemId: string, callId: string, name: string, argumentsJson: string, namespace?: string) => void,
  getSummaryPresentationId?: (itemId: string, outputIndex: number, summaryIndex: number) => string | undefined,
  reportReasoningTextStarted?: (event: ReasoningStreamLifecycleEvent) => void
): void {
  if (event.type === 'response.output_item.done') {
    options.onRawResponseItem?.(event.item);
    const webSearchSources = extractWebSearchSources(event.item);
    if (webSearchSources.length > 0) {
      options.onWebSearchSources?.(webSearchSources);
    }
  }

  if (event.type === 'response.output_text.delta') {
    options.onTextDelta(event.delta);
    return;
  }

  const reasoningEvent = event as unknown as Record<string, unknown>;
  if (reasoningEvent.type === 'response.reasoning_summary_text.delta'
    || reasoningEvent.type === 'response.reasoning_text.delta') {
    const source: ReasoningStreamSource = reasoningEvent.type === 'response.reasoning_summary_text.delta'
      ? 'summary'
      : 'reasoning-text';
    const text = typeof reasoningEvent.delta === 'string' ? reasoningEvent.delta : '';
    const itemId = typeof reasoningEvent.item_id === 'string' ? reasoningEvent.item_id : '';
    const index = source === 'summary' ? reasoningEvent.summary_index : reasoningEvent.content_index;
    const outputIndex = typeof reasoningEvent.output_index === 'number' ? reasoningEvent.output_index : 0;
    const partIndex = typeof index === 'number' ? index : 0;
    if (text && itemId) {
      const presentationId = source === 'summary'
        ? getSummaryPresentationId?.(itemId, outputIndex, partIndex)
        : undefined;
      options.onReasoningDelta?.({
        source,
        text,
        itemId,
        partIndex,
        outputIndex,
        presentationId
      });
      reportReasoningTextStarted?.({
        phase: 'text-started',
        source,
        itemId,
        partIndex,
        outputIndex,
        presentationId,
        textLength: text.length
      });
    }
    return;
  }

  if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
    const item = event.item as typeof event.item & { namespace?: string };
    reportFunctionCall(event.item.id ?? event.item.call_id, event.item.call_id, event.item.name, event.item.arguments, item.namespace);
    return;
  }

  if (event.type === 'response.created') {
    options.onResponseCreated?.(event.response);
    return;
  }

  if (event.type === 'response.completed') {
    options.onResponseCompleted?.(event.response);
    return;
  }

  if (event.type === 'response.incomplete') {
    const reason = event.response.incomplete_details?.reason;
    const message = reason
      ? `Responses API response incomplete (${reason}).`
      : 'Responses API response incomplete.';
    options.onResponseFailed?.(message);
    throw new Error(message);
  }

  if (event.type === 'error') {
    const message = collectErrorMessages(event).find((value) => value.trim())
      ?? 'Responses API stream error.';
    options.onResponseFailed?.(message);
    throw new Error(message);
  }

  if (event.type === 'response.failed') {
    const error = event.response.error;

    const mismatchedModel = getMismatchedModelNotFoundName(error?.message, options.model);
    if (mismatchedModel && options.transport !== 'http') {
      throw new WebSocketTransportUnavailableError(
        `Responses WebSocket resolved stale model ${mismatchedModel} while requesting ${options.model}.`
      );
    }

    if (options.previousResponseId && isResponsesContinuationMissPayload(error)) {
      throw new ResponsesContinuationMissError(
        CONTINUATION_MISS_MESSAGE,
        options.previousResponseId
      );
    }

    if (error?.code === 'rate_limit_exceeded') {
      throw new ResponsesStreamRateLimitError(
        error.message ?? 'Responses API rate limit exceeded.',
        parseRetryDelayMs(error.message)
      );
    }

    options.onResponseFailed?.(error?.message ?? 'Responses API request failed.');
    throw new Error(error?.message ?? 'Responses API request failed.');
  }
}

function shouldFallbackToHttp(
  error: unknown,
  token: vscode.CancellationToken,
  abortSignal: AbortSignal
): boolean {
  if (token.isCancellationRequested || abortSignal.aborted) {
    return false;
  }

  return error instanceof WebSocketTransportUnavailableError && error.fallbackAllowed;
}

function getMismatchedModelNotFoundName(error: unknown, requestedModel: string): string | undefined {
  const missingModel = getModelNotFoundName(error);
  if (!missingModel || missingModel === requestedModel) {
    return undefined;
  }

  return missingModel;
}

function getModelNotFoundName(error: unknown): string | undefined {
  const candidates = collectErrorMessages(error);

  for (const message of candidates) {
    const match = /Model not found\s+([^"\s}]+)/i.exec(message);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  walkErrorEnvelope(error, (value) => {
    if (typeof value === 'string') {
      messages.push(value);
    }
    return true;
  });
  return messages;
}

function walkErrorEnvelope(error: unknown, visit: (value: unknown) => boolean): void {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seenObjects = new WeakSet<object>();
  let queueIndex = 0;
  let visitedNodes = 0;

  while (queueIndex < queue.length && visitedNodes < MAX_ERROR_TRAVERSAL_NODES) {
    const current = queue[queueIndex];
    queueIndex += 1;
    visitedNodes += 1;

    if (typeof current.value === 'object' && current.value !== null) {
      if (seenObjects.has(current.value)) {
        continue;
      }
      seenObjects.add(current.value);
    }

    if (!visit(current.value)) {
      return;
    }
    if (current.depth >= MAX_ERROR_TRAVERSAL_DEPTH) {
      continue;
    }

    if (typeof current.value === 'string') {
      const parsed = parseBoundedErrorJson(current.value);
      if (parsed !== undefined) {
        queue.push({ value: parsed, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== 'object' || current.value === null) {
      continue;
    }

    for (const property of ['error', 'cause', 'message'] as const) {
      const nested = readOwnErrorProperty(current.value, property);
      if (nested !== undefined && nested !== null && nested !== UNREADABLE_ERROR_PROPERTY) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
}

function parseBoundedErrorJson(message: string): unknown | undefined {
  if (message.length === 0 || message.length > MAX_ERROR_JSON_LENGTH) {
    return undefined;
  }

  const trimmed = message.trim();
  const looksLikeObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const looksLikeArray = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!looksLikeObject && !looksLikeArray) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function readOwnErrorProperty(value: object, property: string): unknown | typeof UNREADABLE_ERROR_PROPERTY {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor) {
      return undefined;
    }
    return 'value' in descriptor ? descriptor.value : UNREADABLE_ERROR_PROPERTY;
  } catch {
    return UNREADABLE_ERROR_PROPERTY;
  }
}

interface WebSocketTransportUnavailableErrorOptions extends ErrorOptions {
  fallbackAllowed?: boolean;
}

class WebSocketTransportUnavailableError extends Error {
  readonly fallbackAllowed: boolean;

  constructor(message: string, options?: WebSocketTransportUnavailableErrorOptions) {
    super(message, options);
    this.name = 'WebSocketTransportUnavailableError';
    this.fallbackAllowed = options?.fallbackAllowed ?? true;
  }
}

class ResponsesContinuationMissError extends Error {
  constructor(
    message: string,
    readonly previousResponseId: string,
    options?: ErrorOptions,
    readonly disableReuseUntilExpiry = false
  ) {
    super(message, options);
    this.name = 'ResponsesContinuationMissError';
  }
}

class ResponsesStreamRateLimitError extends Error {
  constructor(message: string, readonly retryDelayMs?: number) {
    super(message);
    this.name = 'ResponsesStreamRateLimitError';
  }
}

function parseRetryDelayMs(message: string | null | undefined): number | undefined {
  const match = message?.match(/\btry again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return /^(?:ms|millisecond)/i.test(match[2]) ? value : value * 1_000;
}

async function waitForRetryDelay(delayMs: number | undefined, signal: AbortSignal): Promise<void> {
  if (!delayMs || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

export async function countInputTokens(options: CountInputTokensOptions): Promise<number> {
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    body: JSON.stringify({
      model: options.model,
      input: options.input
    }),
    signal: toAbortSignal(options.token)
  };
  const response = options.authManager
    ? await codexFetch(options.authManager, `${normalizeBaseURL(options.baseURL)}/responses/input_tokens`, init, proxyAwareFetch, options.accountKey)
    : await proxyAwareFetch(`${normalizeBaseURL(options.baseURL)}/responses/input_tokens`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${options.apiKey}`
        }
      });

  if (!response.ok) {
    const body = await safeReadResponseBody(response);
    throw new Error(`Responses input token count failed with ${response.status} ${response.statusText}.${body ? ` ${body}` : ''}`);
  }

  const payload = (await response.json()) as { input_tokens?: unknown };
  if (typeof payload.input_tokens !== 'number' || !Number.isFinite(payload.input_tokens) || payload.input_tokens < 0) {
    throw new Error('Responses input token count returned an invalid input_tokens value.');
  }

  return Math.floor(payload.input_tokens);
}

function parseToolCallInput(argumentsJson: string): object {
  if (!argumentsJson.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsJson);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }

    return { value: parsed };
  } catch {
    return { _raw: argumentsJson };
  }
}

function isOpaqueHttpContinuationRejection(error: unknown): boolean {
  return error instanceof APIError
    && error.status === 400
    && /\b400 status code \(no body\)/i.test(error.message);
}

function isFunctionCallContinuationIntegrityError(error: unknown): boolean {
  return collectErrorMessages(error)
    .some((message) => /no tool call found for function call output with call_id|no tool output found for function call\b/i.test(message));
}

function normalizeResponsesError(error: unknown, baseURL: string): Error {
  const endpoint = `${normalizeBaseURL(baseURL)}/responses`;

  if (error instanceof ResponsesStreamRateLimitError) {
    return new Error(
      `OpenAI rate limit exceeded while contacting ${endpoint}. ${error.message}`,
      { cause: error }
    );
  }

  if (error instanceof APIConnectionTimeoutError) {
    return new Error(
      `OpenAI request timed out while contacting ${endpoint}. The OpenAI SDK automatically retried transient timeouts, but the request still did not complete. Check network, proxy, or VPN stability and try again.`,
      { cause: error }
    );
  }

  if (error instanceof APIConnectionError) {
    const causeMessage = getDeepestCauseSummary(error);
    return new Error(
      `Connection failure while contacting ${endpoint}. The OpenAI SDK automatically retried transient connection errors, but the request still failed.${causeMessage ? ` Root cause: ${causeMessage}` : ''}`,
      { cause: error }
    );
  }

  if (error instanceof AuthenticationError) {
    return new Error(
      `Responses API authentication failed. Check the stored API key or ~/.codex/auth.json credentials.${formatRequestId(error)} ${error.message}`.trim(),
      { cause: error }
    );
  }

  if (error instanceof RateLimitError) {
    return new Error(
      `OpenAI rate limit exceeded while contacting ${endpoint}.${formatRequestId(error)} ${error.message}`.trim(),
      { cause: error }
    );
  }

  if (error instanceof InternalServerError) {
    return new Error(
      `OpenAI server error while contacting ${endpoint}.${formatStatusAndRequestId(error)} ${error.message}`.trim(),
      { cause: error }
    );
  }

  if (error instanceof APIError) {
    return new Error(
      `OpenAI request failed while contacting ${endpoint}.${formatStatusAndRequestId(error)} ${error.message}`.trim(),
      { cause: error }
    );
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
    return new Error(
      `Connection failure while contacting ${endpoint}. Check codexModelProvider.baseURL and local network reachability. ${message}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }

  if (message.includes('401') || /unauthorized|invalid api key/i.test(message)) {
    return new Error(
      `Responses API authentication failed. Check the stored API key or ~/.codex/auth.json credentials. ${message}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }

  return error instanceof Error ? error : new Error(message);
}

function formatRequestId(error: Pick<APIError, 'requestID'>): string {
  return error.requestID ? ` Request ID: ${error.requestID}.` : '';
}

function formatStatusAndRequestId(error: Pick<APIError, 'status' | 'requestID'>): string {
  const status = error.status ? ` Status: ${error.status}.` : '';
  const requestId = formatRequestId(error);
  return `${status}${requestId}`;
}

function getDeepestCauseSummary(error: Error & { cause?: unknown }): string | undefined {
  let cause = readOwnErrorProperty(error, 'cause');
  const seen = new WeakSet<object>();
  let summary: string | undefined;

  for (let depth = 0; depth < MAX_ERROR_TRAVERSAL_DEPTH; depth += 1) {
    if (cause === undefined || cause === null || cause === UNREADABLE_ERROR_PROPERTY) {
      break;
    }

    if (typeof cause === 'string') {
      summary = cause.trim() || summary;
      break;
    }

    if (typeof cause !== 'object') {
      break;
    }

    if (seen.has(cause)) {
      break;
    }
    seen.add(cause);

    const message = readOwnErrorProperty(cause, 'message');
    const code = readOwnErrorProperty(cause, 'code');
    const messageText = typeof message === 'string' ? message.trim() : '';
    const codeText = typeof code === 'string' || typeof code === 'number' ? String(code).trim() : '';
    if (messageText) {
      summary = codeText && !messageText.toLowerCase().includes(codeText.toLowerCase())
        ? `${messageText} (${codeText})`
        : messageText;
    } else if (codeText) {
      summary = codeText;
    }

    cause = readOwnErrorProperty(cause, 'cause');
  }

  return summary;
}

async function safeReadResponseBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.trim();
  } catch {
    return '';
  }
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal | undefined {
  if (token.isCancellationRequested) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+(responses|chat\/completions|completions)\/?$/i, '').replace(/\/+$/, '');
}
