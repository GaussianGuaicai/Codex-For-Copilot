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

export interface ResponseBranchReuseMissDiagnostic {
  branchId: string;
  responseId: string;
  comparison: ResponsesInputHistoryComparison;
  previousInputCount: number;
  currentInputCount: number;
  previousNextItemSummary: string | null;
  currentNextItemSummary: string | null;
}

interface ResponseBranchEntry {
  id: string;
  reuseKey: string;
  input: ResponsesInputMessage[];
  continuationInput: ResponsesInputMessage[];
  responseId: string;
  updatedAt: number;
}

export class ResponseBranchStore {
  private readonly branches = new Map<string, ResponseBranchEntry>();
  private nextBranchId = 1;

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxBranches = 64
  ) {}

  findReusableBranch(reuseKey: string, currentInput: readonly ResponsesInputMessage[]): ReusableResponseBranchMatch | undefined {
    this.evictExpiredEntries();
    const currentContinuationInput = projectResponsesInputForContinuation(currentInput);

    let bestMatch: ReusableResponseBranchMatch | undefined;

    for (const branch of this.branches.values()) {
      if (branch.reuseKey !== reuseKey) {
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

  explainReuseMiss(reuseKey: string, currentInput: readonly ResponsesInputMessage[]): ResponseBranchReuseMissDiagnostic | undefined {
    this.evictExpiredEntries();
    const currentContinuationInput = projectResponsesInputForContinuation(currentInput);

    let bestDiagnostic: ResponseBranchReuseMissDiagnostic | undefined;

    for (const branch of this.branches.values()) {
      if (branch.reuseKey !== reuseKey) {
        continue;
      }

      const comparison = compareResponsesInputHistory(branch.continuationInput, currentContinuationInput);
      if (!bestDiagnostic || comparison.matchedPrefixCount > bestDiagnostic.comparison.matchedPrefixCount) {
        bestDiagnostic = {
          branchId: branch.id,
          responseId: branch.responseId,
          comparison,
          previousInputCount: branch.continuationInput.length,
          currentInputCount: currentContinuationInput.length,
          previousNextItemSummary: summarizeResponsesInputMessageForLog(branch.continuationInput[comparison.matchedPrefixCount]),
          currentNextItemSummary: summarizeResponsesInputMessageForLog(currentContinuationInput[comparison.matchedPrefixCount])
        };
      }
    }

    return bestDiagnostic;
  }

  recordSuccess(
    reuseKey: string,
    currentInput: readonly ResponsesInputMessage[],
    responseId: string,
    branchId?: string
  ): string {
    this.evictExpiredEntries();
    const continuationInput = projectResponsesInputForContinuation(currentInput);

    if (branchId) {
      const existing = this.branches.get(branchId);
      if (existing) {
        existing.reuseKey = reuseKey;
        existing.input = [...currentInput];
        existing.continuationInput = continuationInput;
        existing.responseId = responseId;
        existing.updatedAt = Date.now();
        return existing.id;
      }
    }

    for (const branch of this.branches.values()) {
      if (branch.reuseKey !== reuseKey) {
        continue;
      }

      const comparison = compareResponsesInputHistory(branch.continuationInput, continuationInput);
      if (comparison.kind === 'append' && comparison.appendedInput.length === 0) {
        branch.input = [...currentInput];
        branch.continuationInput = continuationInput;
        branch.responseId = responseId;
        branch.updatedAt = Date.now();
        return branch.id;
      }
    }

    const id = `branch_${this.nextBranchId++}`;
    this.branches.set(id, {
      id,
      reuseKey,
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

  private evictExpiredEntries(): void {
    const now = Date.now();

    for (const [branchId, branch] of this.branches.entries()) {
      if (now - branch.updatedAt > this.ttlMs) {
        this.branches.delete(branchId);
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