export type StreamPresentationKind = 'text' | 'reasoning';

export interface StreamPresentationPart {
  kind: StreamPresentationKind;
  identity: string;
  text: string;
  emit: (text: string) => void;
}

export interface StreamPresentationMetrics {
  backendDeltaCount: number;
  progressReportCount: number;
  coalescedDeltaCount: number;
  reportedCharacterCount: number;
  largestReportCharacters: number;
  maxPendingCharacters: number;
  catchUpReportCount: number;
  reportGapMaxMs: number;
  boundaryDrainReportCount: number;
  boundaryDrainDurationMs: number;
  firstBackendDeltaAt?: number;
  firstReportAt?: number;
  coalescingDelayP95Ms?: number;
  coalescingDelayMaxMs?: number;
  /** Internal timing samples used when several presenters share one response. */
  coalescingDelaysMs: readonly number[];
}

export interface StreamPresenterTimer {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

export interface StreamPresenterOptions {
  now?: () => number;
  minReportIntervalMs?: number;
  maxReportIntervalMs?: number;
  maxReportCharacters?: number;
  targetReportCharacters?: number;
  smoothingBufferCharacters?: number;
  timerApi?: StreamPresenterTimer;
}

interface PendingPresentationPart extends StreamPresentationPart {
  key: string;
  deltaCount: number;
  firstBufferedAt: number;
}

const DEFAULT_MIN_REPORT_INTERVAL_MS = 80;
const DEFAULT_MAX_REPORT_INTERVAL_MS = 80;
const DEFAULT_MAX_REPORT_CHARACTERS = 64;

/**
 * Presents one response stream as a paced sequence of bounded updates.
 *
 * VS Code's progress reporter has no consumer acknowledgement, so emitting
 * either every backend delta or one large final delta can build an invisible
 * queue in Copilot Chat. This presenter bounds both update frequency and
 * update size, then explicitly drains the final queue before completion.
 */
export class StreamPresenter {
  private pending?: PendingPresentationPart;
  private timer?: ReturnType<typeof setTimeout>;
  private lastReportedKey?: string;
  private lastReportAt?: number;
  private backendDeltaCount = 0;
  private progressReportCount = 0;
  private coalescedDeltaCount = 0;
  private reportedCharacterCount = 0;
  private largestReportCharacters = 0;
  private maxPendingCharacters = 0;
  private catchUpReportCount = 0;
  private reportGapMaxMs = 0;
  private boundaryDrainReportCount = 0;
  private boundaryDrainDurationMs = 0;
  private firstBackendDeltaAt?: number;
  private firstReportAt?: number;
  private readonly coalescingDelaysMs: number[] = [];
  private readonly now: () => number;
  private readonly minReportIntervalMs: number;
  private readonly maxReportIntervalMs: number;
  private readonly maxReportCharacters: number;
  private readonly targetReportCharacters: number;
  private readonly smoothingBufferCharacters: number;
  private readonly timerApi: StreamPresenterTimer;

  constructor(
    private readonly onBackendDelta?: (kind: StreamPresentationKind, at: number) => void,
    private readonly onReport?: (kind: StreamPresentationKind, at: number) => void,
    options: StreamPresenterOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.minReportIntervalMs = Math.max(0, options.minReportIntervalMs ?? DEFAULT_MIN_REPORT_INTERVAL_MS);
    this.maxReportIntervalMs = Math.max(
      this.minReportIntervalMs,
      options.maxReportIntervalMs ?? DEFAULT_MAX_REPORT_INTERVAL_MS
    );
    this.maxReportCharacters = Math.max(1, options.maxReportCharacters ?? DEFAULT_MAX_REPORT_CHARACTERS);
    this.targetReportCharacters = Math.min(
      this.maxReportCharacters,
      Math.max(1, options.targetReportCharacters ?? this.maxReportCharacters)
    );
    this.smoothingBufferCharacters = Math.max(0, options.smoothingBufferCharacters ?? 0);
    this.timerApi = options.timerApi ?? {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer)
    };
  }

  push(part: StreamPresentationPart): void {
    if (!part.text) {
      return;
    }

    const receivedAt = this.now();
    const key = `${part.kind}:${part.identity}`;
    this.backendDeltaCount += 1;
    this.firstBackendDeltaAt ??= receivedAt;
    this.onBackendDelta?.(part.kind, receivedAt);

    if (this.pending && this.pending.key !== key) {
      this.flush();
    }

    if (!this.pending && this.lastReportedKey !== key) {
      const [visibleText, remainingText] = splitAtCharacterBoundary(part.text, this.targetReportCharacters);
      this.report(part, visibleText, receivedAt);
      this.lastReportedKey = key;
      if (remainingText) {
        this.pending = {
          ...part,
          text: remainingText,
          key,
          deltaCount: 0,
          firstBufferedAt: receivedAt
        };
        this.recordPendingDepth();
        this.schedulePending();
      }
      return;
    }

    if (!this.pending) {
      this.pending = {
        ...part,
        key,
        deltaCount: 1,
        firstBufferedAt: receivedAt
      };
    } else {
      this.pending.text += part.text;
      this.pending.deltaCount += 1;
    }
    this.recordPendingDepth();
    this.schedulePending();
  }

  /** Immediately flushes all pending text, retaining bounded report sizes. */
  flush(): void {
    this.clearTimer();
    while (this.pending) {
      this.flushOne(true);
    }
  }

  /** Immediately completes a semantic phase, such as the boundary before a tool call. */
  flushBoundary(): void {
    this.flush();
    this.resetBoundary();
  }

  /**
   * Paces any final backlog before allowing the provider response to finish.
   * This prevents a large final report from becoming post-completion UI work.
   */
  async drainBoundary(shouldStop?: () => boolean): Promise<void> {
    this.clearTimer();
    const startedAt = this.now();
    const initialReportCount = this.progressReportCount;
    if (this.pending && this.pending.text.length <= this.targetReportCharacters) {
      this.flushOne(true);
    }
    while (this.pending) {
      if (shouldStop?.()) {
        this.flushBoundary();
        break;
      }
      const delayMs = Math.max(0, (this.lastReportAt ?? this.now()) + this.minReportIntervalMs - this.now());
      if (delayMs > 0) {
        await this.wait(delayMs);
      }
      this.flushOne(true);
    }
    this.boundaryDrainReportCount += this.progressReportCount - initialReportCount;
    this.boundaryDrainDurationMs += Math.max(0, this.now() - startedAt);
    this.resetBoundary();
  }

  get pendingCharacters(): number {
    return this.pending?.text.length ?? 0;
  }

  metrics(): StreamPresentationMetrics {
    const delays = [...this.coalescingDelaysMs].sort((left, right) => left - right);
    return {
      backendDeltaCount: this.backendDeltaCount,
      progressReportCount: this.progressReportCount,
      coalescedDeltaCount: this.coalescedDeltaCount,
      reportedCharacterCount: this.reportedCharacterCount,
      largestReportCharacters: this.largestReportCharacters,
      maxPendingCharacters: this.maxPendingCharacters,
      catchUpReportCount: this.catchUpReportCount,
      reportGapMaxMs: this.reportGapMaxMs,
      boundaryDrainReportCount: this.boundaryDrainReportCount,
      boundaryDrainDurationMs: this.boundaryDrainDurationMs,
      firstBackendDeltaAt: this.firstBackendDeltaAt,
      firstReportAt: this.firstReportAt,
      coalescingDelayP95Ms: percentile(delays, 0.95),
      coalescingDelayMaxMs: delays.at(-1),
      coalescingDelaysMs: delays
    };
  }

  private flushOne(forceCatchUp = false): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    const catchUp = forceCatchUp || this.shouldCatchUp(pending.text.length);
    const reportCharacters = catchUp
      ? this.maxReportCharacters
      : this.targetReportCharacters;
    const [visibleText, remainingText] = splitAtCharacterBoundary(pending.text, reportCharacters);
    const reportedAt = this.now();
    this.coalescedDeltaCount += Math.max(0, pending.deltaCount - 1);
    this.coalescingDelaysMs.push(Math.max(0, reportedAt - pending.firstBufferedAt));
    if (catchUp) {
      this.catchUpReportCount += 1;
    }
    this.report(pending, visibleText, reportedAt);
    this.lastReportedKey = pending.key;

    if (!remainingText) {
      this.pending = undefined;
      return;
    }
    pending.text = remainingText;
    pending.deltaCount = 0;
  }

  private report(part: StreamPresentationPart, text: string, reportedAt: number): void {
    part.emit(text);
    this.progressReportCount += 1;
    this.reportedCharacterCount += text.length;
    this.largestReportCharacters = Math.max(this.largestReportCharacters, text.length);
    if (this.lastReportAt !== undefined) {
      this.reportGapMaxMs = Math.max(this.reportGapMaxMs, reportedAt - this.lastReportAt);
    }
    this.firstReportAt ??= reportedAt;
    this.lastReportAt = reportedAt;
    this.onReport?.(part.kind, reportedAt);
  }

  private schedulePending(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.clearTimer();
    const now = this.now();
    const lastReportAt = this.lastReportAt ?? now;
    const deadline = this.shouldCatchUp(pending.text.length)
      ? lastReportAt + this.minReportIntervalMs
      : lastReportAt + this.maxReportIntervalMs;
    const delayMs = Math.max(0, deadline - now);
    if (delayMs === 0) {
      this.flushOne();
      this.schedulePending();
      return;
    }
    this.armTimer(delayMs);
  }

  private shouldCatchUp(pendingCharacters: number): boolean {
    return this.smoothingBufferCharacters > 0
      ? pendingCharacters > this.smoothingBufferCharacters
      : pendingCharacters >= this.maxReportCharacters;
  }

  private recordPendingDepth(): void {
    this.maxPendingCharacters = Math.max(this.maxPendingCharacters, this.pending?.text.length ?? 0);
  }

  private armTimer(delayMs: number): void {
    this.timer = this.timerApi.set(() => {
      this.timer = undefined;
      this.flushOne();
      this.schedulePending();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    this.timerApi.clear(this.timer);
    this.timer = undefined;
  }

  private resetBoundary(): void {
    this.lastReportedKey = undefined;
    this.lastReportAt = undefined;
  }

  private async wait(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.timer = this.timerApi.set(() => {
        this.timer = undefined;
        resolve();
      }, delayMs);
    });
  }
}

/** Combines text and reasoning presentation telemetry for one response stream. */
export function mergeStreamPresentationMetrics(
  ...metrics: readonly StreamPresentationMetrics[]
): StreamPresentationMetrics {
  const delays = metrics.flatMap((metric) => metric.coalescingDelaysMs).sort((left, right) => left - right);
  return {
    backendDeltaCount: metrics.reduce((total, metric) => total + metric.backendDeltaCount, 0),
    progressReportCount: metrics.reduce((total, metric) => total + metric.progressReportCount, 0),
    coalescedDeltaCount: metrics.reduce((total, metric) => total + metric.coalescedDeltaCount, 0),
    reportedCharacterCount: metrics.reduce((total, metric) => total + metric.reportedCharacterCount, 0),
    largestReportCharacters: Math.max(0, ...metrics.map((metric) => metric.largestReportCharacters)),
    maxPendingCharacters: Math.max(0, ...metrics.map((metric) => metric.maxPendingCharacters)),
    catchUpReportCount: metrics.reduce((total, metric) => total + metric.catchUpReportCount, 0),
    reportGapMaxMs: Math.max(0, ...metrics.map((metric) => metric.reportGapMaxMs)),
    boundaryDrainReportCount: metrics.reduce((total, metric) => total + metric.boundaryDrainReportCount, 0),
    boundaryDrainDurationMs: Math.max(0, ...metrics.map((metric) => metric.boundaryDrainDurationMs)),
    firstBackendDeltaAt: firstDefined(metrics.map((metric) => metric.firstBackendDeltaAt)),
    firstReportAt: firstDefined(metrics.map((metric) => metric.firstReportAt)),
    coalescingDelayP95Ms: percentile(delays, 0.95),
    coalescingDelayMaxMs: delays.at(-1),
    coalescingDelaysMs: delays
  };
}

function splitAtCharacterBoundary(text: string, maxCharacters: number): [string, string] {
  if (text.length <= maxCharacters) {
    return [text, ''];
  }
  let splitAt = maxCharacters;
  const lastCodeUnit = text.charCodeAt(splitAt - 1);
  if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) {
    splitAt = splitAt === 1 ? 2 : splitAt - 1;
  }
  return [text.slice(0, splitAt), text.slice(splitAt)];
}

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function firstDefined(values: readonly (number | undefined)[]): number | undefined {
  return values.filter((value): value is number => value !== undefined).sort((left, right) => left - right)[0];
}
