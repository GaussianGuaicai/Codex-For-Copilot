import type { ReasoningStreamDelta } from './responsesClient';
import { StreamPresenter, type StreamPresentationMetrics } from './streamPresenter';

export type ReasoningPresentationMode = 'idle' | 'reasoning-text' | 'summary' | 'closed';

export interface ReasoningPresentationUpdate {
  value: string;
  itemId: string;
  source: ReasoningStreamDelta['source'];
  partIndex: number;
  outputIndex: number;
  presentationId?: string;
  phase: number;
  id: string;
}

export interface ReasoningStreamPresenterOptions {
  onBackendDelta?: (at: number) => void;
}

const MAX_RAW_FALLBACK_CHARACTERS = 8_192;

/** Owns one response's thinking presentation lifecycle, independently of transport and VS Code APIs. */
export class ReasoningStreamPresenter {
  private mode: ReasoningPresentationMode = 'idle';
  private phase = 0;
  private rawFallback?: { delta: ReasoningStreamDelta; identity: string; text: string };
  private rawFallbackTruncated = false;
  private rawBackendDeltaCount = 0;
  private rawProgressReportCount = 0;
  private rawFirstBackendDeltaAt?: number;
  private rawFirstReportAt?: number;
  private hasPresentedSummary = false;
  private lastSummaryIdentity?: string;
  private readonly stream: StreamPresenter;

  constructor(
    private readonly emit: (update: ReasoningPresentationUpdate) => void,
    private readonly options: ReasoningStreamPresenterOptions = {}
  ) {
    this.stream = new StreamPresenter(
      (_kind, at) => this.options.onBackendDelta?.(at)
    );
  }

  push(delta: ReasoningStreamDelta): void {
    if (!delta.text || this.mode === 'closed') {
      return;
    }
    if (delta.source === 'reasoning-text' && this.mode === 'summary') {
      return;
    }

    if (delta.source === 'reasoning-text') {
      this.bufferRawFallback(delta);
      this.mode = 'reasoning-text';
      return;
    }

    if (this.mode === 'reasoning-text') {
      // VS Code concatenates adjacent Thinking parts regardless of their IDs.
      // Do not report raw deltas before we know whether a server summary exists.
      this.rawFallback = undefined;
      this.rawFallbackTruncated = false;
      this.stream.flushBoundary();
    }

    this.mode = 'summary';
    const id = this.summaryIdentity(delta);
    const isNextSummaryPart = this.hasPresentedSummary && this.lastSummaryIdentity !== id;
    this.hasPresentedSummary = true;
    this.lastSummaryIdentity = id;
    this.stream.push({
      kind: 'reasoning',
      identity: id,
      // IDs are not visual boundaries in VS Code's Thinking renderer. A
      // textual boundary keeps independently declared summary parts readable.
      text: `${isNextSummaryPart ? '\n\n' : ''}${delta.text}`,
      emit: (text) => this.emit({ ...delta, value: text, phase: this.phase, id })
    });
  }

  flush(): void {
    this.stream.flushBoundary();
  }

  /** Starts a new visual reasoning phase after a tool call. */
  startNextPhase(): void {
    this.finishPhase();
    this.phase += 1;
    this.mode = 'idle';
    this.hasPresentedSummary = false;
    this.lastSummaryIdentity = undefined;
  }

  close(): void {
    if (this.mode !== 'closed') {
      this.finishPhase();
      this.mode = 'closed';
    }
  }

  get presentationMode(): ReasoningPresentationMode {
    return this.mode;
  }

  metrics(): StreamPresentationMetrics {
    const summaryMetrics = this.stream.metrics();
    return {
      ...summaryMetrics,
      backendDeltaCount: summaryMetrics.backendDeltaCount + this.rawBackendDeltaCount,
      progressReportCount: summaryMetrics.progressReportCount + this.rawProgressReportCount,
      firstBackendDeltaAt: firstDefined(summaryMetrics.firstBackendDeltaAt, this.rawFirstBackendDeltaAt),
      firstReportAt: firstDefined(summaryMetrics.firstReportAt, this.rawFirstReportAt)
    };
  }

  private finishPhase(): void {
    if (this.mode === 'reasoning-text') {
      this.emitRawFallback();
      return;
    }
    this.stream.flushBoundary();
  }

  private bufferRawFallback(delta: ReasoningStreamDelta): void {
    const receivedAt = Date.now();
    this.rawBackendDeltaCount += 1;
    this.rawFirstBackendDeltaAt ??= receivedAt;
    this.options.onBackendDelta?.(receivedAt);

    const identity = `${delta.itemId}:${delta.outputIndex}:${delta.partIndex}`;
    const separator = this.rawFallback && this.rawFallback.identity !== identity ? '\n\n' : '';
    if (!this.rawFallback) {
      this.rawFallback = { delta, identity, text: '' };
    }
    const remaining = MAX_RAW_FALLBACK_CHARACTERS - this.rawFallback.text.length;
    if (remaining <= 0) {
      this.rawFallbackTruncated = true;
      return;
    }
    const addition = `${separator}${delta.text}`;
    this.rawFallback.text += addition.slice(0, remaining);
    this.rawFallbackTruncated ||= addition.length > remaining;
  }

  private emitRawFallback(): void {
    const rawFallback = this.rawFallback;
    this.rawFallback = undefined;
    if (!rawFallback?.text) {
      return;
    }
    const reportedAt = Date.now();
    const id = `${rawFallback.delta.itemId}:reasoning:reasoning-text:${rawFallback.delta.partIndex}:phase:${this.phase}`;
    this.emit({
      ...rawFallback.delta,
      value: `${rawFallback.text}${this.rawFallbackTruncated ? '\n\n[Reasoning output truncated]' : ''}`,
      phase: this.phase,
      id
    });
    this.rawProgressReportCount += 1;
    this.rawFirstReportAt ??= reportedAt;
    this.rawFallbackTruncated = false;
  }

  private summaryIdentity(delta: ReasoningStreamDelta): string {
    const semanticPartId = delta.presentationId ?? String(delta.partIndex);
    return `${delta.itemId}:reasoning:summary:${semanticPartId}:phase:${this.phase}`;
  }
}

function firstDefined(...values: readonly (number | undefined)[]): number | undefined {
  return values.filter((value): value is number => value !== undefined).sort((left, right) => left - right)[0];
}
