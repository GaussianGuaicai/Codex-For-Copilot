import {
  compareResponsesInputHistory,
  projectResponsesInputForContinuation,
  summarizeResponsesInputMessageForLog,
  type ResponsesInputHistoryComparison,
  type ResponsesInputMessage
} from './convertMessages';

export interface ReusableResponseBranchMatch {
  branchId: string;
  responseId: string;
  comparison: ResponsesInputHistoryComparison;
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
}

export type ResponseBranchToolSignatures = Readonly<Record<string, string>>;

export interface ResponseBranchToolCompatibility {
  compatible: boolean;
  missingToolNames: string[];
  addedToolNames: string[];
  changedToolNames: string[];
}

interface ResponseBranchEntry {
  id: string;
  envelope: ResponseBranchReuseEnvelope;
  input: ResponsesInputMessage[];
  continuationInput: ResponsesInputMessage[];
  responseId: string;
  updatedAt: number;
}

export class ResponseBranchStore {
  private readonly branches = new Map<string, ResponseBranchEntry>();
  private readonly disabledReuseKeys = new Map<string, number>();
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
          comparison
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
          toolCompatibility
        };
      }
    }

    return bestDiagnostic;
  }

  recordSuccess(
    envelope: ResponseBranchReuseEnvelope,
    currentInput: readonly ResponsesInputMessage[],
    responseId: string,
    branchId?: string
  ): string {
    this.evictExpiredEntries();
    this.disabledReuseKeys.delete(envelope.identityKey);
    const continuationInput = projectResponsesInputForContinuation(currentInput);

    if (branchId) {
      const existing = this.branches.get(branchId);
      if (existing) {
        existing.envelope = envelope;
        existing.input = [...currentInput];
        existing.continuationInput = continuationInput;
        existing.responseId = responseId;
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

  disableReuse(envelope: ResponseBranchReuseEnvelope): void {
    this.evictExpiredEntries();
    this.disabledReuseKeys.set(envelope.identityKey, Date.now());
  }

  private evictExpiredEntries(): void {
    const now = Date.now();

    for (const [branchId, branch] of this.branches.entries()) {
      if (now - branch.updatedAt > this.ttlMs) {
        this.branches.delete(branchId);
      }
    }

    for (const [reuseKey, disabledAt] of this.disabledReuseKeys.entries()) {
      if (now - disabledAt > this.ttlMs) {
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
