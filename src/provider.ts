import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import { compareResponsesInputHistory, convertMessagesToResponsesInput, estimateTokenCount, stableSerialize, type ResponsesInputMessage } from './convertMessages';
import { getProviderConfig, type ProviderConfig } from './config';
import { buildFallbackModel, buildProviderModels, fetchAvailableModels, isProviderModelIdentifier, parseModelIdentifier, type ParsedModelIdentifier, type ReasoningEffort, type ResolvedProviderModel } from './models';
import {
  countInputTokens,
  disposeReusableResponsesWebSockets,
  isResponsesContinuationMissError,
  normalizeBaseURL,
  preconnectCodexResponsesWebSocket,
  streamResponseText
} from './responsesClient';
import { ResponseBranchStore, type ResponseBranchReuseEnvelope, type ResponseBranchToolSignatures } from './responseBranchStore';
import { getApiCredentials } from './secrets';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { CodexIdentityManager, inputStartsNewTurn } from './codexIdentity';
import { getCodexCompatibilityProfile, type CodexRequestIdentity } from './codexProtocol';
import { resetCodexFetchCapabilities } from './codexFetchAdapter';
import {
  buildCodexResponsesRequest,
  fingerprintCodexRequest,
  fingerprintCodexRequestEnvelope,
  type CodexRequestEnvelopeOptions
} from './codexRequestBuilder';
import type { CodexBranchState } from './responseBranchStore';
import { shortHash } from './codexTelemetry';
import { CodexLatencyRecorder, type CodexLatencyContext } from './codexLatency';
import { createCodexContinuationSnapshot } from './codexContinuation';
import { resolveCodexToolSchemas } from './codexToolSchemaCache';
import { StreamPresenter } from './streamPresenter';
import {
  CodexModelCache,
  MODEL_CACHE_FRESH_TTL_MS,
  MODEL_CACHE_STALE_TTL_MS,
  type CodexModelCacheState
} from './codexModelCache';

type RuntimeProvideLanguageModelChatResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type ReasoningEffortSource =
  | 'modelConfiguration'
  | 'configuration'
  | 'modelOptions.reasoningEffort'
  | 'modelOptions.thinkingEffort'
  | 'modelOptions.reasoning.effort'
  | 'modelOptions.thinking.effort'
  | 'modelOptions.thinking'
  | 'default'
  | 'model'
  | 'none';

interface ReasoningEffortResolution {
  effort: ReasoningEffort | undefined;
  source: ReasoningEffortSource;
  hasExplicitConflict: boolean;
}

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string, metadata?: { readonly [key: string]: any }) => unknown;
};

const USAGE_DATA_PART_MIME = 'usage';
const MODEL_DISCOVERY_FALLBACK_TTL_MS = 60_000;
const REPORTED_TOOL_CALL_TTL_MS = 10 * 60_000;
const MAX_PENDING_REPORTED_TOOL_CALLS = 200;
const TOOL_OUTPUT_CONTINUATION_CAPABILITY_TTL_MS = 30 * 60_000;
const MAX_TOOL_OUTPUT_CONTINUATION_CAPABILITIES = 64;
// The WebSocket tool-output continuation path passed the real-backend release
// gate: five consecutive store:false tool loops completed with a matching
// previous_response_id and a single incremental function_call_output.
const TOOL_OUTPUT_CONTINUATION_ENABLED = true;
const NON_CANCELLABLE_TOKEN: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => new vscode.Disposable(() => {})
};

interface ReportedToolCall {
  callId: string;
  name: string;
  reportedAt: number;
  responseCompletedAt?: number;
}

interface ToolOutputContinuationCapability {
  supported: boolean;
  observedAt: number;
}

interface ObservedToolResult {
  callId: string;
  name: string;
  reportedToResultObservedMs: number;
  responseCompletedToResultObservedMs?: number;
  resultBytes: number;
  resultObservedAt: number;
}

function getToolOutputFullReplayReason(options: {
  hasOnlyToolOutputAppend: boolean;
  transport: ProviderConfig['transport'];
  capability: boolean | undefined;
}): string {
  if (!options.hasOnlyToolOutputAppend) {
    return 'non-tool-output-append';
  }
  if (options.transport === 'http') {
    return 'http-transport';
  }
  if (!TOOL_OUTPUT_CONTINUATION_ENABLED) {
    return 'release-gated';
  }
  if (options.capability === false) {
    return 'capability-unsupported';
  }
  return 'continuation-ineligible';
}

export interface UsageSink {
  record(event: {
    model: string;
    usage: ResponseUsage;
    completedAt: number;
  }): void;
}

export interface SelectedModelSink {
  setSelectedModel(model: string): void;
}

export interface AccountUsageRefreshSink {
  refresh(): Promise<void>;
}

export class CodexModelProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  private readonly responseBranchStore = new ResponseBranchStore();
  private readonly runtimeAvailability = new RuntimeModelAvailability();
  private readonly identityManager: CodexIdentityManager;
  private readonly pendingReportedToolCalls = new Map<string, ReportedToolCall>();
  private readonly toolOutputContinuationCapabilities = new Map<string, ToolOutputContinuationCapability>();
  private readonly modelCache = new CodexModelCache<ResolvedProviderModel[]>({
    freshTtlMs: MODEL_CACHE_FRESH_TTL_MS,
    staleTtlMs: MODEL_CACHE_STALE_TTL_MS
  });
  private lastConnectionConfigurationKey?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly usageSink?: UsageSink,
    private readonly accountUsageRefreshSink?: AccountUsageRefreshSink,
    private readonly selectedModelSink?: SelectedModelSink,
    private readonly authManager?: CodexAuthManager
  ) {
    const runtimeContext = context as vscode.ExtensionContext & {
      globalState?: vscode.Memento;
    };
    this.identityManager = new CodexIdentityManager(runtimeContext.globalState ?? createMemoryMemento());
    this.onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    this.context.subscriptions.push(
      this.modelInfoChangedEmitter,
      new vscode.Disposable(() => disposeReusableResponsesWebSockets()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codexModelProvider')) {
          disposeReusableResponsesWebSockets();
          resetCodexFetchCapabilities();
          this.lastConnectionConfigurationKey = undefined;
          this.modelCache.clear();
          this.modelInfoChangedEmitter.fire();
        }
      })
    );
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);

    this.outputChannel.debug('provideLanguageModelChatInformation start', {
      silent: options.silent,
      baseURL: normalizeBaseURL(config.baseURL),
      clientVersion: config.clientVersion,
      hasCredentials: Boolean(credentials)
    });

    if (!credentials) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          'Codex credentials are required.',
          { modal: true },
          'Import auth.json',
          'Sign in with Device Code',
          'Cancel'
        );

        if (action === 'Import auth.json') {
          await vscode.commands.executeCommand('codexForCopilot.auth.importAuthJson');
        } else if (action === 'Sign in with Device Code') {
          await vscode.commands.executeCommand('codexForCopilot.auth.signInWithDeviceCode');
        }
      }

      return [];
    }

    const models = await this.getAvailableModels(config, credentials, token);
    this.scheduleWebSocketPreconnection(config, credentials, getCredentialIdentity(credentials));
    this.outputChannel.info('provideLanguageModelChatInformation complete', {
      modelCount: models.length,
      models: models.map((model) => ({
        id: model.info.id,
        name: model.info.name,
        maxInputTokens: model.info.maxInputTokens,
        maxOutputTokens: model.info.maxOutputTokens
      }))
    });
    return models.map((model) => model.info);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const latency = new CodexLatencyRecorder();
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);
    latency.mark('credentialsResolved');

    if (!credentials) {
      throw new Error('Codex credentials are missing. Run "Codex for Copilot: Import Codex auth.json".');
    }

    const authIdentity = getCredentialIdentity(credentials);
    this.handleConnectionConfiguration(config, authIdentity);
    const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials);
    const directModel = this.resolveDirectRequestModel(model.id, config, authIdentity);
    let selectedModel: ParsedModelIdentifier;
    if (directModel) {
      selectedModel = directModel;
      latency.recordContext({ modelDiscoveryCacheState: 'direct' });
      this.outputChannel.debug('request model resolved from provider model id', {
        modelId: model.id,
        requestModel: selectedModel.requestModel
      });
    } else {
      const availableModels = await this.getAvailableModels(config, credentials, token, (state) => {
        latency.recordContext({ modelDiscoveryCacheState: state });
      });
      selectedModel = this.resolveRequestModel(model.id, config, availableModels);
    }
    this.scheduleWebSocketPreconnection(config, credentials, authIdentity);
    latency.mark('modelResolved');
    this.selectedModelSink?.setSelectedModel(selectedModel.requestModel);
    const reasoning = getReasoningEffort(
      selectedModel.reasoningEffort,
      options as RuntimeProvideLanguageModelChatResponseOptions,
      config.defaultReasoningEffort
    );
    const reasoningEffort = reasoning.effort;
    const requestStartedAt = latency.entryAt;
    const input = convertMessagesToResponsesInput(messages);
    const observedToolResults = this.consumeReportedToolResults(input);
    latency.mark('messagesConverted');
    const requestBuildStartedAt = performance.now();
    const requestOptions: CodexRequestEnvelopeOptions = {
      compatibilityEnabled: compatibilityProfile.enabled,
      model: selectedModel.requestModel,
      instructions: config.instructions,
      tools: options.tools,
      toolMode: options.toolMode,
      reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
      serviceTier: getRequestServiceTier(config.defaultServiceTier),
      store: false,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens,
      textVerbosity: 'medium',
      includeEncryptedReasoning: true
    };
    const toolSchemas = resolveCodexToolSchemas(options.tools);
    latency.recordContext({
      fullInputCount: input.length,
      toolCount: options.tools?.length ?? 0,
      toolSchemaBytes: toolSchemas.toolSchemaBytes,
      toolSchemaCacheHit: toolSchemas.cacheHit,
      reasoningEffort: reasoningEffort ?? null,
      serviceTier: config.defaultServiceTier ?? 'auto'
    });
    const reuseEnvelope = buildResponseBranchReuseEnvelope({
      baseURL: normalizeBaseURL(config.baseURL),
      authIdentity,
      toolSignatures: toolSchemas.toolSignatures,
      effectiveInputBudget: model.maxInputTokens,
      ...requestOptions
    });
    latency.recordContext({ requestBuildMs: Math.max(0, performance.now() - requestBuildStartedAt) });
    const reusableBranch = this.responseBranchStore.findReusableBranch(reuseEnvelope, input);
    const reuseMissDiagnostic = reusableBranch
      ? undefined
      : this.responseBranchStore.explainReuseMiss(reuseEnvelope, input);
    latency.mark('branchResolved');
    const requiresFullInputForToolOutput = Boolean(
      reusableBranch?.comparison.appendedInput.some((item) => item.type === 'function_call_output')
    );
    const appendedInput = reusableBranch?.comparison.appendedInput ?? [];
    const hasOnlyToolOutputAppend = requiresFullInputForToolOutput
      && appendedInput.length > 0
      && appendedInput.every((item) => item.type === 'function_call_output');
    const toolOutputContinuationCapabilityKey = hasOnlyToolOutputAppend && reusableBranch
      ? this.createToolOutputContinuationCapabilityKey(config, authIdentity, selectedModel.requestModel, requestOptions.store ?? false)
      : undefined;
    const toolOutputContinuationCapability = toolOutputContinuationCapabilityKey
      ? this.getToolOutputContinuationCapability(toolOutputContinuationCapabilityKey)
      : undefined;
    const shouldAttemptToolOutputContinuation = hasOnlyToolOutputAppend
      && config.transport !== 'http'
      && TOOL_OUTPUT_CONTINUATION_ENABLED
      && toolOutputContinuationCapability !== false;
    if (requiresFullInputForToolOutput && !shouldAttemptToolOutputContinuation) {
      latency.recordContext({
        toolContinuationStrategy: 'full-replay',
        fullReplayReason: getToolOutputFullReplayReason({
          hasOnlyToolOutputAppend,
          transport: config.transport,
          capability: toolOutputContinuationCapability
        })
      });
    }
    const usePreviousResponseId = appendedInput.length > 0
      && (!requiresFullInputForToolOutput || shouldAttemptToolOutputContinuation);
    const initialRequestInput = usePreviousResponseId
      ? appendedInput
      : input;
    const initialPreviousResponseId = usePreviousResponseId
      ? reusableBranch?.responseId
      : undefined;
    let activeBranchId = initialPreviousResponseId || requiresFullInputForToolOutput
      ? reusableBranch?.branchId
      : undefined;
    let createdResponseId: string | undefined;
    let completedResponseId: string | undefined;
    const rawResponseItems: unknown[] = [];
    const requestIdentity = await this.resolveRequestIdentity(
      reusableBranch?.state,
      reuseMissDiagnostic?.comparison.kind === 'fork' && reuseMissDiagnostic.comparison.matchedPrefixCount > 0
        ? reuseMissDiagnostic.state
        : undefined,
      reusableBranch?.comparison.appendedInput ?? input
    );
    latency.mark('identityResolved');
    let branchState: CodexBranchState = {
      identity: {
        installationId: requestIdentity.installationId,
        sessionId: requestIdentity.sessionId,
        threadId: requestIdentity.threadId,
        windowId: requestIdentity.windowId,
        parentThreadId: requestIdentity.parentThreadId
      },
      turn: {
        id: requestIdentity.turnId,
        stickyState: reusableBranch?.state?.turn.id === requestIdentity.turnId
          ? reusableBranch.state.turn.stickyState
          : undefined,
        startedAt: reusableBranch?.state?.turn.id === requestIdentity.turnId
          ? reusableBranch.state.turn.startedAt
          : Date.now(),
        completed: false
      },
      updatedAt: Date.now()
    };
    let reportedVisibleOutput = false;
    let toolContinuationProbeStartedAt: number | undefined;
    if (shouldAttemptToolOutputContinuation) {
      toolContinuationProbeStartedAt = Date.now();
      latency.recordContext({
        toolOutputContinuation: 'attempted',
        toolContinuationStrategy: 'incremental'
      });
    }
    latency.mark('requestReady');

    this.outputChannel.info('provideLanguageModelChatResponse start', {
      modelId: model.id,
      requestModel: selectedModel.requestModel,
      transport: config.transport,
      reuse: shouldAttemptToolOutputContinuation
        ? {
            strategy: 'tool-output-continuation',
            branchId: reusableBranch?.branchId,
            matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
            appendedInputCount: reusableBranch?.comparison.appendedInput.length,
            capability: toolOutputContinuationCapability === true ? 'supported' : 'unknown'
          }
        : initialPreviousResponseId
        ? {
            strategy: 'previous-response',
            branchId: reusableBranch?.branchId,
            matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
            appendedInputCount: reusableBranch?.comparison.appendedInput.length
          }
        : requiresFullInputForToolOutput
          ? {
              strategy: 'full-replay-tool-output',
              branchId: reusableBranch?.branchId,
              matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
              appendedInputCount: reusableBranch?.comparison.appendedInput.length
            }
        : null,
      serviceTier: config.defaultServiceTier ?? 'auto',
      reasoningEffort: reasoningEffort ?? null,
      reasoningEffortSource: reasoning.source,
      reasoningEffortInputConflict: reasoning.hasExplicitConflict,
      messageCount: messages.length,
      inputItemCount: input.length,
      observedToolResults: observedToolResults.map(({ resultObservedAt: _resultObservedAt, ...toolResult }) => toolResult),
      toolCount: options.tools?.length ?? 0,
      toolMode: getToolModeName(options.toolMode),
      toolNames: summarizeToolNames(options.tools),
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens
    });

    if (reuseMissDiagnostic) {
      this.outputChannel.info('response reuse miss', {
        requestModel: selectedModel.requestModel,
        branchId: reuseMissDiagnostic.branchId,
        previousResponseId: reuseMissDiagnostic.responseId,
        comparisonKind: reuseMissDiagnostic.comparison.kind,
        matchedPrefixCount: reuseMissDiagnostic.comparison.matchedPrefixCount,
        previousInputCount: reuseMissDiagnostic.previousInputCount,
        currentInputCount: reuseMissDiagnostic.currentInputCount,
        appendedInputCount: reuseMissDiagnostic.comparison.appendedInput.length,
        mismatchIndex: reuseMissDiagnostic.comparison.mismatch?.index ?? null,
        mismatchPreviousItem: reuseMissDiagnostic.comparison.mismatch?.previousItemSummary ?? reuseMissDiagnostic.previousNextItemSummary,
        mismatchCurrentItem: reuseMissDiagnostic.comparison.mismatch?.currentItemSummary ?? reuseMissDiagnostic.currentNextItemSummary,
        requestFingerprintMatches: reuseMissDiagnostic.requestFingerprintMatches,
        previousEffectiveInputBudget: reuseMissDiagnostic.previousEffectiveInputBudget ?? null,
        currentEffectiveInputBudget: reuseMissDiagnostic.currentEffectiveInputBudget ?? null,
        inputBudgetCompatible: reuseMissDiagnostic.inputBudgetCompatible,
        toolCompatibility: reuseMissDiagnostic.toolCompatibility ?? null
      });
    }

    const streamRequest = async (
      requestInput: ResponsesInputMessage[],
      previousResponseId?: string,
      allowToolOutputContinuation = false
    ) => {
      const streamStartedAt = Date.now();
      let actualTransport: 'http' | 'http-fallback' | 'websocket-fresh' | 'websocket-reused' = config.transport === 'http'
        ? 'http'
        : 'http-fallback';
      let firstVisibleOutput:
        | {
            kind: 'text' | 'reasoning' | 'tool_call';
            latencyMs: number;
          }
        | undefined;
      let hasReportedText = false;
      let previousResponseIdUsed = false;
      if (config.transport === 'http') {
        latency.mark('connectionAcquired');
      }
      latency.recordContext({
        previousResponseIdUsed: Boolean(previousResponseId),
        incrementalInputCount: previousResponseId ? requestInput.length : 0,
        transportActual: actualTransport
      });
      latency.mark('requestSent');
      if (observedToolResults.length > 0) {
        const requestSentAt = Date.now();
        this.outputChannel.info('tool result recovery timing', {
          requestModel: selectedModel.requestModel,
          toolResults: observedToolResults.map(({ resultObservedAt, ...toolResult }) => ({
            ...toolResult,
            resultObservedToRequestSentMs: Math.max(0, requestSentAt - resultObservedAt)
          }))
        });
      }

      const toolCallLifecycleAt = new Map<string, {
        addedAt?: number;
        argumentsDeltaAt?: number;
        argumentsDoneAt?: number;
      }>();
      const reportedToolCallIds = new Set<string>();

      const recordFirstVisibleOutput = (
        kind: 'text' | 'reasoning' | 'tool_call',
        reportedAt = Date.now()
      ) => {
        if (firstVisibleOutput) {
          return;
        }

        firstVisibleOutput = {
          kind,
          latencyMs: Math.max(0, reportedAt - streamStartedAt)
        };
      };

      const presenter = new StreamPresenter(
        (_kind, receivedAt) => latency.mark('firstBackendDelta', receivedAt),
        (kind, reportedAt) => {
          reportedVisibleOutput = true;
          recordFirstVisibleOutput(kind, reportedAt);
          if (kind === 'text') {
            latency.mark('firstText', reportedAt);
          } else {
            latency.mark('firstReasoning', reportedAt);
          }
        }
      );
      let presentationMetricsRecorded = false;
      const recordPresentationMetrics = () => {
        if (presentationMetricsRecorded) {
          return;
        }
        presentationMetricsRecorded = true;
        const metrics = presenter.metrics();
        latency.recordContext({
          metricVersion: 2,
          backendDeltaCount: metrics.backendDeltaCount,
          progressReportCount: metrics.progressReportCount,
          coalescedDeltaCount: metrics.coalescedDeltaCount,
          coalescingDelayP95Ms: metrics.coalescingDelayP95Ms,
          coalescingDelayMaxMs: metrics.coalescingDelayMaxMs
        });
        this.outputChannel.debug('response stream presentation', metrics);
      };

      try {
        await streamResponseText({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        transport: config.transport,
        compatibilityProfile,
        identity: requestIdentity,
        turnState: branchState.turn.stickyState,
        authIdentity,
        extensionVersion: getExtensionVersion(this.context),
        userAgent: buildCodexUserAgent(getExtensionVersion(this.context)),
        websocketPrewarm: config.websocketPrewarm,
        requestCompression: config.requestCompression,
        previousResponseId,
        allowToolOutputContinuation,
        store: requestOptions.store,
        omitMaxOutputTokens: requestOptions.omitMaxOutputTokens,
        model: requestOptions.model,
        instructions: requestOptions.instructions,
        serviceTier: requestOptions.serviceTier,
        input: requestInput,
        tools: requestOptions.tools,
        toolMode: requestOptions.toolMode,
        reasoning: requestOptions.reasoning,
        maxOutputTokens: requestOptions.maxOutputTokens,
        token,
        onTextDelta: (text) => {
          presenter.push({
            kind: 'text',
            identity: 'text',
            text,
            emit: (presentedText) => {
              hasReportedText ||= presentedText.length > 0;
              progress.report(new vscode.LanguageModelTextPart(presentedText));
            }
          });
        },
        onReasoningTextDelta: ({ text, itemId, contentIndex }) => {
          if (hasReportedText) {
            return;
          }

          const identity = `reasoning:${itemId}:${contentIndex}`;
          const thinkingPartId = `${itemId}:${contentIndex}`;
          if (!createThinkingPart(text, thinkingPartId)) {
            return;
          }

          presenter.push({
            kind: 'reasoning',
            identity,
            text,
            emit: (presentedText) => {
              const thinkingPart = createThinkingPart(presentedText, thinkingPartId);
              if (thinkingPart) {
                progress.report(thinkingPart);
              }
            }
          });
        },
        onToolCallAdded: (callId) => {
          toolCallLifecycleAt.set(callId, { addedAt: Date.now() });
          latency.mark('firstToolCallAdded');
        },
        onToolCallArgumentsDelta: (callId) => {
          const lifecycle = toolCallLifecycleAt.get(callId) ?? {};
          lifecycle.argumentsDeltaAt ??= Date.now();
          toolCallLifecycleAt.set(callId, lifecycle);
          latency.mark('firstToolCallArgumentsDelta');
        },
        onToolCallArgumentsDone: (callId) => {
          const lifecycle = toolCallLifecycleAt.get(callId) ?? {};
          lifecycle.argumentsDoneAt ??= Date.now();
          toolCallLifecycleAt.set(callId, lifecycle);
          latency.mark('firstToolCallArgumentsDone');
        },
        onToolCall: (callId, name, toolInput) => {
          presenter.flushBoundary();
          reportedVisibleOutput = true;
          const reportedAt = Date.now();
          latency.mark('firstToolCall', reportedAt);
          recordFirstVisibleOutput('tool_call', reportedAt);
          progress.report(new vscode.LanguageModelToolCallPart(callId, name, toolInput));
          latency.mark('firstToolCallReported', reportedAt);
          this.rememberReportedToolCall(callId, name, reportedAt);
          reportedToolCallIds.add(callId);
          const lifecycle = toolCallLifecycleAt.get(callId);
          this.outputChannel.info('response tool call timing', {
            callId,
            name,
            toolArgumentsDoneToReportedMs: lifecycle?.argumentsDoneAt === undefined
              ? null
              : Math.max(0, reportedAt - lifecycle.argumentsDoneAt)
          });
          setImmediate(() => {
            try {
              const serializedToolInput = JSON.stringify(toolInput);
              this.outputChannel.debug('response tool call', {
                requestModel: selectedModel.requestModel,
                callId,
                name,
                inputPresent: true,
                inputBytes: Buffer.byteLength(serializedToolInput),
                inputHash: shortHash(serializedToolInput)
              });
            } catch {
              this.outputChannel.debug('response tool call telemetry unavailable', {
                requestModel: selectedModel.requestModel,
                callId,
                name
              });
            }
          });
        },
        onRawResponseItem: (item) => {
          rawResponseItems.push(item);
        },
        onTurnState: (turnState) => {
          branchState = {
            ...branchState,
            turn: { ...branchState.turn, stickyState: turnState },
            updatedAt: Date.now()
          };
        },
        onWebSocketHandshake: (handshake) => {
          this.outputChannel.debug('response websocket handshake', {
            turnStateReceived: Boolean(handshake.turnState),
            modelsEtagPresent: Boolean(handshake.modelsEtag),
            reasoningIncluded: handshake.reasoningIncluded,
            serverModel: handshake.serverModel ?? null
          });
        },
        onTransportMetrics: (metrics) => {
          previousResponseIdUsed ||= metrics.previousResponseIdUsed === true;
          if (typeof metrics.websocketConnectedAt === 'number') {
            latency.mark('websocketConnected', metrics.websocketConnectedAt);
          }
          if (typeof metrics.prewarmStartedAt === 'number') {
            latency.mark('prewarmStarted', metrics.prewarmStartedAt);
          }
          if (typeof metrics.prewarmCompletedAt === 'number') {
            latency.mark('prewarmCompleted', metrics.prewarmCompletedAt);
          }
          latency.recordContext(readLatencyContextFromTransportMetrics(metrics));
          this.outputChannel.debug('response transport metrics', metrics);
        },
        onResponseCreated: (response) => {
          createdResponseId = response.id ?? createdResponseId;
          latency.mark('responseCreated');
          this.outputChannel.debug('response created', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            status: response.status,
            serviceTier: response.service_tier ?? null,
            previousResponseId: previousResponseId ?? null
          });
        },
        onResponseCompleted: (response) => {
          this.markReportedToolCallsResponseCompleted(reportedToolCallIds);
          presenter.flushBoundary();
          recordPresentationMetrics();
          if (allowToolOutputContinuation && previousResponseIdUsed) {
            latency.recordContext({
              toolOutputContinuation: 'supported',
              toolContinuationStrategy: 'incremental',
              toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
                ? undefined
                : Math.max(0, Date.now() - toolContinuationProbeStartedAt)
            });
          }
          latency.mark('responseCompleted');
          branchState = {
            ...branchState,
            turn: { ...branchState.turn, completed: true },
            updatedAt: Date.now()
          };
          completedResponseId = response.id ?? completedResponseId;
          this.outputChannel.info('response completed', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            durationMs: Date.now() - requestStartedAt,
            streamDurationMs: Date.now() - streamStartedAt,
            actualTransport,
            firstVisibleOutputLatencyMs: firstVisibleOutput?.latencyMs ?? null,
            firstVisibleOutputKind: firstVisibleOutput?.kind ?? null,
            usage: response.usage ?? null,
            previousResponseId: previousResponseId ?? null
          });
          this.outputChannel.info('response latency', {
            ...latency.snapshot(),
            transportConfigured: config.transport
          });

          const usagePart = createUsageDataPart(response.usage);
          if (usagePart) {
            progress.report(usagePart);
          }

          if (response.usage) {
            this.usageSink?.record({
              model: selectedModel.requestModel,
              usage: response.usage,
              completedAt: Date.now()
            });
          }

          void this.accountUsageRefreshSink?.refresh();
        },
        onResponseFailed: (message) => {
          presenter.flushBoundary();
          recordPresentationMetrics();
          this.outputChannel.error(`response failed model=${selectedModel.requestModel} previousResponseId=${previousResponseId ?? 'none'} message=${message}`);
        },
        onTransportFallback: ({ from, to, reason }) => {
          actualTransport = 'http-fallback';
          latency.mark('connectionAcquired');
          latency.recordContext({ transportActual: actualTransport });
          this.outputChannel.warn('response transport fallback', {
            requestModel: selectedModel.requestModel,
            from,
            to,
            reason,
            previousResponseId: previousResponseId ?? null
          });
        },
        onWebSocketSession: ({ reused, origin }) => {
          actualTransport = reused ? 'websocket-reused' : 'websocket-fresh';
          latency.mark('connectionAcquired');
          latency.recordContext({
            connectionOrigin: origin ?? (reused ? 'previous-response' : 'fresh'),
            connectionReused: reused,
            transportActual: actualTransport
          });
          this.outputChannel.debug('response websocket session', {
            requestModel: selectedModel.requestModel,
            reused,
            previousResponseId: previousResponseId ?? null
          });
        }
        });
      } finally {
        presenter.flushBoundary();
        recordPresentationMetrics();
      }
      return { previousResponseIdUsed };
    };

    try {
      const initialStream = await streamRequest(
        initialRequestInput,
        initialPreviousResponseId,
        shouldAttemptToolOutputContinuation
      );
      if (shouldAttemptToolOutputContinuation && toolOutputContinuationCapabilityKey) {
        if (!initialStream.previousResponseIdUsed) {
          this.recordToolOutputContinuationCapability(toolOutputContinuationCapabilityKey, false);
          latency.recordContext({
            toolOutputContinuation: 'unsupported',
            toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
              ? undefined
              : Math.max(0, Date.now() - toolContinuationProbeStartedAt)
          });
          this.outputChannel.warn('response tool-output continuation was not applied', {
            requestModel: selectedModel.requestModel,
            branchId: reusableBranch?.branchId ?? null,
            previousResponseId: initialPreviousResponseId
          });
        } else {
          this.recordToolOutputContinuationCapability(toolOutputContinuationCapabilityKey, true);
          latency.recordContext({
            toolOutputContinuation: 'supported',
            toolContinuationStrategy: 'incremental',
            toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
              ? undefined
              : Math.max(0, Date.now() - toolContinuationProbeStartedAt)
          });
        }
      }
    } catch (error) {
      if (shouldAttemptToolOutputContinuation && isResponsesContinuationMissError(error)) {
        if (reportedVisibleOutput) {
          this.responseBranchStore.invalidateResponseId(error.previousResponseId);
          if (reusableBranch) {
            this.responseBranchStore.invalidate(reusableBranch.branchId);
          }
          throw error;
        }

        if (toolOutputContinuationCapabilityKey) {
          this.recordToolOutputContinuationCapability(toolOutputContinuationCapabilityKey, false);
        }
        latency.recordContext({
          toolOutputContinuation: 'fallback-full-replay',
          toolContinuationStrategy: 'incremental-recovered',
          toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
            ? undefined
            : Math.max(0, Date.now() - toolContinuationProbeStartedAt),
          fullReplayReason: 'continuation-miss'
        });
        this.outputChannel.warn('response tool-output continuation reset', {
          requestModel: selectedModel.requestModel,
          branchId: reusableBranch?.branchId ?? null,
          previousResponseId: initialPreviousResponseId,
          reason: error.message
        });

        createdResponseId = undefined;
        completedResponseId = undefined;
        rawResponseItems.length = 0;
        await streamRequest(input);
      } else {
        if (!initialPreviousResponseId || !isResponsesContinuationMissError(error)) {
          const unavailableModel = getExactModelNotFoundName(error, selectedModel.requestModel);
          if (!unavailableModel) {
            throw error;
          }

          this.markModelUnavailable(unavailableModel, config, credentials, authIdentity);

          this.outputChannel.warn('response model unavailable', {
            rejectedModel: unavailableModel,
            previousResponseId: initialPreviousResponseId ?? null
          });

          throw createTemporarilyUnavailableModelError(unavailableModel, error);
        }

        if (reportedVisibleOutput) {
          this.responseBranchStore.invalidateResponseId(error.previousResponseId);
          if (reusableBranch) {
            this.responseBranchStore.invalidate(reusableBranch.branchId);
          }
          throw error;
        }

        this.outputChannel.warn('response continuation reset', {
          requestModel: selectedModel.requestModel,
          branchId: reusableBranch?.branchId ?? null,
          previousResponseId: initialPreviousResponseId,
          reason: error.message,
          reuseDisabledUntilExpiry: error.disableReuseUntilExpiry
        });

        this.outputChannel.warn(error.disableReuseUntilExpiry
          ? 'response reuse disabled until branch cache expiry after HTTP continuation rejection'
          : 'response reuse temporarily disabled until next full-input success', {
          requestModel: selectedModel.requestModel,
          previousResponseId: initialPreviousResponseId,
          branchId: reusableBranch?.branchId ?? null
        });

        this.responseBranchStore.disableReuse(reuseEnvelope, !error.disableReuseUntilExpiry);
        this.responseBranchStore.invalidateResponseId(initialPreviousResponseId);

        if (reusableBranch) {
          this.responseBranchStore.invalidate(reusableBranch.branchId);
        }

        createdResponseId = undefined;
        completedResponseId = undefined;
        rawResponseItems.length = 0;
        activeBranchId = undefined;
        await streamRequest(input);
      }
    }

    const finalResponseId = completedResponseId ?? createdResponseId;
    if (finalResponseId) {
      const fullRequest = buildCodexResponsesRequest({
        ...requestOptions,
        identity: requestIdentity,
        input,
      });
      branchState = {
        ...branchState,
        continuation: createCodexContinuationSnapshot(
          fullRequest,
          finalResponseId,
          rawResponseItems,
          requestIdentity.turnId,
          {
            clone: false,
            requestFingerprint: reuseEnvelope.requestFingerprint
          }
        ),
        updatedAt: Date.now()
      };
      activeBranchId = this.responseBranchStore.recordSuccess(reuseEnvelope, input, finalResponseId, activeBranchId, branchState);
    }
  }

  private async resolveRequestIdentity(
    reusableState: CodexBranchState | undefined,
    forkState: CodexBranchState | undefined,
    appendedInput: readonly ResponsesInputMessage[]
  ): Promise<CodexRequestIdentity> {
    if (reusableState) {
      const current: CodexRequestIdentity = {
        ...reusableState.identity,
        turnId: reusableState.turn.id
      };
      const inCurrentWindow = this.identityManager.bindToCurrentWindow(current);
      return inputStartsNewTurn(appendedInput)
        ? this.identityManager.createNextTurn(inCurrentWindow)
        : inCurrentWindow;
    }
    const parentThreadId = forkState?.identity.threadId;
    return this.identityManager.createThread(parentThreadId);
  }

  private handleConnectionConfiguration(config: ProviderConfig, authIdentity: string): void {
    const key = stableSerialize({
      baseURL: normalizeBaseURL(config.baseURL),
      authIdentity,
      transport: config.transport,
      websocketPrewarm: config.websocketPrewarm,
      requestCompression: config.requestCompression
    });
    if (this.lastConnectionConfigurationKey && this.lastConnectionConfigurationKey !== key) {
      disposeReusableResponsesWebSockets();
      resetCodexFetchCapabilities();
    }
    this.lastConnectionConfigurationKey = key;
  }

  private scheduleWebSocketPreconnection(
    config: ProviderConfig,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    authIdentity: string
  ): void {
    if (config.transport === 'http') {
      return;
    }
    this.handleConnectionConfiguration(config, authIdentity);
    const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials);
    const started = compatibilityProfile.enabled && preconnectCodexResponsesWebSocket({
      baseURL: config.baseURL,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      compatibilityProfile,
      authIdentity,
      extensionVersion: getExtensionVersion(this.context),
      userAgent: buildCodexUserAgent(getExtensionVersion(this.context))
    });
    if (started) {
      this.outputChannel.debug('response WebSocket preconnection started', {
        baseURL: normalizeBaseURL(config.baseURL),
        transport: config.transport
      });
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);

    if (!credentials || !supportsOfficialTokenCounting(config.baseURL)) {
      const estimated = estimateTokenCount(text);
      this.outputChannel.debug('provideTokenCount local estimate', {
        modelId: model.id,
        requestModel: parseModelIdentifier(model.id || config.model).requestModel,
        count: estimated,
        reason: credentials ? 'unsupported-backend' : 'missing-credentials'
      });
      return estimated;
    }

    const availableModels = await this.getAvailableModels(config, credentials, token);
    const selectedModel = this.resolveRequestModel(model.id, config, availableModels);
    const input = typeof text === 'string' ? text : convertMessagesToResponsesInput([text]);
    const startedAt = Date.now();

    try {
      const count = await countInputTokens({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        authManager: credentials.authManager,
        model: selectedModel.requestModel,
        input,
        token
      });
      this.outputChannel.debug('provideTokenCount official count', {
        modelId: model.id,
        requestModel: selectedModel.requestModel,
        count,
        durationMs: Date.now() - startedAt
      });
      return count;
    } catch {
      const estimated = estimateTokenCount(text);
      this.outputChannel.warn('provideTokenCount fallback to local estimate', {
        modelId: model.id,
        requestModel: selectedModel.requestModel,
        count: estimated,
        durationMs: Date.now() - startedAt
      });
      return estimated;
    }
  }

  private async getAvailableModels(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken,
    onCacheState?: (state: CodexModelCacheState | 'fallback') => void
  ): Promise<ResolvedProviderModel[]> {
    const authIdentity = getCredentialIdentity(credentials);
    const cacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    try {
      const lookup = await this.modelCache.get(
        cacheKey,
        () => this.discoverAvailableModels(config, credentials, token, authIdentity)
      );
      this.outputChannel.debug('getAvailableModels cache result', {
        modelDiscoveryCacheState: lookup.state,
        modelCount: lookup.value.length,
        refreshStarted: lookup.refreshStarted
      });
      onCacheState?.(lookup.state);
      if (lookup.state === 'stale' && lookup.refreshStarted && lookup.refresh) {
        void lookup.refresh.then(
          () => this.modelInfoChangedEmitter.fire(),
          () => this.outputChannel.warn('getAvailableModels background refresh failed, retaining stale models', {
            modelDiscoveryCacheState: 'stale'
          })
        );
      }
      return lookup.value;
    } catch {
      const fallbackModels = this.applyModelDiscoveryPolicy([buildFallbackModel(config, credentials.kind)], config, authIdentity);
      this.modelCache.set(cacheKey, fallbackModels, {
        freshTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS,
        staleTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS
      });
      this.outputChannel.warn('getAvailableModels discovery failed, using fallback model', {
        fallbackModel: config.model
      });
      onCacheState?.('fallback');
      return fallbackModels;
    }
  }

  private async discoverAvailableModels(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken,
    authIdentity: string
  ): Promise<ResolvedProviderModel[]> {
    const upstreamModels = await fetchAvailableModels(config, credentials, token);
    const models = this.applyModelDiscoveryPolicy(buildProviderModels(config, upstreamModels, credentials.kind), config, authIdentity);
    this.outputChannel.info('getAvailableModels discovery success', {
      discoveredCount: upstreamModels.length,
      returnedCount: models.length,
      requestModels: models.map((model) => model.requestModel)
    });
    return models;
  }

  private markModelUnavailable(
    model: string,
    config: ProviderConfig,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    authIdentity: string
  ): void {
    this.runtimeAvailability.markTemporarilyUnavailable(model, config, authIdentity);
    const cacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    this.modelCache.invalidate(cacheKey);
    this.modelInfoChangedEmitter.fire();
    this.outputChannel.warn('model marked unavailable after responses rejection', {
      model,
      transport: config.transport,
      authIdentity,
      baseURL: normalizeBaseURL(config.baseURL)
    });
    void this.getAvailableModels(config, credentials, NON_CANCELLABLE_TOKEN).then(
      () => this.modelInfoChangedEmitter.fire(),
      () => this.outputChannel.warn('model refresh failed after responses model rejection', { model })
    );
  }

  private rememberReportedToolCall(callId: string, name: string, reportedAt = Date.now()): void {
    this.pruneReportedToolCalls(reportedAt);
    this.pendingReportedToolCalls.set(callId, { callId, name, reportedAt });

    while (this.pendingReportedToolCalls.size > MAX_PENDING_REPORTED_TOOL_CALLS) {
      const oldestCallId = this.pendingReportedToolCalls.keys().next().value;
      if (typeof oldestCallId !== 'string') {
        return;
      }
      this.pendingReportedToolCalls.delete(oldestCallId);
    }
  }

  private markReportedToolCallsResponseCompleted(callIds: ReadonlySet<string>, completedAt = Date.now()): void {
    for (const callId of callIds) {
      const reportedCall = this.pendingReportedToolCalls.get(callId);
      if (reportedCall) {
        reportedCall.responseCompletedAt = completedAt;
      }
    }
  }

  private consumeReportedToolResults(input: readonly ResponsesInputMessage[]): ObservedToolResult[] {
    const now = Date.now();
    this.pruneReportedToolCalls(now);
    const observed = [];

    for (const item of input) {
      if (item.type !== 'function_call_output') {
        continue;
      }

      const reportedCall = this.pendingReportedToolCalls.get(item.call_id);
      if (!reportedCall) {
        continue;
      }

      this.pendingReportedToolCalls.delete(item.call_id);
      observed.push({
        callId: reportedCall.callId,
        name: reportedCall.name,
        reportedToResultObservedMs: Math.max(0, now - reportedCall.reportedAt),
        responseCompletedToResultObservedMs: reportedCall.responseCompletedAt === undefined
          ? undefined
          : Math.max(0, now - reportedCall.responseCompletedAt),
        resultBytes: Buffer.byteLength(stableSerialize(item.output)),
        resultObservedAt: now
      });
    }

    return observed;
  }

  private pruneReportedToolCalls(now: number): void {
    for (const [callId, reportedCall] of this.pendingReportedToolCalls) {
      if (now - reportedCall.reportedAt > REPORTED_TOOL_CALL_TTL_MS) {
        this.pendingReportedToolCalls.delete(callId);
      }
    }
  }

  private createToolOutputContinuationCapabilityKey(
    config: ProviderConfig,
    authIdentity: string,
    model: string,
    store: boolean
  ): string {
    return [normalizeBaseURL(config.baseURL), authIdentity, model, store ? 'store' : 'no-store'].join('|');
  }

  private getToolOutputContinuationCapability(key: string): boolean | undefined {
    const capability = this.toolOutputContinuationCapabilities.get(key);
    if (!capability) {
      return undefined;
    }
    if (Date.now() - capability.observedAt > TOOL_OUTPUT_CONTINUATION_CAPABILITY_TTL_MS) {
      this.toolOutputContinuationCapabilities.delete(key);
      return undefined;
    }
    return capability.supported;
  }

  private recordToolOutputContinuationCapability(key: string, supported: boolean): void {
    this.toolOutputContinuationCapabilities.set(key, { supported, observedAt: Date.now() });
    while (this.toolOutputContinuationCapabilities.size > MAX_TOOL_OUTPUT_CONTINUATION_CAPABILITIES) {
      const oldestKey = this.toolOutputContinuationCapabilities.keys().next().value;
      if (typeof oldestKey !== 'string') {
        return;
      }
      this.toolOutputContinuationCapabilities.delete(oldestKey);
    }
  }

  private resolveRequestModel(
    modelId: string | undefined,
    config: ProviderConfig,
    availableModels: readonly ResolvedProviderModel[]
  ): ParsedModelIdentifier {
    const parsedModel = parseModelIdentifier(modelId || config.model);
    const exactAvailableModel = modelId
      ? availableModels.find((candidate) => candidate.info.id === modelId)
      : undefined;
    const requestedModel = {
      requestModel: exactAvailableModel?.requestModel ?? parsedModel.requestModel,
      reasoningEffort: parsedModel.reasoningEffort
    };
    const availableModelNames = new Set(availableModels.map((candidate) => candidate.requestModel));

    const aliasedModel = this.resolveModelAlias(requestedModel.requestModel, config.modelAliases, availableModels);
    if (aliasedModel) {
      this.outputChannel.warn('request model remapped from configured model alias', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: aliasedModel.requestModel
      });
      return {
        requestModel: aliasedModel.requestModel,
        reasoningEffort: requestedModel.reasoningEffort
      };
    }

    if (availableModelNames.has(requestedModel.requestModel)) {
      return requestedModel;
    }

    const prefixMatch = availableModels
      .map((candidate) => candidate.requestModel)
      .filter((candidate) => requestedModel.requestModel.startsWith(`${candidate}-`))
      .sort((left, right) => right.length - left.length)[0];

    if (prefixMatch) {
      this.outputChannel.warn('request model remapped from stale model identifier', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: prefixMatch
      });
      return {
        requestModel: prefixMatch,
        reasoningEffort: requestedModel.reasoningEffort
      };
    }

    if (availableModelNames.has(config.model)) {
      this.outputChannel.warn('request model fell back to configured model', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: config.model
      });
      return {
        requestModel: config.model,
        reasoningEffort: requestedModel.reasoningEffort
      };
    }

    const fallbackModel = availableModels[0]?.requestModel ?? config.model;
    this.outputChannel.warn('request model fell back to first available model', {
      requestedModelId: modelId ?? null,
      requestedModel: requestedModel.requestModel,
      resolvedModel: fallbackModel
    });
    return {
      requestModel: fallbackModel,
      reasoningEffort: requestedModel.reasoningEffort
    };
  }

  private resolveDirectRequestModel(
    modelId: string | undefined,
    config: ProviderConfig,
    authIdentity: string
  ): ParsedModelIdentifier | undefined {
    if (!isProviderModelIdentifier(modelId)) {
      return undefined;
    }

    const requestedModel = parseModelIdentifier(modelId);
    const alias = config.modelAliases[requestedModel.requestModel];
    const resolvedModel = alias
      ? { ...requestedModel, requestModel: alias }
      : requestedModel;
    const unavailableModels = new Set([
      ...config.disabledModels,
      ...this.runtimeAvailability.getTemporarilyUnavailableModels(config, authIdentity)
    ]);
    if (unavailableModels.has(resolvedModel.requestModel)) {
      return undefined;
    }

    if (alias) {
      this.outputChannel.warn('request model remapped from configured model alias', {
        requestedModelId: modelId,
        requestedModel: requestedModel.requestModel,
        resolvedModel: alias
      });
    }
    return resolvedModel;
  }

  private applyModelDiscoveryPolicy(models: ResolvedProviderModel[], config: ProviderConfig, authIdentity: string): ResolvedProviderModel[] {
    const disabledModels = new Set([
      ...config.disabledModels,
      ...this.runtimeAvailability.getTemporarilyUnavailableModels(config, authIdentity)
    ]);
    const availableModelNames = new Set(models.map((model) => model.requestModel));
    const aliasedSources = new Set(
      Object.entries(config.modelAliases)
        .filter(([, target]) => availableModelNames.has(target))
        .map(([source]) => source)
    );
    const filteredModels = models.filter((model) => !disabledModels.has(model.requestModel) && !aliasedSources.has(model.requestModel));

    if (filteredModels.length === 0) {
      this.outputChannel.warn('model discovery policy kept original models because every discovered model was filtered', {
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
      return models;
    }

    if (filteredModels.length !== models.length) {
      this.outputChannel.info('model discovery policy filtered models', {
        before: models.map((model) => model.requestModel),
        after: filteredModels.map((model) => model.requestModel),
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
    }

    return filteredModels;
  }

  private resolveModelAlias(
    model: string,
    modelAliases: Record<string, string>,
    availableModels: readonly ResolvedProviderModel[]
  ): ResolvedProviderModel | undefined {
    const targetModel = modelAliases[model];
    if (!targetModel) {
      return undefined;
    }

    return availableModels.find((candidate) => candidate.requestModel === targetModel);
  }
}

class RuntimeModelAvailability {
  private readonly temporarilyUnavailableModels = new Map<string, number>();

  markTemporarilyUnavailable(model: string, config: ProviderConfig, authIdentity: string): void {
    this.evictExpiredEntries();
    this.temporarilyUnavailableModels.set(this.getScopeKey(model, config, authIdentity), Date.now() + 10 * 60 * 1000);
  }

  getTemporarilyUnavailableModels(config: ProviderConfig, authIdentity: string): string[] {
    this.evictExpiredEntries();
    const scopePrefix = this.getScopePrefix(config, authIdentity);
    return [...this.temporarilyUnavailableModels.keys()]
      .filter((entry) => entry.startsWith(scopePrefix))
      .map((entry) => entry.slice(scopePrefix.length));
  }

  private evictExpiredEntries(): void {
    const now = Date.now();
    for (const [modelKey, expiresAt] of this.temporarilyUnavailableModels.entries()) {
      if (expiresAt <= now) {
        this.temporarilyUnavailableModels.delete(modelKey);
      }
    }
  }

  private getScopeKey(model: string, config: ProviderConfig, authIdentity: string): string {
    return `${this.getScopePrefix(config, authIdentity)}${model}`;
  }

  private getScopePrefix(config: ProviderConfig, authIdentity: string): string {
    return `${normalizeBaseURL(config.baseURL)}|${authIdentity}|${config.transport}|`;
  }
}

function getExactModelNotFoundName(error: unknown, expectedModel: string): string | undefined {
  const message = getModelNotFoundMessage(error);
  if (message !== expectedModel) {
    return undefined;
  }

  return message;
}

function getModelNotFoundMessage(error: unknown): string | undefined {
  for (const message of collectErrorMessages(error)) {
    const match = /Model not found\s+([^"\s:}]+)/i.exec(message);
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
      const record = value as { message?: unknown; cause?: unknown; error?: unknown };
      if (typeof record.message === 'string') {
        messages.push(record.message);
      }
      visit(record.cause);
      visit(record.error);
    }
  };

  visit(error);
  return messages;
}

function buildModelCacheKey(
  config: ProviderConfig,
  credentialSource: string,
  credentialKind: string,
  authIdentity: string
): string {
  return [
    config.baseURL,
    config.clientVersion,
    config.credentialsSource,
    config.transport,
    config.model,
    config.includeHiddenModels,
    config.disabledModels.join(','),
    stableSerialize(config.modelAliases),
    config.defaultServiceTier ?? 'auto',
    config.defaultReasoningEffort ?? 'auto',
    config.maxOutputTokens,
    credentialSource,
    credentialKind,
    authIdentity
  ].join('|');
}

function getRequestServiceTier(serviceTier: ProviderConfig['defaultServiceTier']): 'default' | 'priority' | undefined {
  switch (serviceTier) {
    case 'default':
      return 'default';
    case 'fast':
      return 'priority';
    default:
      return undefined;
  }
}

function buildCodexUserAgent(extensionVersion: string): string {
  return `codex-for-copilot/${extensionVersion} (${process.platform}; ${process.arch}; vscode/${vscode.version})`;
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const extension = (context as vscode.ExtensionContext & {
    extension?: { packageJSON?: { version?: unknown } };
  }).extension;
  return typeof extension?.packageJSON?.version === 'string' ? extension.packageJSON.version : '0.0.0';
}

function createMemoryMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue as T,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
}

export function getReasoningEffort(
  selectedReasoningEffort: ReasoningEffort | undefined,
  options: RuntimeProvideLanguageModelChatResponseOptions,
  defaultReasoningEffort: ReasoningEffort | undefined
): ReasoningEffortResolution {
  const modelOptions = options.modelOptions;
  const thinking = modelOptions?.thinking as { effort?: unknown } | undefined;
  const explicitCandidates: Array<{ effort: ReasoningEffort | undefined; source: ReasoningEffortSource }> = [
    { effort: normalizeReasoningEffort(modelOptions?.reasoningEffort), source: 'modelOptions.reasoningEffort' },
    { effort: normalizeReasoningEffort(modelOptions?.thinkingEffort), source: 'modelOptions.thinkingEffort' },
    { effort: normalizeReasoningEffort((modelOptions?.reasoning as { effort?: unknown } | undefined)?.effort), source: 'modelOptions.reasoning.effort' },
    { effort: normalizeReasoningEffort(thinking?.effort), source: 'modelOptions.thinking.effort' },
    { effort: normalizeReasoningEffort(modelOptions?.thinking), source: 'modelOptions.thinking' },
    { effort: normalizeReasoningEffort(options.modelConfiguration?.reasoningEffort), source: 'modelConfiguration' },
    { effort: normalizeReasoningEffort(options.configuration?.reasoningEffort), source: 'configuration' }
  ].filter((candidate): candidate is { effort: ReasoningEffort; source: ReasoningEffortSource } => candidate.effort !== undefined);
  const selected = explicitCandidates[0];
  const hasExplicitConflict = new Set(explicitCandidates.map((candidate) => candidate.effort)).size > 1;

  if (selected) {
    return { ...selected, hasExplicitConflict };
  }

  if (defaultReasoningEffort) {
    return { effort: defaultReasoningEffort, source: 'default', hasExplicitConflict };
  }

  if (selectedReasoningEffort) {
    return { effort: selectedReasoningEffort, source: 'model', hasExplicitConflict };
  }

  return { effort: undefined, source: 'none', hasExplicitConflict };
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function supportsOfficialTokenCounting(baseURL: string): boolean {
  const normalizedBaseURL = normalizeBaseURL(baseURL).toLowerCase();
  return !normalizedBaseURL.includes('chatgpt.com/backend-api/codex');
}

function createThinkingPart(text: string, id?: string): vscode.LanguageModelResponsePart | undefined {
  const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
  if (typeof ThinkingPart !== 'function') {
    return undefined;
  }

  return new ThinkingPart(text, id) as vscode.LanguageModelResponsePart;
}

function createUsageDataPart(usage: ResponseUsage | null | undefined): vscode.LanguageModelResponsePart | undefined {
  if (!usage) {
    return undefined;
  }

  return vscode.LanguageModelDataPart.json(
    {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0
      },
      completion_tokens_details: {
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0
      }
    },
    USAGE_DATA_PART_MIME
  ) as vscode.LanguageModelResponsePart;
}

function createTemporarilyUnavailableModelError(model: string, cause: unknown): Error {
  const error = new Error(`Model ${model} is listed by discovery but is not currently callable through the configured Codex Responses backend. It has been hidden temporarily from the model picker. Choose another model and retry.`);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export function buildResponseBranchReuseEnvelope(options: {
  baseURL: string;
  authIdentity: string;
  toolSignatures?: ResponseBranchToolSignatures;
  effectiveInputBudget?: number;
} & CodexRequestEnvelopeOptions): ResponseBranchReuseEnvelope {
  const { baseURL, authIdentity, toolSignatures, effectiveInputBudget, ...requestOptions } = options;
  const requestFingerprint = fingerprintCodexRequestEnvelope(requestOptions);
  const scopeKey = stableSerialize({ baseURL, authIdentity });
  return {
    identityKey: stableSerialize({
      scopeKey,
      requestFingerprint
    }),
    scopeKey,
    requestFingerprint,
    effectiveInputBudget,
    toolSignatures: toolSignatures ?? buildResponseBranchToolSignatures(requestOptions.tools)
  };
}

export function buildResponseBranchToolSignatures(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ResponseBranchToolSignatures {
  return resolveCodexToolSchemas(tools).toolSignatures;
}

function getToolModeName(toolMode: vscode.LanguageModelChatToolMode | undefined): 'auto' | 'required' | null {
  if (toolMode === undefined) {
    return null;
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Required) {
    return 'required';
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Auto) {
    return 'auto';
  }
  return null;
}

function summarizeToolNames(tools: readonly vscode.LanguageModelChatTool[] | undefined): readonly string[] {
  return Object.freeze([...(tools ?? [])].map((tool) => tool.name).sort());
}

function getCredentialIdentity(credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>): string {
  const accountId = credentials.headers['ChatGPT-Account-ID'];
  const credentialHash = createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 16);
  if (typeof accountId === 'string' && accountId.length > 0) {
    return `${credentials.source}:${accountId}:${credentialHash}`;
  }

  return `${credentials.source}:${credentialHash}`;
}

function readLatencyContextFromTransportMetrics(metrics: Record<string, unknown>): CodexLatencyContext {
  const prewarmResult = readPrewarmResult(metrics.prewarmResult);
  const previousResponseIdUsed = typeof metrics.previousResponseIdUsed === 'boolean'
    ? metrics.previousResponseIdUsed
    : undefined;

  return {
    connectionOrigin: prewarmResult === 'success' ? 'prewarm' : undefined,
    connectionReused: typeof metrics.connectionReused === 'boolean' ? metrics.connectionReused : undefined,
    previousResponseIdUsed,
    incrementalInputCount: previousResponseIdUsed === true
      ? readNonNegativeInteger(metrics.incrementalInputCount)
      : undefined,
    requestBodyBytes: readNonNegativeInteger(metrics.requestBodyBytes),
    websocketSerializeMs: readNonNegativeNumber(metrics.websocketSerializeMs),
    prewarmResult
  };
}

function readPrewarmResult(value: unknown): CodexLatencyContext['prewarmResult'] {
  switch (value) {
    case 'success':
    case 'timed-out':
    case 'disabled-after-failure':
    case 'skipped-auto':
      return value;
    default:
      return undefined;
  }
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
