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
import type { ResponsesInputMessage } from './convertMessages';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { codexFetch } from './auth/codexAuthRequest';

const OPENAI_DEFAULT_MAX_RETRIES = 2;
const OPENAI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REUSABLE_WEBSOCKET_TTL_MS = 10 * 60 * 1000;
const MAX_REUSABLE_WEBSOCKETS = 32;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = 'previous_response_not_found';
const PREVIOUS_RESPONSE_NOT_FOUND_DEFAULT_MESSAGE = 'Responses API previous_response_id was not found.';

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
  previousResponseId?: string;
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

        disposeReusableResponsesWebSockets();

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

    if (isResponsesContinuationMissError(error)) {
      throw error;
    }

    if (options.previousResponseId) {
      const continuationMissMessage = getPreviousResponseNotFoundMessage(error);
      if (continuationMissMessage) {
        throw new ResponsesContinuationMissError(
          continuationMissMessage,
          options.previousResponseId,
          { cause: error }
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
  const client = createOpenAIClient(options);
  const request = buildResponsesCreateRequest(options);

  const stream = await client.responses.create(
    request,
    {
      signal: abortController.signal,
      maxRetries: OPENAI_DEFAULT_MAX_RETRIES,
      timeout: OPENAI_DEFAULT_TIMEOUT_MS
    }
  );

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
    socket.send(buildResponsesCreateEvent(options));

    for await (const streamEvent of socket.stream()) {
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

        const continuationMissMessage = options.previousResponseId
          ? getPreviousResponseNotFoundMessage(streamEvent.error)
          : undefined;
        if (options.previousResponseId && continuationMissMessage) {
          releaseReusableWebSocketSession(session, undefined, false);
          throw new ResponsesContinuationMissError(
            continuationMissMessage,
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

function createReusableWebSocketSession(options: Pick<StreamResponseTextOptions, 'apiKey' | 'baseURL' | 'headers'>): ReusableResponsesWebSocketSession {
  const client = createOpenAIClient(options);
  const socketOptions = (options.headers
    ? { headers: options.headers }
    : {}) as ResponsesWSClientOptions;

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

function createOpenAIClient(options: Pick<StreamResponseTextOptions, 'apiKey' | 'baseURL' | 'headers'>): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: normalizeBaseURL(options.baseURL),
    defaultHeaders: options.headers,
    maxRetries: OPENAI_DEFAULT_MAX_RETRIES,
    timeout: OPENAI_DEFAULT_TIMEOUT_MS
  });
}

function buildResponsesCreateRequest(options: StreamResponseTextOptions) {
  const tools = options.tools?.map(convertToolToResponseTool) ?? [];

  return {
    model: options.model,
    instructions: options.instructions,
    input: options.input,
    stream: true,
    store: false,
    ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(tools.length > 0
      ? {
          tools,
          tool_choice: mapToolChoice(options.toolMode)
        }
      : {}),
    ...(options.omitMaxOutputTokens ? {} : { max_output_tokens: options.maxOutputTokens })
  } as const;
}

function buildResponsesCreateEvent(options: StreamResponseTextOptions): ResponsesClientEvent {
  const { stream: _stream, ...request } = buildResponsesCreateRequest(options);

  return {
    type: 'response.create',
    ...request
  };
}

function handleResponsesServerEvent(event: ResponsesServerEvent, options: StreamResponseTextOptions): void {
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

    const continuationMissMessage = options.previousResponseId
      ? getPreviousResponseNotFoundMessage(error)
      : undefined;
    if (options.previousResponseId && continuationMissMessage) {
      throw new ResponsesContinuationMissError(
        continuationMissMessage,
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
    options?: ErrorOptions
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

function getPreviousResponseNotFoundMessage(error: unknown): string | undefined {
  const visited = new Set<object>();

  const visit = (value: unknown): { matched: boolean; message?: string } => {
    if (typeof value === 'string') {
      const message = value.trim();
      return message.includes(PREVIOUS_RESPONSE_NOT_FOUND_CODE)
        ? { matched: true, message }
        : { matched: false };
    }

    if (!value || typeof value !== 'object' || visited.has(value)) {
      return { matched: false };
    }

    visited.add(value);
    const record = value as Partial<Record<'code' | 'message' | 'error' | 'cause', unknown>>;
    const message = typeof record.message === 'string' && record.message.trim()
      ? record.message.trim()
      : undefined;
    const nestedError = visit(record.error);

    if (nestedError.matched) {
      return {
        matched: true,
        message: nestedError.message ?? message
      };
    }

    if (record.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE) {
      return { matched: true, message };
    }

    const nestedCause = visit(record.cause);
    if (nestedCause.matched) {
      return {
        matched: true,
        message: nestedCause.message ?? message
      };
    }

    return message?.includes(PREVIOUS_RESPONSE_NOT_FOUND_CODE)
      ? { matched: true, message }
      : { matched: false };
  };

  const match = visit(error);
  if (!match.matched) {
    return undefined;
  }

  return match.message ?? PREVIOUS_RESPONSE_NOT_FOUND_DEFAULT_MESSAGE;
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
