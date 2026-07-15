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
  FunctionTool,
  ResponsesServerEvent,
  ResponseUsage,
  ToolChoiceOptions
} from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
import * as vscode from 'vscode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ResponsesInputMessage } from './convertMessages';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { codexFetch } from './auth/codexAuthRequest';
import {
  buildCodexRequestHeaders,
  createCodexTurnMetadata,
  stableSerializeCodexMetadata,
  type CodexCompatibilityProfile,
  type CodexRequestIdentity
} from './codexProtocol';
import {
  buildCodexResponsesRequest,
  type CodexRequestBuilderOptions
} from './codexRequestBuilder';
import { createCodexFetchAdapter, type RequestCompressionPolicy } from './codexFetchAdapter';
import { codexConnectionManager, type CodexConnectionScope } from './codexConnectionManager';
import type { CodexWebSocketHandshake } from './codexWebSocketSession';

const OPENAI_DEFAULT_MAX_RETRIES = 2;
const OPENAI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REUSABLE_WEBSOCKET_TTL_MS = 10 * 60 * 1000;
const MAX_REUSABLE_WEBSOCKETS = 32;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

interface ReusableResponsesWebSocketSession {
  socket: ResponsesWS;
  key?: string;
  inUse: boolean;
  updatedAt: number;
}

const reusableWebSocketSessions = new Map<string, ReusableResponsesWebSocketSession>();

export interface CountInputTokensOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  authManager?: CodexAuthManager;
  model: string;
  input: string | ResponsesInputMessage[];
  token: vscode.CancellationToken;
}

export interface StreamResponseTextOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  transport?: 'auto' | 'http' | 'websocket';
  compatibilityProfile?: CodexCompatibilityProfile;
  identity?: CodexRequestIdentity;
  turnState?: string;
  authIdentity?: string;
  extensionVersion?: string;
  userAgent?: string;
  websocketPrewarm?: 'auto' | 'enabled' | 'disabled';
  requestCompression?: RequestCompressionPolicy;
  previousResponseId?: string;
  store?: boolean;
  omitMaxOutputTokens?: boolean;
  model: string;
  instructions: string;
  serviceTier?: 'default' | 'priority';
  input: ResponsesInputMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
  toolMode?: vscode.LanguageModelChatToolMode;
  reasoning?: Reasoning;
  maxOutputTokens: number;
  token: vscode.CancellationToken;
  onTextDelta: (text: string) => void;
  onReasoningTextDelta?: (text: string) => void;
  onToolCall?: (callId: string, name: string, input: object) => void;
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
  onTransportFallback?: (event: {
    from: 'websocket';
    to: 'http';
    reason: string;
  }) => void;
  onWebSocketSession?: (event: {
    reused: boolean;
  }) => void;
}

export function isResponsesContinuationMissError(error: unknown): error is ResponsesContinuationMissError {
  return error instanceof ResponsesContinuationMissError;
}

export function disposeReusableResponsesWebSockets(): void {
  codexConnectionManager.dispose();
  const sessions = new Set(reusableWebSocketSessions.values());
  reusableWebSocketSessions.clear();

  for (const session of sessions) {
    closeReusableWebSocketSession(session);
  }
}

export async function streamResponseText(options: StreamResponseTextOptions): Promise<void> {
  const abortController = new AbortController();
  const cancellation = options.token.onCancellationRequested(() => abortController.abort());

  try {
    if (!options.instructions.trim()) {
      throw new Error('Codex requires a non-empty top-level instructions setting.');
    }

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
  } catch (error) {
    if (options.token.isCancellationRequested || abortController.signal.aborted) {
      return;
    }

    if (options.previousResponseId) {
      if (error instanceof ResponsesContinuationMissError) {
        throw error;
      }

      if (isOpaqueHttpContinuationRejection(error)) {
        throw new ResponsesContinuationMissError(
          'Responses API rejected previous_response_id with an opaque HTTP 400 response.',
          options.previousResponseId,
          { cause: error instanceof Error ? error : undefined },
          true
        );
      }

      if (isMissingFunctionCallForToolOutputError(error)) {
        throw new ResponsesContinuationMissError(
          'Responses API rejected function_call_output because its previous_response_id lacks the matching function_call.',
          options.previousResponseId,
          { cause: error instanceof Error ? error : undefined }
        );
      }
    }

    throw normalizeResponsesError(error, options.baseURL);
  } finally {
    cancellation.dispose();
  }
}

async function streamResponseTextOverHttp(
  options: StreamResponseTextOptions,
  abortController: AbortController
): Promise<void> {
  const request = buildResponsesCreateRequest(options);
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
    requestIdPresent: Boolean(requestId),
    turnStateReceived: Boolean(turnState),
    serverModel: response.headers.get('openai-model') ?? undefined,
    modelsEtagPresent: Boolean(response.headers.get('x-models-etag'))
  });

  for await (const event of stream) {
    if (options.token.isCancellationRequested) {
      abortController.abort();
      return;
    }

    handleResponsesServerEvent(event, options);
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
        handleResponsesServerEvent(message, options);

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

        const responseError = getResponseErrorDetails(streamEvent.error);
        if (options.previousResponseId && isPreviousResponseNotFoundError(responseError.code, responseError.message)) {
          releaseReusableWebSocketSession(session, undefined, false);
          throw new ResponsesContinuationMissError(
            typeof responseError.message === 'string' ? responseError.message : streamEvent.error.message,
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
  const client = createOpenAIClient(options, headers);
  let managed = codexConnectionManager.getOrCreate(scope, client, createResponsesWsOptions(headers, options.baseURL));
  options.onWebSocketSession?.({ reused: managed.reused });
  const request = buildResponsesCreateRequest(options);
  const builderOptions = createRequestBuilderOptions(options);

  if (!managed.reused
    && options.websocketPrewarm !== 'disabled'
    && !codexConnectionManager.isPrewarmDisabled(scope)) {
    const prewarmStartedAt = Date.now();
    try {
      const prewarm = await managed.session.prewarm({
        request,
        builderOptions,
        identity,
        signal: abortController.signal,
        onEvent: () => undefined
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
        prewarmResult: 'disabled-after-failure',
        prewarmLatencyMs: Date.now() - prewarmStartedAt,
        retryReason: error instanceof Error ? error.name : 'unknown'
      });
    }
  }

  let visibleActivity = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await managed.session.stream({
        request,
        builderOptions,
        identity,
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === 'response.output_text.delta'
            || event.type === 'response.reasoning_text.delta'
            || event.type === 'response.output_item.done') {
            visibleActivity = true;
          }
          handleResponsesServerEvent(event, options);
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
      if (attempt === 0 && !visibleActivity && /connection limit/i.test(classified.message)) {
        managed = codexConnectionManager.getOrCreate(scope, client, createResponsesWsOptions(headers, options.baseURL));
        options.onTransportMetrics?.({ retryReason: 'websocket_connection_limit_reached' });
        continue;
      }
      throw classified;
    }
  }
}

function reportManagedWebSocketResult(
  options: StreamResponseTextOptions,
  result: Awaited<ReturnType<import('./codexWebSocketSession').CodexWebSocketSession['stream']>>,
  kind: 'prewarm' | 'response',
  latencyMs?: number
): void {
  if (result.handshake) {
    options.onWebSocketHandshake?.(result.handshake);
  }
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
      ? { prewarmEnabled: true, prewarmResult: 'success', prewarmLatencyMs: latencyMs }
      : {})
  });
}

function classifyManagedWebSocketError(error: unknown, options: StreamResponseTextOptions): Error {
  const messages = collectErrorMessages(error);
  if (options.previousResponseId && messages.some((message) => /previous_response_not_found/i.test(message))) {
    return new ResponsesContinuationMissError(messages[0] ?? 'previous_response_not_found', options.previousResponseId, {
      cause: error instanceof Error ? error : undefined
    });
  }
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
  options: Pick<StreamResponseTextOptions, 'apiKey' | 'baseURL' | 'headers' | 'compatibilityProfile' | 'requestCompression' | 'onTransportMetrics'>,
  defaultHeaders = options.headers
): OpenAI {
  const customFetch = createCodexFetchAdapter({
    endpointKey: options.compatibilityProfile?.endpointKey ?? normalizeBaseURL(options.baseURL),
    compatibilityEnabled: options.compatibilityProfile?.enabled ?? false,
    compression: options.requestCompression ?? 'disabled',
    onObservation: (observation) => options.onTransportMetrics?.({
      requestBodyBytes: observation.requestBytes,
      compressedBodyBytes: observation.compressedBytes,
      compressionAttempted: observation.compressionAttempted,
      compressionUsed: observation.compressionUsed,
      networkDurationMs: observation.durationMs,
      responseStatus: observation.responseStatus
    })
  });
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: normalizeBaseURL(options.baseURL),
    defaultHeaders,
    fetch: customFetch,
    maxRetries: OPENAI_DEFAULT_MAX_RETRIES,
    timeout: OPENAI_DEFAULT_TIMEOUT_MS
  });
}

function buildResponsesCreateRequest(options: StreamResponseTextOptions) {
  return buildCodexResponsesRequest(createRequestBuilderOptions(options));
}

function buildResponsesCreateEvent(options: StreamResponseTextOptions): ResponsesClientEvent {
  const { stream: _stream, client_metadata: _metadata, ...request } = buildResponsesCreateRequest(options);
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
    toolMode: options.toolMode,
    reasoning: options.reasoning,
    serviceTier: options.serviceTier,
    previousResponseId: options.previousResponseId,
    store: options.store,
    omitMaxOutputTokens: options.omitMaxOutputTokens,
    maxOutputTokens: options.maxOutputTokens,
    textVerbosity: 'medium',
    includeEncryptedReasoning: true
  };
}

function buildDynamicHeaders(options: StreamResponseTextOptions, transport: 'http' | 'websocket'): Record<string, string> {
  if (!options.compatibilityProfile?.enabled || !options.identity) {
    return { ...options.headers };
  }
  const metadata = stableSerializeCodexMetadata(createCodexTurnMetadata(options.identity));
  return buildCodexRequestHeaders({
    credentialsHeaders: options.headers,
    identity: options.identity,
    turnMetadata: metadata,
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
  const workspace = (vscode as typeof vscode & {
    workspace?: { getConfiguration?(section?: string): { get?<T>(key: string): T | undefined } };
  }).workspace;
  const configuredProxy = workspace?.getConfiguration?.('http').get?.<string>('proxy')?.trim();
  const candidateProxy = configuredProxy || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  const proxy = baseURL && shouldBypassProxy(baseURL) ? undefined : candidateProxy;
  return {
    ...(headers ? { headers } : {}),
    ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {})
  } as unknown as ResponsesWSClientOptions;
}

export function shouldBypassProxy(baseURL: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return false;
  }
  const noProxy = [environment.NO_PROXY, environment.no_proxy]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(',');
  if (!noProxy) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  }
  return noProxy.split(',').some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) {
      return false;
    }
    if (pattern === '*') {
      return true;
    }
    const hostname = pattern.replace(/^https?:\/\//, '').split(':')[0].replace(/^\./, '');
    return url.hostname.toLowerCase() === hostname || url.hostname.toLowerCase().endsWith(`.${hostname}`);
  });
}

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

function handleResponsesServerEvent(event: ResponsesServerEvent, options: StreamResponseTextOptions): void {
  if (event.type === 'response.output_item.done') {
    options.onRawResponseItem?.(event.item);
  }

  if (event.type === 'response.output_text.delta') {
    options.onTextDelta(event.delta);
    return;
  }

  if (event.type === 'response.reasoning_text.delta') {
    options.onReasoningTextDelta?.(event.delta);
    return;
  }

  if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
    options.onToolCall?.(event.item.call_id, event.item.name, parseToolCallInput(event.item.arguments));
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

  if (event.type === 'response.failed') {
    const error = event.response.error;

    const mismatchedModel = getMismatchedModelNotFoundName(error?.message, options.model);
    if (mismatchedModel && options.transport !== 'http') {
      throw new WebSocketTransportUnavailableError(
        `Responses WebSocket resolved stale model ${mismatchedModel} while requesting ${options.model}.`
      );
    }

    if (options.previousResponseId && isPreviousResponseNotFoundError(error?.code, error?.message)) {
      throw new ResponsesContinuationMissError(
        error?.message ?? 'Responses API previous_response_id was not found.',
        options.previousResponseId
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

  return error instanceof WebSocketTransportUnavailableError || Boolean(getModelNotFoundName(error));
}

function getMismatchedModelNotFoundName(error: { error?: { message?: string | null } | undefined; message: string } | string | undefined, requestedModel: string): string | undefined {
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

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      messages.push(value);
      return;
    }

    if (value instanceof Error) {
      messages.push(value.message);
      visit((value as Error & { cause?: unknown }).cause);
      return;
    }

    if (typeof value === 'object') {
      const record = value as {
        message?: unknown;
        error?: unknown;
        cause?: unknown;
      };

      if (typeof record.message === 'string') {
        messages.push(record.message);
      }

      visit(record.error);
      visit(record.cause);
    }
  };

  visit(error);
  return messages;
}

class WebSocketTransportUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebSocketTransportUnavailableError';
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
    ? await codexFetch(options.authManager, `${normalizeBaseURL(options.baseURL)}/responses/input_tokens`, init)
    : await fetch(`${normalizeBaseURL(options.baseURL)}/responses/input_tokens`, {
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

function convertToolToResponseTool(tool: vscode.LanguageModelChatTool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParameters(tool.inputSchema),
    strict: false
  };
}

function normalizeToolParameters(inputSchema: object | undefined): { [key: string]: unknown } | null {
  return inputSchema ? (inputSchema as { [key: string]: unknown }) : null;
}

function mapToolChoice(toolMode: vscode.LanguageModelChatToolMode | undefined): ToolChoiceOptions {
  return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
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

function isPreviousResponseNotFoundError(code: unknown, message: unknown): boolean {
  if (code === 'previous_response_not_found') {
    return true;
  }

  return typeof message === 'string' && message.includes('previous_response_not_found');
}

function getResponseErrorDetails(error: unknown): {
  code: unknown;
  message: unknown;
} {
  if (typeof error !== 'object' || error === null) {
    return {
      code: undefined,
      message: undefined
    };
  }

  const record = error as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
  };
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as {
      code?: unknown;
      message?: unknown;
    };
    return {
      code: nested.code,
      message: nested.message ?? record.message
    };
  }

  return {
    code: record.code,
    message: record.message
  };
}

function isOpaqueHttpContinuationRejection(error: unknown): boolean {
  return error instanceof APIError
    && error.status === 400
    && /\b400 status code \(no body\)/i.test(error.message);
}

function isMissingFunctionCallForToolOutputError(error: unknown): boolean {
  return collectErrorMessages(error)
    .some((message) => /no tool call found for function call output with call_id/i.test(message));
}

function normalizeResponsesError(error: unknown, baseURL: string): Error {
  const endpoint = `${normalizeBaseURL(baseURL)}/responses`;

  if (error instanceof APIConnectionTimeoutError) {
    return new Error(
      `OpenAI request timed out while contacting ${endpoint}. The OpenAI SDK automatically retried transient timeouts, but the request still did not complete. Check network, proxy, or VPN stability and try again.`,
      { cause: error }
    );
  }

  if (error instanceof APIConnectionError) {
    const causeMessage = getCauseMessage(error);
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

function getCauseMessage(error: Error & { cause?: unknown }): string | undefined {
  const cause = error.cause;
  if (!cause) {
    return undefined;
  }

  if (cause instanceof Error && cause.message.trim()) {
    return cause.message.trim();
  }

  if (typeof cause === 'string' && cause.trim()) {
    return cause.trim();
  }

  return undefined;
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
