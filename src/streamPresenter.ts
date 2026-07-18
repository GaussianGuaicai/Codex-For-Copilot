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
  firstBackendDeltaAt?: number;
  firstReportAt?: number;
  coalescingDelayP95Ms?: number;
  coalescingDelayMaxMs?: number;
}

export interface StreamPresenterTimer {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

interface PendingPresentationPart extends StreamPresentationPart {
  key: string;
  deltaCount: number;
  firstBufferedAt: number;
}

/**
 * Presents one response stream without changing its event order. The first
 * part of a logical stream is emitted immediately; later adjacent deltas are
 * briefly coalesced to keep Extension Host and Chat rendering work bounded.
 */
export class StreamPresenter {
  private pending?: PendingPresentationPart;
  private timer?: ReturnType<typeof setTimeout>;
  private lastReportedKey?: string;
  private backendDeltaCount = 0;
  private progressReportCount = 0;
  private coalescedDeltaCount = 0;
  private firstBackendDeltaAt?: number;
  private firstReportAt?: number;
  private readonly coalescingDelaysMs: number[] = [];

  constructor(
    private readonly onBackendDelta?: (kind: StreamPresentationKind, at: number) => void,
    private readonly onReport?: (kind: StreamPresentationKind, at: number) => void,
    private readonly now: () => number = Date.now,
    private readonly maxDelayMs = 8,
    private readonly maxCharacters = 256,
    private readonly timerApi: StreamPresenterTimer = {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (timer) => clearTimeout(timer)
    }
  ) {}

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

    if (!this.pending) {
      if (this.lastReportedKey !== key) {
        this.report(part, part.text, receivedAt);
        this.lastReportedKey = key;
        return;
      }

      this.pending = {
        ...part,
        key,
        deltaCount: 1,
        firstBufferedAt: receivedAt
      };
      this.armTimer();
      return;
    }

    this.pending.text += part.text;
    this.pending.deltaCount += 1;
    if (this.pending.text.length >= this.maxCharacters) {
      this.flush();
    }
  }

  flush(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    this.pending = undefined;
    this.clearTimer();
    const reportedAt = this.now();
    this.coalescedDeltaCount += Math.max(0, pending.deltaCount - 1);
    this.coalescingDelaysMs.push(Math.max(0, reportedAt - pending.firstBufferedAt));
    this.report(pending, pending.text, reportedAt);
    this.lastReportedKey = pending.key;
  }

  flushBoundary(): void {
    this.flush();
    this.lastReportedKey = undefined;
  }

  metrics(): StreamPresentationMetrics {
    const delays = [...this.coalescingDelaysMs].sort((left, right) => left - right);
    return {
      backendDeltaCount: this.backendDeltaCount,
      progressReportCount: this.progressReportCount,
      coalescedDeltaCount: this.coalescedDeltaCount,
      firstBackendDeltaAt: this.firstBackendDeltaAt,
      firstReportAt: this.firstReportAt,
      coalescingDelayP95Ms: percentile(delays, 0.95),
      coalescingDelayMaxMs: delays.at(-1)
    };
  }

  private report(part: StreamPresentationPart, text: string, reportedAt: number): void {
    part.emit(text);
    this.progressReportCount += 1;
    this.firstReportAt ??= reportedAt;
    this.onReport?.(part.kind, reportedAt);
  }

  private armTimer(): void {
    this.timer = this.timerApi.set(() => this.flush(), this.maxDelayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    this.timerApi.clear(this.timer);
    this.timer = undefined;
  }
}

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}
