import { performance } from 'node:perf_hooks';
import type { ResponseCreateParamsStreaming, ToolChoiceOptions } from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
import * as vscode from 'vscode';
import type { ResponsesInputMessage } from './convertMessages';
import { resolveCodexToolSchemas } from './codexToolSchemaCache';
import type { CodexToolPlan } from './nativeToolSearch/nativeToolTypes';
import {
  CodexHeader,
  createCodexTurnMetadata,
  stableSerializeCodexMetadata,
  type CodexRequestIdentity
} from './codexProtocol';

export type CodexResponsesRequest = ResponseCreateParamsStreaming & {
  client_metadata?: Record<string, string>;
};

export type CodexResponsesWebSocketRequest = Omit<CodexResponsesRequest, 'stream'> & {
  type: 'response.create';
  stream?: true;
  generate?: boolean;
};

export interface CodexRequestBuilderOptions {
  compatibilityEnabled: boolean;
  identity?: CodexRequestIdentity;
  model: string;
  instructions: string;
  input: ResponsesInputMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
  toolPlan?: CodexToolPlan;
  toolMode?: vscode.LanguageModelChatToolMode;
  reasoning?: Reasoning;
  serviceTier?: 'default' | 'priority';
  previousResponseId?: string;
  store?: boolean;
  omitMaxOutputTokens?: boolean;
  maxOutputTokens: number;
  textVerbosity?: 'low' | 'medium' | 'high';
  includeEncryptedReasoning?: boolean;
  requestKind?: 'turn' | 'prewarm';
  websocketRequestStartedAt?: number;
}

export type CodexRequestEnvelopeOptions = Omit<
  CodexRequestBuilderOptions,
  'identity' | 'input' | 'previousResponseId' | 'requestKind' | 'websocketRequestStartedAt'
>;

export interface CodexRequestBuildMetrics {
  requestBuildMs: number;
  toolSchemaBytes: number;
  toolSchemaCacheHit: boolean;
}

export interface CodexRequestBuildResult {
  request: CodexResponsesRequest;
  metrics: CodexRequestBuildMetrics;
}

export function buildCodexResponsesRequest(options: CodexRequestBuilderOptions): CodexResponsesRequest {
  return buildCodexResponsesRequestWithMetrics(options).request;
}

export function buildCodexResponsesRequestWithMetrics(
  options: CodexRequestBuilderOptions
): CodexRequestBuildResult {
  const startedAt = performance.now();
  const legacyToolSchemas = options.toolPlan ? undefined : resolveCodexToolSchemas(options.tools);
  const toolPlan = options.toolPlan;
  const tools = toolPlan?.responseTools ?? legacyToolSchemas?.responseTools ?? [];
  const metadata = options.compatibilityEnabled && options.identity
    ? buildCodexClientMetadata(options.identity, options.requestKind ?? 'turn', options.websocketRequestStartedAt)
    : undefined;
  const compatibilityFields = options.compatibilityEnabled
    ? {
        include: options.includeEncryptedReasoning === false ? [] : ['reasoning.encrypted_content'],
        ...(options.textVerbosity ? { text: { verbosity: options.textVerbosity } } : {})
      }
    : {};
  const identityFields = options.compatibilityEnabled && options.identity
    ? {
        prompt_cache_key: options.identity.threadId,
        client_metadata: metadata
      }
    : {};

  const request = {
    model: options.model,
    instructions: options.instructions,
    input: options.input,
    stream: true,
    store: options.store ?? false,
    ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(tools.length > 0
      ? {
          tools: [...tools],
          tool_choice: mapToolChoice(options.toolMode),
          parallel_tool_calls: true
        }
      : {}),
    ...compatibilityFields,
    ...identityFields,
    ...(options.omitMaxOutputTokens ? {} : { max_output_tokens: options.maxOutputTokens })
  } as CodexResponsesRequest;
  return {
    request,
    metrics: {
      requestBuildMs: Math.max(0, performance.now() - startedAt),
      toolSchemaBytes: toolPlan?.toolSchemaBytes ?? legacyToolSchemas?.toolSchemaBytes ?? 0,
      toolSchemaCacheHit: toolPlan === undefined && (legacyToolSchemas?.cacheHit ?? false)
    }
  };
}

export function buildCodexResponsesWebSocketEvent(
  options: CodexRequestBuilderOptions,
  generate?: boolean
): CodexResponsesWebSocketRequest {
  const request = buildCodexResponsesRequest({
    ...options,
    requestKind: generate === false ? 'prewarm' : options.requestKind,
    websocketRequestStartedAt: options.websocketRequestStartedAt ?? Date.now()
  });
  const { stream: _stream, ...body } = request;
  return {
    type: 'response.create',
    ...body,
    ...(generate === undefined ? {} : { generate })
  };
}

export function buildCodexClientMetadata(
  identity: CodexRequestIdentity,
  requestKind: 'turn' | 'prewarm',
  websocketRequestStartedAt?: number
): Record<string, string> {
  const turnMetadata = stableSerializeCodexMetadata(createCodexTurnMetadata(identity, requestKind));
  return {
    [CodexHeader.installationId]: identity.installationId,
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    turn_id: identity.turnId,
    [CodexHeader.windowId]: identity.windowId,
    [CodexHeader.turnMetadata]: turnMetadata,
    ...(identity.parentThreadId ? { [CodexHeader.parentThreadId]: identity.parentThreadId } : {}),
    ...(websocketRequestStartedAt === undefined
      ? {}
      : { 'x-codex-ws-stream-request-start-ms': String(websocketRequestStartedAt) })
  };
}

export function fingerprintCodexRequest(request: CodexResponsesRequest): string {
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    prompt_cache_key: _promptCacheKey,
    client_metadata: _clientMetadata,
    ...properties
  } = request;
  return stableSerialize(properties);
}

export function fingerprintCodexRequestEnvelope(options: CodexRequestEnvelopeOptions): string {
  return fingerprintCodexRequest(buildCodexResponsesRequest({
    ...options,
    input: []
  }));
}

export function areCodexRequestsIncrementallyCompatible(
  previous: CodexResponsesRequest,
  current: CodexResponsesRequest
): boolean {
  return fingerprintCodexRequest(previous) === fingerprintCodexRequest(current);
}

function mapToolChoice(toolMode: vscode.LanguageModelChatToolMode | undefined): ToolChoiceOptions {
  return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
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

export { resetCodexToolSchemaCache } from './codexToolSchemaCache';
