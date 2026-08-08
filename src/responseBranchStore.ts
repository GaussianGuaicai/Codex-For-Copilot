import {
  compareResponsesInputHistory,
  projectResponsesInputForContinuation,
  summarizeResponsesInputMessageForLog,
  type ResponsesInputHistoryComparison,
  type ResponsesInputMessage
} from './convertMessages';
import type { CodexRequestIdentity } from './codexProtocol';
import { cloneCodexContinuationSnapshot, type CodexContinuationSnapshot } from './codexContinuation';
import { fingerprintCodexRequest } from './codexRequestBuilder';

export interface CodexTurnState {
  id: string;
  stickyState?: string;
  startedAt: number;
  completed: boolean;
}

export interface CodexBranchIdentity extends Omit<CodexRequestIdentity, 'turnId'> {}

export interface CodexBranchState {
  identity: CodexBranchIdentity;
  turn: CodexTurnState;
  continuation?: CodexContinuationSnapshot;
  updatedAt: number;
}

export interface ReusableResponseBranchMatch {
  branchId: string;
  responseId: string;
  comparison: ResponsesInputHistoryComparison;
  state?: CodexBranchState;
}

export interface ResponseBranchMarkerHint {
  responseId: string;
  incrementalInput: readonly ResponsesInputMessage[];
}

export interface ResponseBranchReuseEnvelope {
  identityKey: string;
  scopeKey: string;
  requestFingerprint: string;
  effectiveInputBudget?: number;
  toolSignatures?: ResponseBranchToolSignatures;
  catalogHash?: string;
  toolPlanMode?: 'legacy' | 'native-hosted';
}

export interface ResponseBranchReuseMissDiagnostic {
  branchId: string;
  responseId: string;
  comparison: ResponsesInputHistoryComparison;
  previousInputCount: number;
  currentInputCount: number;
  previousNextItemSummary: string | null;
  currentNextItemSummary: string | null;
  requestFingerprintMatches: boolean;
  previousEffectiveInputBudget?: number;
  currentEffectiveInputBudget?: number;
  inputBudgetCompatible: boolean;
  toolCompatibility?: ResponseBranchToolCompatibility;
  state?: CodexBranchState;
}

export type ResponseBranchToolSignatures = Readonly<Record<string, string>>;

export interface ResponseBranchToolCompatibility {
  compatible: boolean;
  missingToolNames: string[];
  addedToolNames: string[];
  changedToolNames: string[];
}

interface DisabledResponseBranchReuse {
  disabledAt: number;
  enableAfterFullInputSuccess: boolean;
}

interface ResponseBranchEntry {
  id: string;
  envelope: ResponseBranchReuseEnvelope;
  input: ResponsesInputMessage[];
  continuationInput: ResponsesInputMessage[];
  responseId: string;
  state?: CodexBranchState;
  updatedAt: number;
}

export class ResponseBranchStore {
  private readonly branches = new Map<string, ResponseBranchEntry>();
  private readonly disabledReuseKeys = new Map<string, DisabledResponseBranchReuse>();
  private nextBranchId = 1;

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxBranches = 64
  ) {}

  findReusableBranch(
    envelope: ResponseBranchReuseEnvelope,
    currentInput: readonly ResponsesInputMessage[],
    markerHint?: ResponseBranchMarkerHint
  ): ReusableResponseBranchMatch | undefined {
    this.evictExpiredEntries();

    if (this.disabledReuseKeys.has(envelope.identityKey)) {
      return undefined;
    }

    if (markerHint) {
      return this.findMarkerBranch(envelope, currentInput, markerHint);
    }

    const currentContinuationInput = projectResponsesInputForContinuation(currentInput);

    let bestCandidate: {
      branch: ResponseBranchEntry;
      comparison: ResponsesInputHistoryComparison;
    } | undefined;

    for (const branch of this.branches.values()) {
      if (branch.envelope.identityKey !== envelope.identityKey
        || !hasMatchingRequestFingerprint(branch, envelope)
        || !hasCompatibleInputBudget(branch.envelope.effectiveInputBudget, envelope.effectiveInputBudget)) {
        continue;
      }

      if (!compareToolSignatures(branch.envelope.toolSignatures, envelope.toolSignatures).compatible) {
        continue;
      }

      const comparison = compareResponsesInputHistory(branch.continuationInput, currentContinuationInput);
      if (comparison.kind !== 'append' || comparison.appendedInput.length === 0) {
        continue;
      }

      if (!bestCandidate
        || comparison.matchedPrefixCount > bestCandidate.comparison.matchedPrefixCount
        || (comparison.matchedPrefixCount === bestCandidate.comparison.matchedPrefixCount
          && branch.updatedAt > bestCandidate.branch.updatedAt)) {
        bestCandidate = { branch, comparison };
      }
    }

    if (!bestCandidate || !hasContinuationIntegrity(bestCandidate.branch, bestCandidate.comparison.appendedInput)) {
      return undefined;
    }

    return {
      branchId: bestCandidate.branch.id,
      responseId: bestCandidate.branch.responseId,
      comparison: bestCandidate.comparison,
      state: bestCandidate.branch.state ? cloneBranchState(bestCandidate.branch.state) : undefined
    };
  }

  private findMarkerBranch(
    envelope: ResponseBranchReuseEnvelope,
    currentInput: readonly ResponsesInputMessage[],
    markerHint: ResponseBranchMarkerHint
  ): ReusableResponseBranchMatch | undefined {
    if (markerHint.incrementalInput.length === 0
      || !haveEquivalentResponsesInput(markerHint.incrementalInput, currentInput)) {
      return undefined;
    }

    for (const branch of this.branches.values()) {
      if (branch.responseId !== markerHint.responseId) {
        continue;
      }
      if (branch.envelope.identityKey !== envelope.identityKey
        || !hasMatchingRequestFingerprint(branch, envelope)
        || !hasCompatibleInputBudget(branch.envelope.effectiveInputBudget, envelope.effectiveInputBudget)
        || !compareToolSignatures(branch.envelope.toolSignatures, envelope.toolSignatures).compatible
        || !hasMarkerContinuationIntegrity(branch, markerHint.incrementalInput)) {
        return undefined;
      }

      return {
        branchId: branch.id,
        responseId: branch.responseId,
        comparison: {
          kind: 'append',
          matchedPrefixCount: 0,
          appendedInput: [...markerHint.incrementalInput]
        },
        state: branch.state ? cloneBranchState(branch.state) : undefined
      };
    }

    return undefined;
  }

  explainReuseMiss(
    envelope: ResponseBranchReuseEnvelope,
    currentInput: readonly ResponsesInputMessage[]
  ): ResponseBranchReuseMissDiagnostic | undefined {
    this.evictExpiredEntries();

    if (this.disabledReuseKeys.has(envelope.identityKey)) {
      return undefined;
    }

    const currentContinuationInput = projectResponsesInputForContinuation(currentInput);

    let bestDiagnostic: ResponseBranchReuseMissDiagnostic | undefined;

    for (const branch of this.branches.values()) {
      if (branch.envelope.scopeKey !== envelope.scopeKey) {
        continue;
      }

      const toolCompatibility = compareToolSignatures(branch.envelope.toolSignatures, envelope.toolSignatures);
      const comparison = compareResponsesInputHistory(branch.continuationInput, currentContinuationInput);
      if (!bestDiagnostic || comparison.matchedPrefixCount > bestDiagnostic.comparison.matchedPrefixCount) {
        bestDiagnostic = {
          branchId: branch.id,
          responseId: branch.responseId,
          comparison,
          previousInputCount: branch.continuationInput.length,
          currentInputCount: currentContinuationInput.length,
          previousNextItemSummary: summarizeResponsesInputMessageForLog(branch.continuationInput[comparison.matchedPrefixCount]),
          currentNextItemSummary: summarizeResponsesInputMessageForLog(currentContinuationInput[comparison.matchedPrefixCount]),
          requestFingerprintMatches: hasMatchingRequestFingerprint(branch, envelope),
          previousEffectiveInputBudget: branch.envelope.effectiveInputBudget,
          currentEffectiveInputBudget: envelope.effectiveInputBudget,
          inputBudgetCompatible: hasCompatibleInputBudget(
            branch.envelope.effectiveInputBudget,
            envelope.effectiveInputBudget
          ),
          toolCompatibility,
          state: branch.state ? cloneBranchState(branch.state) : undefined
        };
      }
    }

    return bestDiagnostic;
  }

  recordSuccess(
    envelope: ResponseBranchReuseEnvelope,
    currentInput: readonly ResponsesInputMessage[],
    responseId: string,
    branchId?: string,
    state?: CodexBranchState
  ): string {
    this.evictExpiredEntries();
    if (this.disabledReuseKeys.get(envelope.identityKey)?.enableAfterFullInputSuccess) {
      this.disabledReuseKeys.delete(envelope.identityKey);
    }
    const continuationInput = projectResponsesInputForContinuation(currentInput);

    if (branchId) {
      const existing = this.branches.get(branchId);
      if (existing) {
        existing.envelope = envelope;
        existing.input = [...currentInput];
        existing.continuationInput = continuationInput;
        existing.responseId = responseId;
        existing.state = state ? cloneBranchState(state) : existing.state;
        existing.updatedAt = Date.now();
        return existing.id;
      }
    }

    for (const branch of this.branches.values()) {
      if (branch.envelope.identityKey !== envelope.identityKey) {
        continue;
      }

      const comparison = compareResponsesInputHistory(branch.continuationInput, continuationInput);
      if (comparison.kind === 'append' && comparison.appendedInput.length === 0) {
        branch.input = [...currentInput];
        branch.continuationInput = continuationInput;
        branch.responseId = responseId;
        branch.envelope = envelope;
        branch.state = state ? cloneBranchState(state) : branch.state;
        branch.updatedAt = Date.now();
        return branch.id;
      }
    }

    const id = `branch_${this.nextBranchId++}`;
    this.branches.set(id, {
      id,
      envelope,
      input: [...currentInput],
      continuationInput,
      responseId,
      state: state ? cloneBranchState(state) : undefined,
      updatedAt: Date.now()
    });
    this.evictOverflow();
    return id;
  }

  invalidate(branchId: string): void {
    this.branches.delete(branchId);
  }

  invalidateResponseId(responseId: string): void {
    for (const [branchId, branch] of this.branches.entries()) {
      if (branch.responseId === responseId) {
        this.branches.delete(branchId);
      }
    }
  }

  updateState(branchId: string, update: (state: CodexBranchState) => CodexBranchState): void {
    const branch = this.branches.get(branchId);
    if (!branch?.state) {
      return;
    }
    branch.state = cloneBranchState(update(cloneBranchState(branch.state)));
    branch.updatedAt = Date.now();
  }

  disableReuse(envelope: ResponseBranchReuseEnvelope, enableAfterFullInputSuccess = true): void {
    this.evictExpiredEntries();
    this.disabledReuseKeys.set(envelope.identityKey, {
      disabledAt: Date.now(),
      enableAfterFullInputSuccess
    });
  }

  isReuseDisabled(envelope: ResponseBranchReuseEnvelope): boolean {
    this.evictExpiredEntries();
    return this.disabledReuseKeys.has(envelope.identityKey);
  }

  private evictExpiredEntries(): void {
    const now = Date.now();

    for (const [branchId, branch] of this.branches.entries()) {
      if (now - branch.updatedAt > this.ttlMs) {
        this.branches.delete(branchId);
      }
    }

    for (const [reuseKey, disabled] of this.disabledReuseKeys.entries()) {
      if (now - disabled.disabledAt > this.ttlMs) {
        this.disabledReuseKeys.delete(reuseKey);
      }
    }
  }

  private evictOverflow(): void {
    if (this.branches.size <= this.maxBranches) {
      return;
    }

    const branchesByAge = [...this.branches.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt);

    while (this.branches.size > this.maxBranches && branchesByAge.length > 0) {
      const oldest = branchesByAge.shift();
      if (oldest) {
        this.branches.delete(oldest.id);
      }
    }
  }
}

function cloneBranchState(state: CodexBranchState): CodexBranchState {
  return {
    ...state,
    identity: { ...state.identity },
    turn: { ...state.turn },
    continuation: state.continuation ? cloneCodexContinuationSnapshot(state.continuation) : undefined
  };
}

function hasMatchingRequestFingerprint(
  branch: ResponseBranchEntry,
  envelope: ResponseBranchReuseEnvelope
): boolean {
  return branch.envelope.requestFingerprint === envelope.requestFingerprint
    && branch.envelope.catalogHash === envelope.catalogHash
    && branch.envelope.toolPlanMode === envelope.toolPlanMode
    && (branch.state?.continuation?.requestFingerprint === undefined
      || (branch.state.continuation.requestFingerprint === envelope.requestFingerprint
        && branch.state.continuation.catalogHash === envelope.catalogHash));
}

function hasCompatibleInputBudget(previous: number | undefined, current: number | undefined): boolean {
  return typeof previous === 'number'
    && Number.isFinite(previous)
    && previous > 0
    && typeof current === 'number'
    && Number.isFinite(current)
    && current > 0
    && current >= previous;
}

function hasContinuationIntegrity(
  branch: ResponseBranchEntry,
  appendedInput: readonly ResponsesInputMessage[]
): boolean {
  const state = branch.state;
  if (!state?.turn.completed || !state.continuation || !Array.isArray(state.continuation.responseItems)) {
    return false;
  }

  const functionCallIds = new Set<string>();
  for (const item of state.continuation.responseItems) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const callId = typeof record.call_id === 'string' ? record.call_id.trim() : '';
    if (record.type === 'function_call' && callId) {
      functionCallIds.add(callId);
    }
  }

  if (functionCallIds.size === 0) {
    return true;
  }

  const outputCallIds = new Set(
    appendedInput
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.call_id.trim())
      .filter(Boolean)
  );
  return [...functionCallIds].every((callId) => outputCallIds.has(callId));
}

function hasMarkerContinuationIntegrity(
  branch: ResponseBranchEntry,
  appendedInput: readonly ResponsesInputMessage[]
): boolean {
  const state = branch.state;
  return Boolean(
    state?.continuation
    && state.continuation.responseId === branch.responseId
    && state.continuation.turnId === state.turn.id
    && state.continuation.toolPlanMode === branch.envelope.toolPlanMode
    && Array.isArray(state.continuation.fullRequest.input)
    && hasMatchingStoredRequestFingerprint(branch, state.continuation.fullRequest)
    && hasContinuationIntegrity(branch, appendedInput)
  );
}

function hasMatchingStoredRequestFingerprint(
  branch: ResponseBranchEntry,
  fullRequest: CodexContinuationSnapshot['fullRequest']
): boolean {
  let envelopeFingerprint: unknown;
  try {
    envelopeFingerprint = JSON.parse(branch.envelope.requestFingerprint);
  } catch {
    return false;
  }

  if (typeof envelopeFingerprint !== 'object' || envelopeFingerprint === null) {
    return false;
  }

  const record = envelopeFingerprint as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2
    && keys[0] === 'protocolSettings'
    && keys[1] === 'requestFingerprint'
    && typeof record.requestFingerprint === 'string'
    && fingerprintCodexRequest(fullRequest) === record.requestFingerprint;
}

function haveEquivalentResponsesInput(
  left: readonly ResponsesInputMessage[],
  right: readonly ResponsesInputMessage[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return compareResponsesInputHistory(left, right).matchedPrefixCount === left.length;
}

function compareToolSignatures(
  previousToolSignatures: ResponseBranchToolSignatures | undefined,
  currentToolSignatures: ResponseBranchToolSignatures | undefined
): ResponseBranchToolCompatibility {
  const previousEntries = Object.entries(previousToolSignatures ?? {});
  const currentEntries = Object.entries(currentToolSignatures ?? {});
  const missingToolNames: string[] = [];
  const addedToolNames: string[] = [];
  const changedToolNames: string[] = [];

  for (const [name, previousSignature] of previousEntries) {
    const currentSignature = currentToolSignatures?.[name];

    if (currentSignature === undefined) {
      missingToolNames.push(name);
      continue;
    }

    if (currentSignature !== previousSignature) {
      changedToolNames.push(name);
    }
  }

  for (const [name] of currentEntries) {
    if (previousToolSignatures?.[name] === undefined) {
      addedToolNames.push(name);
    }
  }

  return {
    compatible: missingToolNames.length === 0 && addedToolNames.length === 0 && changedToolNames.length === 0,
    missingToolNames,
    addedToolNames,
    changedToolNames
  };
}
