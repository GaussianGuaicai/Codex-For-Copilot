import OpenAI from 'openai';
import { ResponsesWS, type ResponsesWSClientOptions } from 'openai/resources/responses/ws';
import type { ResponsesServerEvent } from 'openai/resources/responses/responses';
import {
  CodexHeader,
  parseCodexResponseHeaders,
  type CodexRequestIdentity
} from './codexProtocol';
import {
  areCodexRequestsIncrementallyCompatible,
  buildCodexResponsesWebSocketEvent,
  type CodexRequestBuilderOptions,
  type CodexResponsesRequest
} from './codexRequestBuilder';

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CodexWebSocketHandshake {
  turnState?: string;
  modelsEtag?: string;
  reasoningIncluded: boolean;
  serverModel?: string;
}

export interface CodexWebSocketResponseResult {
  responseId?: string;
  outputItems: unknown[];
  handshake?: CodexWebSocketHandshake;
  connectionReused: boolean;
  previousResponseIdUsed?: string;
  incrementalInputCount: number;
  turnState?: string;
  requestBytes: number;
}

export interface CodexWebSocketStreamOptions {
  request: CodexResponsesRequest;
  builderOptions: CodexRequestBuilderOptions;
  identity: CodexRequestIdentity;
  signal: AbortSignal;
  onEvent: (event: ResponsesServerEvent) => void;
}

export class CodexWebSocketSession {
  private readonly socket: ResponsesWS;
  private queue: Promise<void> = Promise.resolve();
  private handshake?: CodexWebSocketHandshake;
  private currentTurnId?: string;
  private turnState?: string;
  private lastRequest?: CodexResponsesRequest;
  private lastResponseId?: string;
  private lastResponseItems: unknown[] = [];
  private lastResponseWasPrewarm = false;
  private used = false;
  private closed = false;
  readonly createdAt = Date.now();
  lastUsedAt = this.createdAt;

  constructor(client: OpenAI, options: ResponsesWSClientOptions) {
    this.socket = new ResponsesWS(client, options);
    this.attachUpgradeAdapter();
  }

  isOpen(): boolean {
    return !this.closed && this.socket.socket.readyState === WEBSOCKET_OPEN;
  }

  isUsable(): boolean {
    return !this.closed
      && (this.socket.socket.readyState === WEBSOCKET_CONNECTING || this.socket.socket.readyState === WEBSOCKET_OPEN);
  }

  getTurnState(): string | undefined {
    return this.turnState;
  }

  async prewarm(options: CodexWebSocketStreamOptions): Promise<CodexWebSocketResponseResult> {
    return this.enqueue(() => this.runResponse(options, false, true));
  }

  async stream(options: CodexWebSocketStreamOptions): Promise<CodexWebSocketResponseResult> {
    return this.enqueue(() => this.runResponse(options, true, false));
  }

  close(code = 1000, reason = 'OK'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.close({ code, reason });
    } catch {
      // Best-effort disposal.
    }
  }

  private async runResponse(
    options: CodexWebSocketStreamOptions,
    reportEvents: boolean,
    prewarm: boolean
  ): Promise<CodexWebSocketResponseResult> {
    if (options.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    this.bindTurn(options.identity.turnId);
    this.lastUsedAt = Date.now();
    const connectionReused = this.used;
    this.used = true;

    const incremental = this.buildIncrementalRequest(options.request);
    const request = incremental?.request ?? options.request;
    const builderOptions: CodexRequestBuilderOptions = {
      ...options.builderOptions,
      input: request.input as CodexRequestBuilderOptions['input'],
      previousResponseId: incremental?.previousResponseId,
      websocketRequestStartedAt: Date.now()
    };
    const event = buildCodexResponsesWebSocketEvent(builderOptions, prewarm ? false : undefined);
    if (this.turnState && event.client_metadata) {
      event.client_metadata[CodexHeader.turnState] = this.turnState;
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(event));

    const outputItems: unknown[] = [];
    let responseId: string | undefined;
    let terminal = false;
    let failureMessage: string | undefined;
    const abort = () => this.close(1000, 'cancelled');
    options.signal.addEventListener('abort', abort, { once: true });

    try {
      this.socket.send(event as Parameters<ResponsesWS['send']>[0]);
      const iterator = this.socket.stream()[Symbol.asyncIterator]();
      while (true) {
        const next = await nextWithTimeout(iterator, WEBSOCKET_IDLE_TIMEOUT_MS, options.signal);
        if (next.done) {
          break;
        }
        const streamEvent = next.value;
        if (options.signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (streamEvent.type === 'message') {
          const message = streamEvent.message;
          const metadataTurnState = getMetadataTurnState(message);
          if (metadataTurnState && !this.turnState) {
            this.turnState = metadataTurnState;
          }
          if (message.type === 'response.created') {
            responseId = message.response.id ?? responseId;
          }
          if (message.type === 'response.output_item.done') {
            outputItems.push(message.item);
          }
          if (reportEvents) {
            options.onEvent(message);
          }
          if (message.type === 'response.completed') {
            responseId = message.response.id ?? responseId;
            terminal = true;
            break;
          }
          if (message.type === 'response.failed') {
            failureMessage = message.response.error?.message ?? 'Responses API request failed.';
            terminal = true;
            break;
          }
          continue;
        }
        if (streamEvent.type === 'error') {
          throw streamEvent.error;
        }
        if (streamEvent.type === 'close') {
          throw new Error(streamEvent.reason || `WebSocket closed with code ${streamEvent.code}.`);
        }
      }
      if (!terminal) {
        throw new Error('Responses WebSocket stream ended before a terminal event.');
      }
      if (failureMessage) {
        throw new Error(failureMessage);
      }

      this.lastRequest = structuredClone(options.request);
      this.lastResponseId = responseId;
      this.lastResponseItems = [...outputItems];
      this.lastResponseWasPrewarm = prewarm;
      return {
        responseId,
        outputItems,
        handshake: this.handshake,
        connectionReused,
        previousResponseIdUsed: incremental?.previousResponseId,
        incrementalInputCount: getRequestInput(incremental?.request ?? options.request).length,
        turnState: this.turnState,
        requestBytes
      };
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  }

  private buildIncrementalRequest(request: CodexResponsesRequest): {
    request: CodexResponsesRequest;
    previousResponseId: string;
  } | undefined {
    if (!this.lastRequest || !this.lastResponseId || !areCodexRequestsIncrementallyCompatible(this.lastRequest, request)) {
      return undefined;
    }
    const previousInput = this.lastRequest.input as unknown[];
    const currentInput = request.input as unknown[];
    if (currentInput.length < previousInput.length || (currentInput.length === previousInput.length && !this.lastResponseWasPrewarm)) {
      return undefined;
    }
    for (let index = 0; index < previousInput.length; index += 1) {
      if (JSON.stringify(previousInput[index]) !== JSON.stringify(currentInput[index])) {
        return undefined;
      }
    }
    return {
      request: {
        ...request,
        input: currentInput.slice(previousInput.length) as CodexResponsesRequest['input'],
        previous_response_id: this.lastResponseId
      },
      previousResponseId: this.lastResponseId
    };
  }

  private bindTurn(turnId: string): void {
    if (this.currentTurnId === turnId) {
      return;
    }
    this.currentTurnId = turnId;
    this.turnState = undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private attachUpgradeAdapter(): void {
    const adapter = this.socket.socket as typeof this.socket.socket & {
      platformSocket?: {
        once(event: 'upgrade', listener: (response: {
          headers: Record<string, string | string[] | undefined>;
        }) => void): void;
      };
    };
    const platformSocket = adapter.platformSocket;
    if (!platformSocket || typeof platformSocket.once !== 'function') {
      throw new Error('OpenAI SDK ResponsesWS Node socket adapter does not expose platformSocket.');
    }
    platformSocket.once('upgrade', (response: { headers: Record<string, string | string[] | undefined> }) => {
      const parsed = parseCodexResponseHeaders(new Headers(Object.entries(response.headers)
        .flatMap(([key, value]) => Array.isArray(value)
          ? value.map((entry) => [key, entry] as [string, string])
          : value === undefined ? [] : [[key, String(value)] as [string, string]])));
      this.handshake = {
        turnState: parsed.turnState,
        modelsEtag: parsed.modelsEtag,
        reasoningIncluded: parsed.reasoningIncluded,
        serverModel: parsed.serverModel
      };
      if (parsed.turnState && !this.turnState) {
        this.turnState = parsed.turnState;
      }
    });
  }
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Responses WebSocket idle timeout.')), timeoutMs);
        timer.unref?.();
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) {
          return;
        }
        abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abort && signal) {
      signal.removeEventListener('abort', abort);
    }
  }
}

function getRequestInput(request: CodexResponsesRequest): unknown[] {
  return Array.isArray(request.input) ? request.input : [];
}

function getMetadataTurnState(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }
  const record = event as { type?: unknown; headers?: unknown };
  if (record.type !== 'response.metadata' || !record.headers || typeof record.headers !== 'object') {
    return undefined;
  }
  const entry = Object.entries(record.headers as Record<string, unknown>)
    .find(([key]) => key.toLowerCase() === CodexHeader.turnState);
  return typeof entry?.[1] === 'string' && entry[1].trim() ? entry[1].trim() : undefined;
}
