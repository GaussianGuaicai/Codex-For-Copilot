import {
  compareResponsesInputHistory,
  projectResponsesInputForContinuation,
  summarizeResponsesInputMessageForLog,
  type ResponsesInputHistoryComparison,
  type ResponsesInputMessage
} from './convertMessages';
import type { CodexRequestIdentity } from './codexProtocol';
import type { CodexResponsesRequest } from './codexRequestBuilder';

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
  lastRequest?: CodexResponsesRequest;
  lastResponseId?: string;
  lastResponseItems: unknown[];
  requestFingerprint?: string;
  updatedAt: number;
}

export interface ReusableResponseBranchMatch {
  branchId: string;
  responseId: string;
  comparison: ResponsesInputHistoryComparison;
  state?: CodexBranchState;
}

export interface ResponseBranchReuseEnvelope {
  identityKey: string;
  toolSignatures?: ResponseBranchToolSignatures;
}

export interface ResponseBranchReuseMissDiagnostic {
  branchId: string;
  responseId: string;
  comparison: ResponsesInputHistoryComparison;
  previousInputCount: number;
  currentInputCount: number;
  previousNextItemSummary: string | null;
  currentNextItemSummary: string | null;
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
    currentInput: readonly ResponsesInputMessage[]
  ): ReusableResponseBranchMatch | undefined {
    this.evictExpiredEntries();

    if (this.disabledReuseKeys.has(envelope.identityKey)) {
      return undefined;
    }

    const currentContinuationInput = projectResponsesInputForContinuation(currentInput);

    let bestMatch: ReusableResponseBranchMatch | undefined;

    for (const branch of this.branches.values()) {
      if (branch.envelope.identityKey !== envelope.identityKey) {
        continue;
      }

      if (!compareToolSignatures(branch.envelope.toolSignatures, envelope.toolSignatures).compatible) {
        continue;
      }

      const comparison = compareResponsesInputHistory(branch.continuationInput, currentContinuationInput);
      if (comparison.kind !== 'append' || comparison.appendedInput.length === 0) {
        continue;
      }

      if (!bestMatch || comparison.matchedPrefixCount > bestMatch.comparison.matchedPrefixCount) {
        bestMatch = {
          branchId: branch.id,
          responseId: branch.responseId,
          comparison,
          state: branch.state ? cloneBranchState(branch.state) : undefined
        };
      }
    }

    return bestMatch;
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
      if (branch.envelope.identityKey !== envelope.identityKey) {
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
    lastResponseItems: [...state.lastResponseItems],
    lastRequest: state.lastRequest ? structuredClone(state.lastRequest) : undefined
  };
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
