export type CodexLatencyStage =
  | 'providerEntry'
  | 'credentialsResolved'
  | 'modelResolved'
  | 'messagesConverted'
  | 'branchResolved'
  | 'identityResolved'
  | 'requestReady'
  | 'connectionAcquired'
  | 'websocketConnected'
  | 'prewarmStarted'
  | 'prewarmCompleted'
  | 'requestSent'
  | 'responseCreated'
  | 'firstBackendDelta'
  | 'lastBackendDelta'
  | 'firstReasoning'
  | 'firstText'
  | 'lastProgressReport'
  | 'firstToolCallAdded'
  | 'firstToolCallArgumentsDelta'
  | 'firstToolCallArgumentsDone'
  | 'firstToolCallReported'
  | 'firstToolCall'
  | 'responseCompleted'
  | 'providerReturned';

export interface CodexLatencyTrace {
  providerSetupMs: number;
  modelResolutionMs: number;
  messageConversionMs: number;
  branchResolutionMs: number;
  identityResolutionMs: number;
  connectionQueueWaitMs: number;
  websocketConnectMs?: number;
  prewarmMs?: number;
  requestToCreatedMs?: number;
  responseCreatedToFirstBackendDeltaMs?: number;
  firstBackendDeltaToFirstReportMs?: number;
  lastBackendDeltaToResponseCompletedMs?: number;
  lastProgressReportToResponseCompletedMs?: number;
  providerToFirstReportMs?: number;
  createdToFirstVisibleMs?: number;
  providerToFirstVisibleMs?: number;
  toolCallAddedToFirstArgumentsDeltaMs?: number;
  toolCallArgumentsToDoneMs?: number;
  toolCallDoneToReportedMs?: number;
  responseCompletedToProviderReturnMs?: number;
  totalMs: number;
}

export interface CodexLatencyContext {
  metricVersion?: 4;
  connectionOrigin?: 'fresh' | 'preconnected' | 'prewarm' | 'previous-response';
  connectionReused?: boolean;
  previousResponseIdUsed?: boolean;
  incrementalInputCount?: number;
  fullInputCount?: number;
  requestBodyBytes?: number;
  toolCount?: number;
  toolSchemaBytes?: number;
  legacyToolSchemaCacheHit?: boolean;
  nativeToolCatalogCacheHit?: boolean;
  toolPlanMode?: 'legacy' | 'native-hosted';
  originalToolCount?: number;
  immediateToolCount?: number;
  deferredToolCount?: number;
  namespaceCount?: number;
  catalogHash?: string;
  requestBuildMs?: number;
  modelDiscoveryCacheState?: 'cold' | 'fresh' | 'stale' | 'fallback' | 'direct';
  prewarmResult?: 'success' | 'timed-out' | 'disabled-after-failure' | 'skipped-auto';
  transportActual?: 'http' | 'http-fallback' | 'websocket-fresh' | 'websocket-reused';
  toolOutputContinuation?: 'attempted' | 'supported' | 'fallback-full-replay' | 'unsupported';
  toolContinuationStrategy?: 'incremental' | 'full-replay' | 'incremental-recovered';
  toolContinuationProbeMs?: number;
  fullReplayReason?: string;
  reasoningEffort?: string | null;
  serviceTier?: string;
  backendDeltaCount?: number;
  progressReportCount?: number;
  coalescedDeltaCount?: number;
  coalescingDelayP95Ms?: number;
  coalescingDelayMaxMs?: number;
  largestReportCharacters?: number;
  boundaryDrainReportCount?: number;
  boundaryDrainDurationMs?: number;
  backendDeltaGapMaxMs?: number;
  continuationSnapshotMs?: number;
  continuationStoreMs?: number;
  discardedReasoningCharactersAtToolCall?: number;
  pendingPresentationCharactersAtToolCall?: number;
  websocketSerializeMs?: number;
}

export interface CodexLatencySnapshot {
  trace: CodexLatencyTrace;
  stageOffsetsMs: Partial<Record<CodexLatencyStage, number>>;
  firstVisibleStage?: 'firstReasoning' | 'firstText' | 'firstToolCall';
  context: CodexLatencyContext;
}

export class CodexLatencyRecorder {
  private readonly timestamps = new Map<CodexLatencyStage, number>();
  private readonly context: CodexLatencyContext = {};

  constructor(entryAt = Date.now()) {
    this.timestamps.set('providerEntry', entryAt);
  }

  get entryAt(): number {
    return this.timestamps.get('providerEntry')!;
  }

  mark(stage: CodexLatencyStage, at = Date.now()): void {
    if (!this.timestamps.has(stage)) {
      this.timestamps.set(stage, at);
    }
  }

  /** Records every backend text/reasoning delta while preserving first-delta latency. */
  recordBackendDelta(at = Date.now()): void {
    const previousAt = this.at('lastBackendDelta');
    if (previousAt !== undefined) {
      this.context.backendDeltaGapMaxMs = Math.max(this.context.backendDeltaGapMaxMs ?? 0, at - previousAt);
    }
    this.mark('firstBackendDelta', at);
    this.timestamps.set('lastBackendDelta', at);
  }

  /** Records every visible report so the response tail can be attributed separately from presentation batching. */
  recordProgressReport(at = Date.now()): void {
    this.timestamps.set('lastProgressReport', at);
  }

  recordContext(context: CodexLatencyContext): void {
    if (context.metricVersion !== undefined) {
      this.context.metricVersion = context.metricVersion;
    }
    if (context.connectionOrigin !== undefined) {
      this.context.connectionOrigin = context.connectionOrigin;
    }
    if (context.connectionReused !== undefined) {
      this.context.connectionReused = context.connectionReused;
    }
    if (context.previousResponseIdUsed !== undefined) {
      this.context.previousResponseIdUsed = context.previousResponseIdUsed;
    }
    if (context.incrementalInputCount !== undefined) {
      this.context.incrementalInputCount = context.incrementalInputCount;
    }
    if (context.fullInputCount !== undefined) {
      this.context.fullInputCount = context.fullInputCount;
    }
    if (context.requestBodyBytes !== undefined) {
      this.context.requestBodyBytes = context.requestBodyBytes;
    }
    if (context.toolCount !== undefined) {
      this.context.toolCount = context.toolCount;
    }
    if (context.toolSchemaBytes !== undefined) {
      this.context.toolSchemaBytes = context.toolSchemaBytes;
    }
    if (context.legacyToolSchemaCacheHit !== undefined) {
      this.context.legacyToolSchemaCacheHit = context.legacyToolSchemaCacheHit;
    }
    if (context.nativeToolCatalogCacheHit !== undefined) {
      this.context.nativeToolCatalogCacheHit = context.nativeToolCatalogCacheHit;
    }
    if (context.toolPlanMode !== undefined) this.context.toolPlanMode = context.toolPlanMode;
    if (context.originalToolCount !== undefined) this.context.originalToolCount = context.originalToolCount;
    if (context.immediateToolCount !== undefined) this.context.immediateToolCount = context.immediateToolCount;
    if (context.deferredToolCount !== undefined) this.context.deferredToolCount = context.deferredToolCount;
    if (context.namespaceCount !== undefined) this.context.namespaceCount = context.namespaceCount;
    if (context.catalogHash !== undefined) this.context.catalogHash = context.catalogHash;
    if (context.requestBuildMs !== undefined) {
      this.context.requestBuildMs = context.requestBuildMs;
    }
    if (context.modelDiscoveryCacheState !== undefined) {
      this.context.modelDiscoveryCacheState = context.modelDiscoveryCacheState;
    }
    if (context.prewarmResult !== undefined) {
      this.context.prewarmResult = context.prewarmResult;
    }
    if (context.transportActual !== undefined) {
      this.context.transportActual = context.transportActual;
    }
    if (context.toolOutputContinuation !== undefined) {
      this.context.toolOutputContinuation = context.toolOutputContinuation;
    }
    if (context.toolContinuationStrategy !== undefined) {
      this.context.toolContinuationStrategy = context.toolContinuationStrategy;
    }
    if (context.toolContinuationProbeMs !== undefined) {
      this.context.toolContinuationProbeMs = context.toolContinuationProbeMs;
    }
    if (context.fullReplayReason !== undefined) {
      this.context.fullReplayReason = context.fullReplayReason;
    }
    if (context.reasoningEffort !== undefined) {
      this.context.reasoningEffort = context.reasoningEffort;
    }
    if (context.serviceTier !== undefined) {
      this.context.serviceTier = context.serviceTier;
    }
    if (context.backendDeltaCount !== undefined) {
      this.context.backendDeltaCount = context.backendDeltaCount;
    }
    if (context.progressReportCount !== undefined) {
      this.context.progressReportCount = context.progressReportCount;
    }
    if (context.coalescedDeltaCount !== undefined) {
      this.context.coalescedDeltaCount = context.coalescedDeltaCount;
    }
    if (context.coalescingDelayP95Ms !== undefined) {
      this.context.coalescingDelayP95Ms = context.coalescingDelayP95Ms;
    }
    if (context.coalescingDelayMaxMs !== undefined) {
      this.context.coalescingDelayMaxMs = context.coalescingDelayMaxMs;
    }
    if (context.largestReportCharacters !== undefined) {
      this.context.largestReportCharacters = context.largestReportCharacters;
    }
    if (context.boundaryDrainReportCount !== undefined) {
      this.context.boundaryDrainReportCount = context.boundaryDrainReportCount;
    }
    if (context.boundaryDrainDurationMs !== undefined) {
      this.context.boundaryDrainDurationMs = context.boundaryDrainDurationMs;
    }
    if (context.continuationSnapshotMs !== undefined) {
      this.context.continuationSnapshotMs = context.continuationSnapshotMs;
    }
    if (context.continuationStoreMs !== undefined) {
      this.context.continuationStoreMs = context.continuationStoreMs;
    }
    if (context.discardedReasoningCharactersAtToolCall !== undefined) {
      this.context.discardedReasoningCharactersAtToolCall = context.discardedReasoningCharactersAtToolCall;
    }
    if (context.pendingPresentationCharactersAtToolCall !== undefined) {
      this.context.pendingPresentationCharactersAtToolCall = context.pendingPresentationCharactersAtToolCall;
    }
    if (context.websocketSerializeMs !== undefined) {
      this.context.websocketSerializeMs = context.websocketSerializeMs;
    }
  }

  snapshot(completedAt = Date.now()): CodexLatencySnapshot {
    const providerEntry = this.entryAt;
    const requestReady = this.at('requestReady');
    const connectionAcquired = this.at('connectionAcquired');
    const requestSent = this.at('requestSent');
    const responseCreated = this.at('responseCreated');
    const firstBackendDelta = this.at('firstBackendDelta');
    const lastBackendDelta = this.at('lastBackendDelta');
    const firstVisible = this.firstVisibleAt();
    const responseCompleted = this.at('responseCompleted') ?? completedAt;

    return {
      trace: {
        providerSetupMs: this.duration(providerEntry, requestReady, responseCompleted),
        modelResolutionMs: this.duration(this.at('credentialsResolved'), this.at('modelResolved')),
        messageConversionMs: this.duration(this.at('modelResolved'), this.at('messagesConverted')),
        branchResolutionMs: this.duration(this.at('messagesConverted'), this.at('branchResolved')),
        identityResolutionMs: this.duration(this.at('branchResolved'), this.at('identityResolved')),
        connectionQueueWaitMs: this.duration(requestReady, connectionAcquired ?? requestSent),
        websocketConnectMs: this.optionalDuration(connectionAcquired, this.at('websocketConnected')),
        prewarmMs: this.optionalDuration(this.at('prewarmStarted'), this.at('prewarmCompleted')),
        requestToCreatedMs: this.optionalDuration(requestSent, responseCreated),
        responseCreatedToFirstBackendDeltaMs: this.optionalDuration(responseCreated, firstBackendDelta),
        firstBackendDeltaToFirstReportMs: this.optionalDuration(firstBackendDelta, firstVisible),
        lastBackendDeltaToResponseCompletedMs: this.optionalDuration(lastBackendDelta, responseCompleted),
        lastProgressReportToResponseCompletedMs: this.optionalDuration(
          this.at('lastProgressReport'),
          responseCompleted
        ),
        providerToFirstReportMs: this.optionalDuration(providerEntry, firstVisible),
        createdToFirstVisibleMs: this.optionalDuration(responseCreated, firstVisible),
        providerToFirstVisibleMs: this.optionalDuration(providerEntry, firstVisible),
        toolCallAddedToFirstArgumentsDeltaMs: this.optionalDuration(
          this.at('firstToolCallAdded'),
          this.at('firstToolCallArgumentsDelta')
        ),
        toolCallArgumentsToDoneMs: this.optionalDuration(
          this.at('firstToolCallArgumentsDelta'),
          this.at('firstToolCallArgumentsDone')
        ),
        toolCallDoneToReportedMs: this.optionalDuration(
          this.at('firstToolCallArgumentsDone'),
          this.at('firstToolCallReported')
        ),
        responseCompletedToProviderReturnMs: this.optionalDuration(
          this.at('responseCompleted'),
          this.at('providerReturned')
        ),
        totalMs: this.duration(providerEntry, responseCompleted, completedAt)
      },
      stageOffsetsMs: Object.fromEntries(
        [...this.timestamps.entries()].map(([stage, timestamp]) => [stage, Math.max(0, timestamp - providerEntry)])
      ),
      firstVisibleStage: this.firstVisibleStage(),
      context: { ...this.context }
    };
  }

  private at(stage: CodexLatencyStage): number | undefined {
    return this.timestamps.get(stage);
  }

  private firstVisibleStage(): 'firstReasoning' | 'firstText' | 'firstToolCall' | undefined {
    const candidates = ['firstReasoning', 'firstText', 'firstToolCall'] as const;
    return candidates
      .map((stage) => ({ stage, at: this.at(stage) }))
      .filter((candidate): candidate is { stage: typeof candidates[number]; at: number } => candidate.at !== undefined)
      .sort((left, right) => left.at - right.at)[0]?.stage;
  }

  private firstVisibleAt(): number | undefined {
    const stage = this.firstVisibleStage();
    return stage ? this.at(stage) : undefined;
  }

  private duration(from: number | undefined, to: number | undefined, fallback = 0): number {
    if (from === undefined || to === undefined) {
      return fallback;
    }
    return Math.max(0, to - from);
  }

  private optionalDuration(from: number | undefined, to: number | undefined): number | undefined {
    return from === undefined || to === undefined ? undefined : this.duration(from, to);
  }
}
