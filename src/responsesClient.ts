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

const OPENAI_DEFAULT_MAX_RETRIES = 2;
const OPENAI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CountInputTokensOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  input: string | ResponsesInputMessage[];
  token: vscode.CancellationToken;
}

export interface StreamResponseTextOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  transport?: 'auto' | 'http' | 'websocket';
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
  const client = createOpenAIClient(options);
  const socketOptions = (options.headers
    ? { headers: options.headers }
    : {}) as ResponsesWSClientOptions;

  const socket = new ResponsesWS(client, socketOptions);

  const closeSocket = (code = 1000, reason = 'OK') => {
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

        if (message.type === 'response.completed' || message.type === 'response.failed') {
          sawTerminalEvent = true;
          closeSocket();
          return;
        }

        continue;
      }

      if (streamEvent.type === 'error') {
        if (!sawResponseActivity) {
          throw new WebSocketTransportUnavailableError(streamEvent.error.message, { cause: streamEvent.error });
        }

        throw streamEvent.error;
      }

      if (streamEvent.type === 'close') {
        if (sawTerminalEvent || options.token.isCancellationRequested || abortController.signal.aborted) {
          return;
        }

        const message = streamEvent.reason || `WebSocket closed with code ${streamEvent.code}.`;

        if (!sawResponseActivity) {
          throw new WebSocketTransportUnavailableError(message);
        }

        throw new Error(message);
      }
    }

    if (!sawTerminalEvent && !options.token.isCancellationRequested && !abortController.signal.aborted) {
      throw new Error('Responses WebSocket stream ended before the response completed.');
    }
  } finally {
    abortController.signal.removeEventListener('abort', abortListener);
    closeSocket();
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

  return error instanceof WebSocketTransportUnavailableError;
}

class WebSocketTransportUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebSocketTransportUnavailableError';
  }
}

export async function countInputTokens(options: CountInputTokensOptions): Promise<number> {
  const response = await fetch(`${normalizeBaseURL(options.baseURL)}/responses/input_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
      ...options.headers
    },
    body: JSON.stringify({
      model: options.model,
      input: options.input
    }),
    signal: toAbortSignal(options.token)
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
