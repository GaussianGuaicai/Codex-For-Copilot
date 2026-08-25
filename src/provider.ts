import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { NamespaceTool, ResponseReasoningItem, ResponseUsage } from 'openai/resources/responses/responses';
import {
  compareResponsesInputHistory,
  createStatefulMarkerPayload,
  convertMessagesToResponsesInput,
  convertMessagesToResponsesInputWithStatefulMarker,
  estimateTokenCount,
  STATEFUL_MARKER_DATA_PART_MIME,
  stableSerialize,
  type ResponsesInputMessage
} from './convertMessages';
import { getProviderConfig, type ProviderConfig } from './config';
import { buildFallbackModel, buildProviderModels, fetchAvailableModels, isProviderModelIdentifier, parseModelIdentifier, type ParsedModelIdentifier, type ResolvedProviderModel } from './models';
import {
  resolveReasoningEffort,
  toResponsesReasoning,
  type ReasoningEffort,
  type ReasoningEffortResolution
} from './reasoningEffort';
import {
  countInputTokens,
  disposeReusableResponsesWebSockets,
  isResponsesContinuationMissError,
  normalizeBaseURL,
  preconnectCodexResponsesWebSocket,
  streamResponseText
} from './responsesClient';
import {
  ResponseBranchStore,
  type ResponseBranchReuseEnvelope,
  type ResponseBranchToolSignatures
} from './responseBranchStore';
import { getApiCredentials } from './secrets';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { CodexIdentityManager, inputStartsNewTurn } from './codexIdentity';
import { getCodexCompatibilityProfile, type CodexRequestIdentity } from './codexProtocol';
import { resetCodexFetchCapabilities } from './codexFetchAdapter';
import {
  buildCodexResponsesRequest,
  fingerprintCodexRequestEnvelope,
  type CodexRequestEnvelopeOptions
} from './codexRequestBuilder';
import type { CodexBranchState } from './responseBranchStore';
import { shortHash } from './codexTelemetry';
import { type CodexLogSink, CodexLogger, createCodexLogger } from './codexLogger';
import { CodexLatencyRecorder, type CodexLatencyContext } from './codexLatency';
import { createCodexContinuationSnapshot } from './codexContinuation';
import { resolveCodexToolSchemas } from './codexToolSchemaCache';
import { resolveCodexToolPlan } from './nativeToolSearch/nativeToolCatalog';
import { mapNativeToolCall } from './nativeToolSearch/nativeToolCallMapper';
import { createToolCallMappingKey, type CodexToolPlan } from './nativeToolSearch/nativeToolTypes';
import { hasNativeToolGroupingBridgeOwnership } from './nativeToolSearch/nativeToolGroupingBridge';
import {
  canUseNativeToolSearch,
  isNativeToolSearchUnsupportedError,
  markNativeToolSearchUnsupported,
  nativeToolSearchCapabilityKey
} from './nativeToolSearch/nativeToolCapabilities';
import { getVirtualToolPlaceholderNames } from './nativeToolSearch/nativeToolPolicy';
import { buildCanonicalReplayInput, createCanonicalReplayRequest } from './nativeToolSearch/nativeToolReplay';
import { summarizeNativeToolSearchItem } from './nativeToolSearch/nativeToolLogging';
import { recordNativeToolSearchRuntimeStatus } from './nativeToolSearch/nativeToolSearchStatus';
import { StreamPresenter, mergeStreamPresentationMetrics } from './streamPresenter';
import { ReasoningStreamPresenter } from './reasoningStreamPresenter';
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

interface ResolvedRequestModel extends ParsedModelIdentifier {
  effectiveInputBudget?: number;
}

interface ProviderModelCatalog {
  models: ResolvedProviderModel[];
  authoritative: boolean;
}

type ModelAliasResolution =
  | { kind: 'none' }
  | { kind: 'target'; targetModel: string }
  | { kind: 'cycle' };

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string, metadata?: { readonly [key: string]: any }) => unknown;
};

const USAGE_DATA_PART_MIME = 'usage';
const MODEL_DISCOVERY_FALLBACK_TTL_MS = 60_000;
const TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS = 10 * 60_000;
const REPORTED_TOOL_CALL_TTL_MS = 10 * 60_000;
const MAX_PENDING_REPORTED_TOOL_CALLS = 200;
const TOOL_OUTPUT_CONTINUATION_CAPABILITY_TTL_MS = 30 * 60_000;
const MAX_TOOL_OUTPUT_CONTINUATION_CAPABILITIES = 64;
const MAX_LOCAL_TOKEN_ESTIMATE_DIAGNOSTICS = 64;
const STATEFUL_MARKER_LOCAL_ERROR = 'Stateful continuation marker could not be resolved locally.';
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
  private readonly localTokenEstimateDiagnostics = new Set<string>();
  private readonly modelCache = new CodexModelCache<ProviderModelCatalog>({
    freshTtlMs: MODEL_CACHE_FRESH_TTL_MS,
    staleTtlMs: MODEL_CACHE_STALE_TTL_MS
  });
  private lastConnectionConfigurationKey?: string;
  private lastVirtualToolFallbackSignature?: string;
  private readonly logger: CodexLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    logger: CodexLogger | CodexLogSink,
    private readonly usageSink?: UsageSink,
    private readonly accountUsageRefreshSink?: AccountUsageRefreshSink,
    private readonly selectedModelSink?: SelectedModelSink,
    private readonly authManager?: CodexAuthManager
  ) {
    this.logger = logger instanceof CodexLogger ? logger : createCodexLogger(logger, 'provider');
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
          this.localTokenEstimateDiagnostics.clear();
          this.modelCache.clear();
          this.modelInfoChangedEmitter.fire();
        }
      })
    );
  }

  // Keeps the existing provider diagnostics compact while routing every event
  // through the safe structured logger.
  private get outputChannel(): CodexLogger {
    return this.logger;
  }

  handleAuthenticationChanged(): void {
    disposeReusableResponsesWebSockets();
    resetCodexFetchCapabilities();
    this.lastConnectionConfigurationKey = undefined;
    this.localTokenEstimateDiagnostics.clear();
    this.modelCache.clear();
    this.modelInfoChangedEmitter.fire();
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

    const { models } = await this.getAvailableModelCatalog(config, credentials, token);
    this.scheduleWebSocketPreconnection(config, credentials, getCredentialIdentity(credentials));
    this.outputChannel.debug('provideLanguageModelChatInformation complete', {
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
    const requestLogger = this.logger.operation('chat.response');
    const latency = new CodexLatencyRecorder();
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);
    latency.mark('credentialsResolved');

    if (!credentials) {
      throw new Error('Codex credentials are missing. Run "Codex for Copilot: Import Codex auth.json".');
    }

    const convertedMessages = convertMessagesToResponsesInputWithStatefulMarker(messages);
    if (convertedMessages.statefulMarker.kind === 'invalid'
      && convertedMessages.statefulMarker.isLeadingStandalone) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }
    if (convertedMessages.statefulMarker.kind === 'valid'
      && convertedMessages.statefulMarker.isLeadingStandalone
      && convertedMessages.statefulMarker.modelId !== model.id) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }

    const authIdentity = getCredentialIdentity(credentials);
    this.handleConnectionConfiguration(config, authIdentity);
    const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials, config.protocol.profile);
    const modelCacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    const cachedCatalog = this.modelCache.peek(modelCacheKey);
    const directModel = cachedCatalog?.authoritative
      ? undefined
      : this.resolveDirectRequestModel(model, config, authIdentity);
    let selectedModel: ResolvedRequestModel;
    if (directModel) {
      selectedModel = directModel;
      latency.recordContext({ modelDiscoveryCacheState: 'direct' });
      requestLogger.debug('request model resolved from provider model id', {
        modelId: model.id,
        requestModel: selectedModel.requestModel
      });
    } else {
      const catalog = await this.getAvailableModelCatalog(config, credentials, token, (state) => {
        latency.recordContext({ modelDiscoveryCacheState: state });
      });
      selectedModel = this.resolveRequestModel(model.id, config, catalog.models, catalog.authoritative);
    }
    selectedModel = {
      ...selectedModel,
      effectiveInputBudget: resolveConfiguredContextSize(
        selectedModel.effectiveInputBudget,
        model,
        options as RuntimeProvideLanguageModelChatResponseOptions
      )
    };
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
    const input = convertedMessages.input;
    const observedToolResults = this.consumeReportedToolResults(input);
    latency.mark('messagesConverted');
    const requestBuildStartedAt = performance.now();
    const nativeToolSearchKey = nativeToolSearchCapabilityKey(
      normalizeBaseURL(config.baseURL), authIdentity, selectedModel.requestModel
    );
    let toolPlan = resolveCodexToolPlan({
      tools: options.tools,
      model: selectedModel.requestModel,
      compatibilityEnabled: compatibilityProfile.enabled,
      nativeToolSearch: config.nativeToolSearch,
      maxToolsPerNamespace: config.nativeToolSearchMaxToolsPerNamespace,
      extensions: (vscode as typeof vscode & { extensions?: { all?: readonly vscode.Extension<any>[] } }).extensions?.all ?? [],
      nativeToolSearchSupported: canUseNativeToolSearch(selectedModel.requestModel, nativeToolSearchKey)
    });
    const virtualToolPlaceholderNames = getVirtualToolPlaceholderNames(options.tools);
    if (virtualToolPlaceholderNames.length > 0) {
      this.outputChannel.warn('native Tool Search falling back to VS Code Virtual Tools', {
        virtualPlaceholderCount: virtualToolPlaceholderNames.length,
        virtualToolPlaceholderNames
      });
      this.notifyVirtualToolFallback(
        config.nativeToolSearch,
        hasNativeToolGroupingBridgeOwnership(this.context),
        virtualToolPlaceholderNames
      );
    } else {
      this.lastVirtualToolFallbackSignature = undefined;
    }
    recordNativeToolSearchRuntimeStatus({
      model: selectedModel.requestModel,
      setting: config.nativeToolSearch,
      plan: toolPlan,
      virtualToolPlaceholderCount: virtualToolPlaceholderNames.length
    });
    if (toolPlan.mode === 'native-hosted') {
      this.outputChannel.debug('native Tool Search plan', {
        requestModel: selectedModel.requestModel,
        catalogHash: toolPlan.catalogHash,
        nativeToolCatalogCacheHit: toolPlan.nativeToolCatalogCacheHit,
        immediateFunctionCount: toolPlan.immediateToolCount,
        deferredFunctionCount: toolPlan.deferredToolCount,
        includesToolSearch: toolPlan.responseTools.some((tool) => tool.type === 'tool_search'),
        namespaces: toolPlan.responseTools.flatMap((tool) => {
          if (tool.type !== 'namespace') {
            return [];
          }
          return [{
            name: tool.name,
            functionCount: tool.tools.length,
            deferredFunctionCount: tool.tools.filter((nestedTool) => nestedTool.defer_loading === true).length,
            // Names make a private/workspace namespace auditable without exposing
            // its schemas, arguments, or tool results in the extension log.
            functionNames: tool.tools.map((nestedTool) => nestedTool.name)
          }];
        })
      });
    }
    let requestOptions: CodexRequestEnvelopeOptions = {
      compatibilityEnabled: compatibilityProfile.enabled,
      model: selectedModel.requestModel,
      instructions: combineRequestInstructions(config.instructions, convertedMessages.systemInstructions),
      tools: options.tools,
      toolPlan,
      toolMode: options.toolMode,
      reasoning: reasoningEffort ? toResponsesReasoning(reasoningEffort) : undefined,
      serviceTier: getRequestServiceTier(config.defaultServiceTier),
      store: false,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens,
      textVerbosity: 'medium',
      includeEncryptedReasoning: true,
      protocolSettings: config.protocol
    };
    const toolSchemas = toolPlan;
    latency.recordContext({
      fullInputCount: input.length,
      toolCount: options.tools?.length ?? 0,
      toolSchemaBytes: toolSchemas.toolSchemaBytes,
      legacyToolSchemaCacheHit: toolPlan.legacyToolSchemaCacheHit,
      nativeToolCatalogCacheHit: toolPlan.nativeToolCatalogCacheHit,
      toolPlanMode: toolPlan.mode,
      originalToolCount: toolPlan.originalToolCount,
      immediateToolCount: toolPlan.immediateToolCount,
      deferredToolCount: toolPlan.deferredToolCount,
      namespaceCount: toolPlan.namespaceCount,
      catalogHash: toolPlan.catalogHash,
      reasoningEffort: reasoningEffort ?? null,
      serviceTier: config.defaultServiceTier ?? 'auto'
    });
    let reuseEnvelope = buildResponseBranchReuseEnvelope({
      baseURL: normalizeBaseURL(config.baseURL),
      authIdentity,
      toolSignatures: toolPlan.toolSignatures,
      effectiveInputBudget: selectedModel.effectiveInputBudget,
      ...requestOptions
    });
    latency.recordContext({ requestBuildMs: Math.max(0, performance.now() - requestBuildStartedAt) });
    const markerHint = convertedMessages.statefulMarker.kind === 'valid'
      && convertedMessages.statefulMarker.isLeadingStandalone
      ? {
          responseId: convertedMessages.statefulMarker.previousResponseId,
          incrementalInput: convertedMessages.statefulMarker.incrementalInput
        }
      : undefined;
    const candidateReusableBranch = convertedMessages.statefulMarker.kind === 'none'
      ? this.responseBranchStore.findReusableBranch(reuseEnvelope, input)
      : markerHint
        ? this.responseBranchStore.findReusableBranch(reuseEnvelope, input, markerHint)
        : undefined;
    const reusableBranch = markerHint || !candidateReusableBranch
      ? candidateReusableBranch
      : hasExactLocalBranchHistory(
          candidateReusableBranch.state?.continuation,
          input,
          candidateReusableBranch.comparison.appendedInput
        )
        ? candidateReusableBranch
        : undefined;
    if (markerHint && !reusableBranch) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }
    const reuseMissDiagnostic = reusableBranch || convertedMessages.statefulMarker.kind !== 'none'
      ? undefined
      : this.responseBranchStore.explainReuseMiss(reuseEnvelope, input);
    latency.mark('branchResolved');
    const requiresFullInputForToolOutput = Boolean(
      reusableBranch?.comparison.appendedInput.some((item) => item.type === 'function_call_output')
    );
    const appendedInput = reusableBranch?.comparison.appendedInput ?? [];
    const isMarkerContinuation = Boolean(markerHint && reusableBranch);
    const markerContinuationSnapshot = isMarkerContinuation
      ? reusableBranch?.state?.continuation
      : undefined;
    if (isMarkerContinuation && (!markerContinuationSnapshot
      || !hasCanonicalReplayContinuationIntegrity(markerContinuationSnapshot.responseItems, appendedInput))) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }
    const markerCanonicalReplayInput = isMarkerContinuation
      ? buildCanonicalReplayInput({
          previousSnapshot: markerContinuationSnapshot,
          convertedInput: input,
          appendedInput
        })
      : undefined;
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
    const canonicalReplaySnapshot = reusableBranch?.state?.continuation;
    const canonicalReplayAppendedInput = reusableBranch?.comparison.appendedInput ?? [];
    const fullReplayInput = toolPlan.mode === 'native-hosted'
      ? buildCanonicalReplayInput({
          previousSnapshot: canonicalReplaySnapshot,
          convertedInput: input,
          appendedInput: canonicalReplayAppendedInput,
          catalogHash: toolPlan.catalogHash
        })
      : input;
    const recoveryReplayInput = markerCanonicalReplayInput ?? fullReplayInput;
    const initialRequestInput = usePreviousResponseId
      ? appendedInput
      : recoveryReplayInput;
    const initialPreviousResponseId = usePreviousResponseId
      ? reusableBranch?.responseId
      : undefined;
    let activeBranchId = initialPreviousResponseId || requiresFullInputForToolOutput
      ? reusableBranch?.branchId
      : undefined;
    let legacyFallbackReplayInput: ResponsesInputMessage[] | undefined;
    let completedResponseId: string | undefined;
    const replayResponseItems: unknown[] = [];
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
        parentThreadId: requestIdentity.parentThreadId,
        parentTurnId: requestIdentity.parentTurnId,
        rootTurnId: requestIdentity.rootTurnId
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

    requestLogger.debug('provideLanguageModelChatResponse start', {
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
      this.outputChannel.debug('response reuse miss', {
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
      let pendingResponseText = '';
      const attemptInitialBranchState: CodexBranchState = {
        ...branchState,
        identity: { ...branchState.identity },
        turn: { ...branchState.turn }
      };
      const resetAttemptState = () => {
        replayResponseItems.length = 0;
        pendingResponseText = '';
        completedResponseId = undefined;
        branchState = {
          ...attemptInitialBranchState,
          identity: { ...attemptInitialBranchState.identity },
          turn: { ...attemptInitialBranchState.turn, completed: false },
          updatedAt: Date.now()
        };
      };
      const flushReplayText = () => {
        if (!pendingResponseText) {
          return;
        }
        replayResponseItems.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: pendingResponseText }]
        });
        pendingResponseText = '';
      };
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
        this.outputChannel.trace('tool result recovery timing', {
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

      const reportVisiblePart = (
        kind: 'text' | 'reasoning' | 'tool_call',
        part: vscode.LanguageModelResponsePart,
        reportedAt = Date.now()
      ) => {
        progress.report(part);
        reportedVisibleOutput = true;
        recordFirstVisibleOutput(kind, reportedAt);
        if (kind === 'text') {
          latency.mark('firstText', reportedAt);
        } else if (kind === 'reasoning') {
          latency.mark('firstReasoning', reportedAt);
        }
      };

      const presenter = new StreamPresenter(
        (_kind, receivedAt) => latency.mark('firstBackendDelta', receivedAt)
      );
      let loggedMissingThinkingPart = false;
      const reasoningPresenter = new ReasoningStreamPresenter((update) => {
        const thinkingPart = createThinkingPart(update.value, update.id, {
          source: update.source,
          itemId: update.itemId,
          outputIndex: update.outputIndex,
          phase: update.phase
        });
        if (thinkingPart) {
          reportVisiblePart('reasoning', thinkingPart);
        } else if (!loggedMissingThinkingPart) {
          loggedMissingThinkingPart = true;
          this.outputChannel.debug('Reasoning output received, but LanguageModelThinkingPart is unavailable.');
        }
      }, {
        onBackendDelta: (receivedAt) => latency.mark('firstBackendDelta', receivedAt)
      });
      let presentationMetricsRecorded = false;
      const recordPresentationMetrics = () => {
        if (presentationMetricsRecorded) {
          return;
        }
        presentationMetricsRecorded = true;
        const metrics = mergeStreamPresentationMetrics(presenter.metrics(), reasoningPresenter.metrics());
        latency.recordContext({
          metricVersion: 2,
          backendDeltaCount: metrics.backendDeltaCount,
          progressReportCount: metrics.progressReportCount,
          coalescedDeltaCount: metrics.coalescedDeltaCount,
          coalescingDelayP95Ms: metrics.coalescingDelayP95Ms,
          coalescingDelayMaxMs: metrics.coalescingDelayMaxMs,
          presentedCharacters: metrics.presentedCharacters,
          averageCharactersPerReport: metrics.averageCharactersPerReport,
          reportsPerSecond: metrics.reportsPerSecond
        });
        this.outputChannel.trace('response stream presentation', { ...metrics });
      };

      try {
        const streamOptions: Parameters<typeof streamResponseText>[0] = {
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        authManager: credentials.authManager,
        transport: config.transport,
        compatibilityProfile,
        identity: requestIdentity,
        turnState: branchState.turn.stickyState,
        authIdentity,
        extensionVersion: getExtensionVersion(this.context),
        userAgent: buildCodexUserAgent(getExtensionVersion(this.context)),
        protocolSettings: config.protocol,
        turnStartedAtUnixMs: branchState.turn.startedAt,
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
        toolPlan: requestOptions.toolPlan,
        toolMode: requestOptions.toolMode,
        reasoning: requestOptions.reasoning,
        maxOutputTokens: requestOptions.maxOutputTokens,
        token,
        onTextDelta: (text) => {
          pendingResponseText += text;
          if (text) {
            reasoningPresenter.close();
          }
          presenter.push({
            kind: 'text',
            identity: 'text',
            text,
            emit: (presentedText) => {
              reportVisiblePart('text', new vscode.LanguageModelTextPart(presentedText));
            }
          });
        },
        onReasoningDelta: (delta) => {
          reasoningPresenter.push(delta);
        },
        onReasoningLifecycleEvent: (event) => {
          this.outputChannel.trace('response reasoning lifecycle', {
            requestModel: selectedModel.requestModel,
            ...event
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
        onToolCall: (call) => {
          const mapped = mapNativeToolCall(toolPlan, call);
          const { callId, input: toolInput, vscodeName: name } = mapped;
          const itemId = call.itemId.trim();
          if (toolPlan.mode === 'native-hosted'
            && (!itemId || itemId === callId)) {
            throw new Error('Responses returned a Native Tool Search function call without an item id.');
          }
          flushReplayText();
          replayResponseItems.push({
            ...(toolPlan.mode === 'native-hosted' ? { id: itemId } : {}),
            type: 'function_call',
            call_id: callId,
            name: toolPlan.mode === 'native-hosted' ? call.name : name,
            ...(toolPlan.mode === 'native-hosted' && call.namespace ? { namespace: call.namespace } : {}),
            arguments: JSON.stringify(toolInput)
          });
          const textMetricsBeforeToolCall = presenter.metrics();
          presenter.flushBoundary();
          const reportedAt = Date.now();
          latency.mark('firstToolCall', reportedAt);
          reportVisiblePart('tool_call', new vscode.LanguageModelToolCallPart(callId, name, toolInput), reportedAt);
          latency.mark('firstToolCallReported', reportedAt);
          this.rememberReportedToolCall(callId, name, reportedAt);
          reportedToolCallIds.add(callId);
          const textMetricsAtToolCall = presenter.metrics();
          const reasoningBoundary = reasoningPresenter.startNextPhase({ rawFallback: 'discard' });
          latency.recordContext({
            pendingPresentationCharactersAtToolCall: textMetricsBeforeToolCall.pendingPresentationCharacters,
            rawReasoningFallbackCharactersAtToolCall: reasoningBoundary.rawFallbackCharacters,
            rawReasoningFallbackDiscardedAtToolCall: reasoningBoundary.rawFallbackDiscarded
          });
          const lifecycle = toolCallLifecycleAt.get(callId);
          this.outputChannel.trace('response tool call timing', {
            callId,
            name,
            backendName: call.name,
            namespace: call.namespace ?? null,
            toolPlanMode: toolPlan.mode,
            pendingPresentationCharacters: textMetricsBeforeToolCall.pendingPresentationCharacters,
            rawReasoningFallbackCharacters: reasoningBoundary.rawFallbackCharacters,
            rawReasoningFallbackDiscarded: reasoningBoundary.rawFallbackDiscarded,
            progressReportCount: textMetricsAtToolCall.progressReportCount,
            reportsPerSecond: textMetricsAtToolCall.reportsPerSecond,
            averageCharactersPerReport: textMetricsAtToolCall.averageCharactersPerReport,
            toolArgumentsDoneToReportedMs: lifecycle?.argumentsDoneAt === undefined
              ? null
              : Math.max(0, reportedAt - lifecycle.argumentsDoneAt)
          });
          setImmediate(() => {
            try {
              const serializedToolInput = JSON.stringify(toolInput);
              this.outputChannel.trace('response tool call', {
                requestModel: selectedModel.requestModel,
                callId,
                name,
                inputPresent: true,
                inputBytes: Buffer.byteLength(serializedToolInput),
                inputHash: shortHash(serializedToolInput)
              });
            } catch {
              this.outputChannel.trace('response tool call telemetry unavailable', {
                requestModel: selectedModel.requestModel,
                callId,
                name
              });
            }
          });
        },
        onRawResponseItem: (item) => {
          const toolSearchEvent = summarizeNativeToolSearchItem(item);
          if (toolSearchEvent) {
            this.outputChannel.debug('native Tool Search event', toolSearchEvent);
          }
          const replayItem = projectSafeRawReplayItem(item, toolPlan);
          if (replayItem) {
            flushReplayText();
            replayResponseItems.push(replayItem);
          }
        },
        onTurnState: (turnState) => {
          branchState = {
            ...branchState,
            turn: { ...branchState.turn, stickyState: turnState },
            updatedAt: Date.now()
          };
        },
        onWebSocketHandshake: (handshake) => {
          this.outputChannel.trace('response websocket handshake', {
            turnStateReceived: Boolean(handshake.turnState),
            modelsEtagPresent: Boolean(handshake.modelsEtag),
            reasoningIncluded: handshake.reasoningIncluded,
            serverModel: handshake.serverModel ?? null
          });
        },
        onTransportMetrics: (metrics) => {
          if (metrics.retryReason === 'websocket_unauthorized_recovered'
            || metrics.retryReason === 'websocket_connection_limit_reached') {
            resetAttemptState();
          }
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
          this.outputChannel.trace('response transport metrics', metrics);
        },
        onResponseCreated: (response) => {
          latency.mark('responseCreated');
          this.outputChannel.trace('response created', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            status: response.status,
            serviceTier: response.service_tier ?? null,
            previousResponseId: previousResponseId ?? null
          });
        },
        onResponseCompleted: (response) => {
          flushReplayText();
          reasoningPresenter.close();
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
          requestLogger.info('response completed', {
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
          requestLogger.debug('response latency', {
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
          reasoningPresenter.close();
          presenter.flushBoundary();
          recordPresentationMetrics();
          if (token.isCancellationRequested) {
            requestLogger.debug('response.cancelled', { requestModel: selectedModel.requestModel });
            return;
          }
          requestLogger.error('response.failed', new Error(message), {
            requestModel: selectedModel.requestModel,
            previousResponseId: previousResponseId ?? null
          });
        },
        onTransportFallback: ({ from, to, reason }) => {
          resetAttemptState();
          if (allowToolOutputContinuation && previousResponseId) {
            streamOptions.input = recoveryReplayInput;
            streamOptions.previousResponseId = undefined;
            streamOptions.allowToolOutputContinuation = false;
            previousResponseIdUsed = false;
            activeBranchId = undefined;
          }
          reasoningPresenter.flush();
          actualTransport = 'http-fallback';
          latency.mark('connectionAcquired');
          latency.recordContext({ transportActual: actualTransport });
          requestLogger.nextAttempt().warn('response transport fallback', {
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
        };
        try {
          await streamResponseText(streamOptions);
        } catch (error) {
          resetAttemptState();
          throw error;
        }
      } finally {
        reasoningPresenter.close();
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
      if (toolPlan.mode === 'native-hosted' && !reportedVisibleOutput && isNativeToolSearchUnsupportedError(error)) {
        markNativeToolSearchUnsupported(nativeToolSearchKey);
        toolPlan = resolveCodexToolPlan({
          tools: options.tools,
          model: selectedModel.requestModel,
          compatibilityEnabled: compatibilityProfile.enabled,
          nativeToolSearch: 'disabled',
          maxToolsPerNamespace: config.nativeToolSearchMaxToolsPerNamespace,
          extensions: (vscode as typeof vscode & { extensions?: { all?: readonly vscode.Extension<any>[] } }).extensions?.all ?? []
        });
        requestOptions = { ...requestOptions, toolPlan };
        reuseEnvelope = buildResponseBranchReuseEnvelope({
          baseURL: normalizeBaseURL(config.baseURL),
          authIdentity,
          toolSignatures: toolPlan.toolSignatures,
          effectiveInputBudget: selectedModel.effectiveInputBudget,
          ...requestOptions
        });
        replayResponseItems.length = 0;
        completedResponseId = undefined;
        activeBranchId = undefined;
        latency.recordContext({
          toolPlanMode: 'legacy',
          legacyToolSchemaCacheHit: toolPlan.legacyToolSchemaCacheHit,
          nativeToolCatalogCacheHit: false
        });
        recordNativeToolSearchRuntimeStatus({
          model: selectedModel.requestModel,
          setting: config.nativeToolSearch,
          plan: toolPlan,
          virtualToolPlaceholderCount: virtualToolPlaceholderNames.length,
          reason: 'backend-rejected'
        });
        this.outputChannel.warn('native Tool Search unsupported; retrying once with selected legacy function tools', {
          requestModel: selectedModel.requestModel,
          nativeToolSearchFallback: true
        });
        legacyFallbackReplayInput = buildLegacyFallbackReplayInput(markerCanonicalReplayInput ?? input);
        await streamRequest(legacyFallbackReplayInput);
      } else if (shouldAttemptToolOutputContinuation && isResponsesContinuationMissError(error)) {
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
          reason: error.message,
          reuseDisabledUntilExpiry: error.disableReuseUntilExpiry
        });

        completedResponseId = undefined;
        replayResponseItems.length = 0;
        this.responseBranchStore.disableReuse(reuseEnvelope, !error.disableReuseUntilExpiry);
        this.responseBranchStore.invalidateResponseId(error.previousResponseId);
        if (reusableBranch) {
          this.responseBranchStore.invalidate(reusableBranch.branchId);
        }
        activeBranchId = undefined;
        await streamRequest(recoveryReplayInput);
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

        completedResponseId = undefined;
        replayResponseItems.length = 0;
        activeBranchId = undefined;
        await streamRequest(recoveryReplayInput);
      }
    }

    const finalResponseId = completedResponseId;
    const statefulMarkerPayload = finalResponseId
      ? createStatefulMarkerPayload(model.id, finalResponseId)
      : undefined;
    if (finalResponseId && statefulMarkerPayload) {
      const recordedInput = markerCanonicalReplayInput ?? input;
      const builtFullRequest = buildCodexResponsesRequest({
        ...requestOptions,
        identity: requestIdentity,
        input: legacyFallbackReplayInput ?? recordedInput,
      });
      const fullRequest = isMarkerContinuation
        ? builtFullRequest
        : toolPlan.mode === 'native-hosted'
        ? createCanonicalReplayRequest(builtFullRequest, fullReplayInput)
        : builtFullRequest;
      branchState = {
        ...branchState,
        continuation: createCodexContinuationSnapshot(
          fullRequest,
          finalResponseId,
          replayResponseItems,
          requestIdentity.turnId,
          {
            clone: false,
            requestFingerprint: reuseEnvelope.requestFingerprint,
            catalogHash: toolPlan.catalogHash,
            toolPlanMode: toolPlan.mode
          }
        ),
        updatedAt: Date.now()
      };
      activeBranchId = this.responseBranchStore.recordSuccess(
        reuseEnvelope,
        recordedInput,
        finalResponseId,
        activeBranchId,
        branchState
      );
      if (!token.isCancellationRequested && !this.responseBranchStore.isReuseDisabled(reuseEnvelope)) {
        progress.report(createStatefulMarkerDataPart(statefulMarkerPayload));
      }
    } else if (finalResponseId) {
      requestLogger.warn('response continuation metadata rejected', {
        requestModel: selectedModel.requestModel
      });
    }
  }

  private notifyVirtualToolFallback(
    nativeToolSearch: 'auto' | 'enabled' | 'disabled',
    nativeToolSearchGroupingBridgeEnabled: boolean,
    virtualToolPlaceholderNames: readonly string[]
  ): void {
    if (nativeToolSearch === 'disabled' || (nativeToolSearch === 'auto' && !nativeToolSearchGroupingBridgeEnabled)) {
      return;
    }
    const signature = JSON.stringify(virtualToolPlaceholderNames);
    if (this.lastVirtualToolFallbackSignature === signature) {
      return;
    }
    this.lastVirtualToolFallbackSignature = signature;
    const groupCount = virtualToolPlaceholderNames.length;
    const groupLabel = groupCount === 1 ? 'group' : 'groups';
    void vscode.window.showWarningMessage(
      `Native Tool Search is unavailable for this request because VS Code supplied ${groupCount} Virtual Tool ${groupLabel}. The request is falling back to VS Code Virtual Tools.`
    );
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
      requestCompression: config.requestCompression,
      protocol: config.protocol
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
    const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials, config.protocol.profile);
    const started = compatibilityProfile.enabled && preconnectCodexResponsesWebSocket({
      baseURL: config.baseURL,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      compatibilityProfile,
      authIdentity,
      extensionVersion: getExtensionVersion(this.context),
      userAgent: buildCodexUserAgent(getExtensionVersion(this.context)),
      protocolSettings: config.protocol
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
      this.logLocalTokenEstimateDiagnosticOnce({
        baseURL: config.baseURL,
        modelId: model.id,
        requestModel: parseModelIdentifier(model.id || config.model).requestModel,
        count: estimated,
        reason: credentials ? 'official-counting-unavailable-for-backend' : 'missing-credentials'
      });
      return estimated;
    }

    const startedAt = Date.now();

    try {
      const catalog = await this.getAvailableModelCatalog(config, credentials, token);
      const selectedModel = this.resolveRequestModel(model.id, config, catalog.models, catalog.authoritative);
      const input = typeof text === 'string' ? text : convertMessagesToResponsesInput([text]);
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
    } catch (error) {
      if (token.isCancellationRequested || isAbortError(error)) {
        throw error;
      }
      const estimated = estimateTokenCount(text);
      const requestModel = parseModelIdentifier(model.id || config.model).requestModel;
      this.outputChannel.warn('provideTokenCount fell back to local estimate after counting request failure', {
        modelId: model.id,
        requestModel,
        count: estimated,
        source: 'local-estimate',
        officialCountingAvailable: true,
        durationMs: Date.now() - startedAt
      });
      return estimated;
    }
  }

  private logLocalTokenEstimateDiagnosticOnce(options: {
    baseURL: string;
    modelId: string;
    requestModel: string;
    count: number;
    reason: 'official-counting-unavailable-for-backend' | 'missing-credentials';
  }): void {
    const diagnosticKey = JSON.stringify([
      normalizeBaseURL(options.baseURL),
      options.requestModel,
      options.reason
    ]);
    if (this.localTokenEstimateDiagnostics.has(diagnosticKey)) {
      return;
    }
    if (this.localTokenEstimateDiagnostics.size >= MAX_LOCAL_TOKEN_ESTIMATE_DIAGNOSTICS) {
      this.localTokenEstimateDiagnostics.clear();
    }
    this.localTokenEstimateDiagnostics.add(diagnosticKey);
    this.outputChannel.trace('provideTokenCount using local estimate (first occurrence)', {
      modelId: options.modelId,
      requestModel: options.requestModel,
      count: options.count,
      source: 'local-estimate',
      officialCountingAvailable: false,
      reason: options.reason,
      subsequentOccurrencesSuppressed: true
    });
  }

  private async getAvailableModelCatalog(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken,
    onCacheState?: (state: CodexModelCacheState | 'fallback') => void
  ): Promise<ProviderModelCatalog> {
    const logger = this.logger.operation('model-discovery');
    const authIdentity = getCredentialIdentity(credentials);
    const cacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    try {
      if (token.isCancellationRequested) {
        throw createAbortError();
      }
      const lookup = await waitForPromiseWithCancellation(
        this.modelCache.get(
          cacheKey,
          () => this.discoverAvailableModels(config, credentials, NON_CANCELLABLE_TOKEN, authIdentity)
        ),
        token
      );
      logger.debug('getAvailableModels cache result', {
        modelDiscoveryCacheState: lookup.state,
        modelCount: lookup.value.models.length,
        refreshStarted: lookup.refreshStarted
      });
      onCacheState?.(lookup.state);
      if (lookup.state === 'stale' && lookup.refreshStarted && lookup.refresh) {
        void lookup.refresh.then(
          () => this.modelInfoChangedEmitter.fire(),
          (error) => logger.warn('getAvailableModels background refresh failed, retaining stale models', { modelDiscoveryCacheState: 'stale', error })
        );
      }
      return lookup.value;
    } catch (error) {
      if (token.isCancellationRequested || isAbortError(error)) {
        throw error;
      }

      const cachedCatalog = this.modelCache.peek(cacheKey);
      if (cachedCatalog?.authoritative) {
        this.modelCache.set(cacheKey, cachedCatalog, {
          freshTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS,
          staleTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS
        });
        logger.warn('getAvailableModels discovery failed, retaining authoritative catalog', { modelCount: cachedCatalog.models.length, error });
        onCacheState?.('fallback');
        return cachedCatalog;
      }

      const fallbackModels = this.applyModelDiscoveryPolicy([buildFallbackModel(config, credentials.kind)], config, authIdentity);
      const fallbackCatalog = { models: fallbackModels, authoritative: false };
      this.modelCache.set(cacheKey, fallbackCatalog, {
        freshTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS,
        staleTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS
      });
      logger.warn('getAvailableModels discovery failed, using fallback model', { fallbackModel: config.model, error });
      onCacheState?.('fallback');
      return fallbackCatalog;
    }
  }

  private async discoverAvailableModels(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken,
    authIdentity: string
  ): Promise<ProviderModelCatalog> {
    const logger = this.logger.operation('model-discovery.fetch');
    const upstreamModels = await fetchAvailableModels(config, credentials, token);
    const models = this.applyModelDiscoveryPolicy(buildProviderModels(config, upstreamModels, credentials.kind), config, authIdentity);
    logger.debug('getAvailableModels discovery success', {
      discoveredCount: upstreamModels.length,
      returnedCount: models.length,
      models: models.map((model) => ({
        requestModel: model.requestModel,
        activeRawContextWindow: model.rawContextWindow,
        maximumRawContextWindow: model.maximumRawContextWindow ?? null,
        effectiveInputBudget: model.effectiveInputBudget,
        maximumEffectiveInputBudget: model.info.maxInputTokens
      }))
    });
    return { models, authoritative: true };
  }

  private markModelUnavailable(
    model: string,
    config: ProviderConfig,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    authIdentity: string
  ): void {
    this.runtimeAvailability.markTemporarilyUnavailable(model, config, authIdentity);
    const cacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    const cachedCatalog = this.modelCache.peek(cacheKey);
    if (cachedCatalog?.authoritative) {
      this.modelCache.invalidate(cacheKey);
      this.modelCache.set(cacheKey, {
        models: cachedCatalog.models.filter((candidate) => candidate.requestModel !== model),
        authoritative: true
      }, {
        freshTtlMs: 0,
        staleTtlMs: TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS
      });
    } else {
      this.modelCache.invalidate(cacheKey);
    }
    this.modelInfoChangedEmitter.fire();
    this.outputChannel.warn('model marked unavailable after responses rejection', {
      model,
      transport: config.transport,
      authIdentity,
      baseURL: normalizeBaseURL(config.baseURL)
    });
    void this.getAvailableModelCatalog(config, credentials, NON_CANCELLABLE_TOKEN).then(
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
    availableModels: readonly ResolvedProviderModel[],
    authoritative = false
  ): ResolvedRequestModel {
    if (availableModels.length === 0) {
      throw new Error('No Codex models are available after applying the configured discovery policy.');
    }

    const parsedModel = parseModelIdentifier(modelId || config.model);
    const exactAvailableModel = modelId
      ? availableModels.find((candidate) => candidate.info.id === modelId)
      : undefined;
    const requestedModel = {
      requestModel: exactAvailableModel?.requestModel ?? parsedModel.requestModel,
      reasoningEffort: parsedModel.reasoningEffort
    };
    const aliasResolution = resolveModelAliasTarget(requestedModel.requestModel, config.modelAliases);
    if (aliasResolution.kind === 'cycle') {
      throw new Error(`Model alias cycle detected for "${requestedModel.requestModel}".`);
    }
    const aliasedModel = aliasResolution.kind === 'target'
      ? availableModels.find((candidate) => candidate.requestModel === aliasResolution.targetModel)
      : undefined;
    if (aliasedModel) {
      this.outputChannel.warn('request model remapped from configured model alias', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: aliasedModel.requestModel
      });
      return {
        requestModel: aliasedModel.requestModel,
        reasoningEffort: requestedModel.reasoningEffort,
        effectiveInputBudget: aliasedModel.effectiveInputBudget
      };
    }

    const requestedAvailableModel = exactAvailableModel
      ?? availableModels.find((candidate) => candidate.requestModel === requestedModel.requestModel);
    if (requestedAvailableModel) {
      return {
        ...requestedModel,
        effectiveInputBudget: requestedAvailableModel.effectiveInputBudget
      };
    }

    if (authoritative) {
      throw new Error(`Selected Codex model "${requestedModel.requestModel}" is not available in the authoritative model catalog.`);
    }

    const prefixMatch = availableModels
      .filter((candidate) => requestedModel.requestModel.startsWith(`${candidate.requestModel}-`))
      .sort((left, right) => right.requestModel.length - left.requestModel.length)[0];

    if (prefixMatch) {
      this.outputChannel.warn('request model remapped from stale model identifier', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: prefixMatch.requestModel
      });
      return {
        requestModel: prefixMatch.requestModel,
        reasoningEffort: requestedModel.reasoningEffort,
        effectiveInputBudget: prefixMatch.effectiveInputBudget
      };
    }

    const configuredModel = availableModels.find((candidate) => candidate.requestModel === config.model);
    if (configuredModel) {
      this.outputChannel.warn('request model fell back to configured model', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: config.model
      });
      return {
        requestModel: config.model,
        reasoningEffort: requestedModel.reasoningEffort,
        effectiveInputBudget: configuredModel.effectiveInputBudget
      };
    }

    const fallbackModel = availableModels[0];
    this.outputChannel.warn('request model fell back to first available model', {
      requestedModelId: modelId ?? null,
      requestedModel: requestedModel.requestModel,
      resolvedModel: fallbackModel.requestModel
    });
    return {
      requestModel: fallbackModel.requestModel,
      reasoningEffort: requestedModel.reasoningEffort,
      effectiveInputBudget: fallbackModel.effectiveInputBudget
    };
  }

  private resolveDirectRequestModel(
    model: vscode.LanguageModelChatInformation,
    config: ProviderConfig,
    authIdentity: string
  ): ResolvedRequestModel | undefined {
    if (!isProviderModelIdentifier(model.id)) {
      return undefined;
    }

    const requestedModel = parseModelIdentifier(model.id);
    const aliasResolution = resolveModelAliasTarget(requestedModel.requestModel, config.modelAliases);
    if (aliasResolution.kind === 'cycle') {
      throw new Error(`Model alias cycle detected for "${requestedModel.requestModel}".`);
    }
    const alias = aliasResolution.kind === 'target' ? aliasResolution.targetModel : undefined;
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
        requestedModelId: model.id,
        requestedModel: requestedModel.requestModel,
        resolvedModel: alias
      });
    }
    const effectiveInputBudget = alias ? undefined : model.maxInputTokens;
    return { ...resolvedModel, effectiveInputBudget };
  }

  private applyModelDiscoveryPolicy(models: ResolvedProviderModel[], config: ProviderConfig, authIdentity: string): ResolvedProviderModel[] {
    const disabledModels = new Set([
      ...config.disabledModels,
      ...this.runtimeAvailability.getTemporarilyUnavailableModels(config, authIdentity)
    ]);
    const availableModelNames = new Set(models.map((model) => model.requestModel));
    const aliasedSources = new Set(
      Object.keys(config.modelAliases)
        .filter((source) => {
          const resolution = resolveModelAliasTarget(source, config.modelAliases);
          return resolution.kind === 'cycle'
            || (resolution.kind === 'target' && availableModelNames.has(resolution.targetModel));
        })
    );
    const filteredModels = models.filter((model) => !disabledModels.has(model.requestModel) && !aliasedSources.has(model.requestModel));

    if (models.length > 0 && filteredModels.length === 0) {
      this.outputChannel.warn('model discovery policy filtered every discovered model', {
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
    }

    if (filteredModels.length !== models.length) {
      this.outputChannel.debug('model discovery policy filtered models', {
        before: models.map((model) => model.requestModel),
        after: filteredModels.map((model) => model.requestModel),
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
    }

    return filteredModels;
  }
}

function resolveModelAliasTarget(model: string, modelAliases: Record<string, string>): ModelAliasResolution {
  const firstTarget = modelAliases[model];
  if (!firstTarget) {
    return { kind: 'none' };
  }

  const visitedModels = new Set([model]);
  let targetModel = firstTarget;
  while (true) {
    if (visitedModels.has(targetModel)) {
      return { kind: 'cycle' };
    }
    visitedModels.add(targetModel);

    const nextTarget = modelAliases[targetModel];
    if (!nextTarget) {
      return { kind: 'target', targetModel };
    }
    targetModel = nextTarget;
  }
}

class RuntimeModelAvailability {
  private readonly temporarilyUnavailableModels = new Map<string, number>();

  markTemporarilyUnavailable(model: string, config: ProviderConfig, authIdentity: string): void {
    this.evictExpiredEntries();
    this.temporarilyUnavailableModels.set(
      this.getScopeKey(model, config, authIdentity),
      Date.now() + TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS
    );
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
  return resolveReasoningEffort(selectedReasoningEffort, options, defaultReasoningEffort);
}

type ContextSizeSchemaCarrier = {
  readonly configurationSchema?: {
    readonly properties?: {
      readonly contextSize?: {
        readonly enum?: readonly unknown[];
        readonly default?: unknown;
      };
    };
  };
};

function resolveConfiguredContextSize(
  fallbackBudget: number | undefined,
  model: vscode.LanguageModelChatInformation,
  options: RuntimeProvideLanguageModelChatResponseOptions
): number | undefined {
  const contextSizeSchema = getContextSizeSchema(model);
  if (!contextSizeSchema) {
    return fallbackBudget;
  }

  for (const candidate of [
    options.modelOptions?.contextSize,
    options.modelConfiguration?.contextSize,
    options.configuration?.contextSize
  ]) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && contextSizeSchema.options.includes(candidate)) {
      return candidate;
    }
  }

  return contextSizeSchema.default ?? fallbackBudget;
}

function getContextSizeSchema(model: vscode.LanguageModelChatInformation): { options: number[]; default: number | undefined } | undefined {
  const contextSize = (model as vscode.LanguageModelChatInformation & ContextSizeSchemaCarrier)
    .configurationSchema?.properties?.contextSize;
  if (!contextSize) {
    return undefined;
  }

  const options = (contextSize.enum ?? [])
    .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  if (options.length === 0) {
    return undefined;
  }

  return {
    options,
    default: typeof contextSize.default === 'number' && options.includes(contextSize.default)
      ? contextSize.default
      : undefined
  };
}

function supportsOfficialTokenCounting(baseURL: string): boolean {
  const normalizedBaseURL = normalizeBaseURL(baseURL).toLowerCase();
  return !normalizedBaseURL.includes('chatgpt.com/backend-api/codex');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function waitForPromiseWithCancellation<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
  if (token.isCancellationRequested) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancellation: vscode.Disposable | undefined;
    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation?.dispose();
      action();
    };

    cancellation = token.onCancellationRequested(() => {
      settle(() => reject(createAbortError()));
    });
    if (settled) {
      cancellation.dispose();
    }

    void promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

function createAbortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}

function createThinkingPart(
  value: string | string[],
  id?: string,
  metadata?: { readonly [key: string]: unknown }
): vscode.LanguageModelResponsePart | undefined {
  const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
  if (typeof ThinkingPart !== 'function') {
    return undefined;
  }

  return new ThinkingPart(value, id, metadata) as vscode.LanguageModelResponsePart;
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

function createStatefulMarkerDataPart(payload: string): vscode.LanguageModelResponsePart {
  return vscode.LanguageModelDataPart.text(
    payload,
    STATEFUL_MARKER_DATA_PART_MIME
  ) as vscode.LanguageModelResponsePart;
}

function combineRequestInstructions(configuredInstructions: string, systemInstructions: string | undefined): string {
  return systemInstructions
    ? `${configuredInstructions}\n\n${systemInstructions}`
    : configuredInstructions;
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
    toolSignatures: toolSignatures ?? buildResponseBranchToolSignatures(requestOptions.tools),
    catalogHash: requestOptions.toolPlan?.catalogHash,
    toolPlanMode: requestOptions.toolPlan?.mode
  };
}

export function hasCanonicalReplayContinuationIntegrity(
  responseItems: readonly unknown[],
  appendedInput: readonly ResponsesInputMessage[]
): boolean {
  const functionCallIds = new Set<string>();
  for (const item of responseItems) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const callId = typeof record.call_id === 'string' ? record.call_id.trim() : '';
    if (record.type === 'function_call') {
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!callId || !name || functionCallIds.has(callId)) {
        return false;
      }
      functionCallIds.add(callId);
    }
  }
  const outputCounts = new Map<string, number>();
  for (const item of appendedInput) {
    if (item.type !== 'function_call_output') {
      continue;
    }
    const callId = item.call_id.trim();
    if (!callId || !functionCallIds.has(callId) || outputCounts.has(callId)) {
      return false;
    }
    outputCounts.set(callId, 1);
  }
  return [...functionCallIds].every((callId) => outputCounts.get(callId) === 1);
}

const OMIT_LOCAL_REPLAY_ITEM = Symbol('omit-local-replay-item');
const INVALID_LOCAL_REPLAY_ITEM = Symbol('invalid-local-replay-item');

function projectSafeRawReplayItem(item: unknown, toolPlan: CodexToolPlan): ResponsesInputMessage | undefined {
  if (!isReplayRecord(item)) {
    return undefined;
  }
  if (item.type === 'reasoning') {
    const summary = projectReasoningSummary(item.summary);
    if (!isNonEmptyString(item.id) || !summary) {
      return undefined;
    }
    return {
      type: 'reasoning',
      id: item.id,
      summary,
      ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {})
    } satisfies ResponseReasoningItem;
  }
  if (toolPlan.mode !== 'native-hosted'
    || !isNonEmptyString(item.id)
    || item.execution !== 'server'
    || item.status !== 'completed') {
    return undefined;
  }
  if (item.type === 'tool_search_call') {
    return isReplayRecord(item.arguments)
      ? {
          type: 'tool_search_call',
          id: item.id,
          execution: 'server',
          status: 'completed',
          arguments: structuredClone(item.arguments)
        }
      : undefined;
  }
  if (item.type !== 'tool_search_output' || !Array.isArray(item.tools)) {
    return undefined;
  }
  const tools: NamespaceTool[] = [];
  const namespaceNames = new Set<string>();
  for (const namespace of item.tools) {
    if (!isReplayRecord(namespace)
      || namespace.type !== 'namespace'
      || !isNonEmptyString(namespace.name)
      || !Array.isArray(namespace.tools)
      || namespaceNames.has(namespace.name)) {
      return undefined;
    }
    const trustedNamespace = toolPlan.responseTools.find(
      (candidate): candidate is NamespaceTool => candidate.type === 'namespace' && candidate.name === namespace.name
    );
    if (!trustedNamespace) {
      return undefined;
    }
    namespaceNames.add(namespace.name);
    const namespaceTools: NamespaceTool['tools'] = [];
    const toolNames = new Set<string>();
    for (const tool of namespace.tools) {
      if (!isReplayRecord(tool)
        || tool.type !== 'function'
        || !isNonEmptyString(tool.name)
        || toolNames.has(tool.name)
        || !toolPlan.callMappings.has(createToolCallMappingKey(namespace.name, tool.name))) {
        return undefined;
      }
      const trustedTool = trustedNamespace.tools.find(
        (candidate) => candidate.type === 'function' && candidate.name === tool.name
      );
      if (!trustedTool) {
        return undefined;
      }
      toolNames.add(tool.name);
      namespaceTools.push(structuredClone(trustedTool));
    }
    tools.push({
      type: 'namespace',
      name: trustedNamespace.name,
      description: trustedNamespace.description,
      tools: namespaceTools
    });
  }
  return {
    type: 'tool_search_output',
    id: item.id,
    execution: 'server',
    status: 'completed',
    tools
  } satisfies ResponsesInputMessage;
}

function projectReasoningSummary(value: unknown): ResponseReasoningItem['summary'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const summary: ResponseReasoningItem['summary'] = [];
  for (const part of value) {
    if (!isReplayRecord(part) || part.type !== 'summary_text' || typeof part.text !== 'string') {
      return undefined;
    }
    summary.push({ type: 'summary_text', text: part.text });
  }
  return summary;
}

function isReplayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildLegacyFallbackReplayInput(input: readonly ResponsesInputMessage[]): ResponsesInputMessage[] {
  const replay: ResponsesInputMessage[] = [];
  for (const item of input) {
    if (item.type === 'tool_search_call'
      || item.type === 'tool_search_output'
      || item.type === 'reasoning') {
      continue;
    }
    if (item.type === 'function_call') {
      replay.push({
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments
      });
      continue;
    }
    replay.push(item);
  }
  return replay;
}

function hasExactLocalBranchHistory(
  snapshot: CodexBranchState['continuation'],
  currentInput: readonly ResponsesInputMessage[],
  appendedInput: readonly ResponsesInputMessage[]
): boolean {
  if (!snapshot
    || appendedInput.length === 0
    || appendedInput.length > currentInput.length
    || !hasCanonicalReplayContinuationIntegrity(snapshot.responseItems, appendedInput)) {
    return false;
  }

  const currentSuffix = currentInput.slice(currentInput.length - appendedInput.length);
  if (!haveEquivalentLocalReplayItems(currentSuffix, appendedInput)) {
    return false;
  }

  const previousLocalInput = normalizeLocalReplayItems(snapshot.fullRequest.input as readonly unknown[]);
  if (!previousLocalInput) {
    return false;
  }
  const responseLocalInput = normalizeLocalReplayItems(snapshot.responseItems);
  if (!responseLocalInput || responseLocalInput.length === 0) {
    return false;
  }
  const currentLocalHistory = normalizeLocalReplayItems(
    currentInput.slice(0, currentInput.length - appendedInput.length)
  );
  return Boolean(currentLocalHistory
    && stableSerialize([...previousLocalInput, ...responseLocalInput]) === stableSerialize(currentLocalHistory));
}

function haveEquivalentLocalReplayItems(
  left: readonly unknown[],
  right: readonly unknown[]
): boolean {
  const normalizedLeft = normalizeLocalReplayItems(left);
  const normalizedRight = normalizeLocalReplayItems(right);
  return Boolean(normalizedLeft
    && normalizedRight
    && stableSerialize(normalizedLeft) === stableSerialize(normalizedRight));
}

function normalizeLocalReplayItems(items: readonly unknown[]): unknown[] | undefined {
  const normalized: unknown[] = [];
  for (const item of items) {
    const normalizedItem = normalizeLocalReplayItem(item);
    if (normalizedItem === INVALID_LOCAL_REPLAY_ITEM) {
      return undefined;
    }
    if (normalizedItem !== OMIT_LOCAL_REPLAY_ITEM) {
      normalized.push(normalizedItem);
    }
  }
  return normalized;
}

function normalizeLocalReplayItem(
  item: unknown
): unknown | typeof OMIT_LOCAL_REPLAY_ITEM | typeof INVALID_LOCAL_REPLAY_ITEM {
  if (typeof item !== 'object' || item === null) {
    return INVALID_LOCAL_REPLAY_ITEM;
  }
  const record = item as Record<string, unknown>;
  if (record.type === 'tool_search_call'
    || record.type === 'tool_search_output'
    || record.type === 'reasoning') {
    return OMIT_LOCAL_REPLAY_ITEM;
  }
  if (record.type === 'message') {
    if ((record.role !== 'user' && record.role !== 'assistant')) {
      return INVALID_LOCAL_REPLAY_ITEM;
    }
    const content = normalizeLocalReplayMessageContent(record.content);
    return content === undefined
      ? INVALID_LOCAL_REPLAY_ITEM
      : { type: 'message', role: record.role, content };
  }
  if (record.type === 'function_call') {
    return typeof record.call_id === 'string'
      && record.call_id.trim().length > 0
      && typeof record.name === 'string'
      && record.name.trim().length > 0
      && typeof record.arguments === 'string'
      ? {
          type: 'function_call',
          call_id: record.call_id,
          name: record.name,
          arguments: record.arguments
        }
      : INVALID_LOCAL_REPLAY_ITEM;
  }
  if (record.type === 'function_call_output') {
    return typeof record.call_id === 'string' && record.call_id.trim().length > 0
      ? { type: 'function_call_output', call_id: record.call_id, output: record.output }
      : INVALID_LOCAL_REPLAY_ITEM;
  }
  return INVALID_LOCAL_REPLAY_ITEM;
}

function normalizeLocalReplayMessageContent(content: unknown): unknown[] | undefined {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const normalized = [];
  for (const part of content) {
    if (typeof part !== 'object' || part === null) {
      return undefined;
    }
    const record = part as Record<string, unknown>;
    if ((record.type === 'input_text' || record.type === 'output_text') && typeof record.text === 'string') {
      normalized.push({ type: 'text', text: record.text });
      continue;
    }
    if (record.type === 'input_image'
      && (typeof record.image_url === 'string' || typeof record.file_id === 'string')) {
      normalized.push({
        type: 'image',
        detail: record.detail ?? 'auto',
        image_url: record.image_url,
        file_id: record.file_id
      });
      continue;
    }
    return undefined;
  }
  return normalized;
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
    legacyToolSchemaCacheHit: readBoolean(metrics.legacyToolSchemaCacheHit),
    nativeToolCatalogCacheHit: readBoolean(metrics.nativeToolCatalogCacheHit),
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
