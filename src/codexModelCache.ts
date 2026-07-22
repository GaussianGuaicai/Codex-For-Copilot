export type CodexModelCacheState = 'cold' | 'fresh' | 'stale';

export const MODEL_CACHE_FRESH_TTL_MS = 10 * 60 * 1000;
export const MODEL_CACHE_STALE_TTL_MS = 60 * 60 * 1000;

export interface CodexModelCacheLookup<T> {
  value: T;
  state: CodexModelCacheState;
  refreshStarted: boolean;
  refresh?: Promise<T>;
}

export interface CodexModelCacheOptions {
  freshTtlMs: number;
  staleTtlMs: number;
  maxEntries?: number;
  now?: () => number;
}

export interface CodexModelCacheWriteOptions {
  freshTtlMs?: number;
  staleTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  refreshedAt: number;
  freshUntil: number;
  staleUntil: number;
  version: string;
}

interface InFlightRefresh<T> {
  promise: Promise<T>;
  version: string;
}

const DEFAULT_MAX_ENTRIES = 16;

export class CodexModelCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlightRefreshes = new Map<string, InFlightRefresh<T>>();
  private readonly invalidationVersions = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private cacheGeneration = 0;

  constructor(private readonly options: CodexModelCacheOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  }

  async get(key: string, load: () => Promise<T>): Promise<CodexModelCacheLookup<T>> {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry?.version === this.versionFor(key) && entry.freshUntil > now) {
      return {
        value: entry.value,
        state: 'fresh',
        refreshStarted: false
      };
    }

    if (entry?.version === this.versionFor(key) && entry.staleUntil > now) {
      const refresh = this.startRefresh(key, load);
      return {
        value: entry.value,
        state: 'stale',
        refreshStarted: refresh.started,
        refresh: refresh.promise
      };
    }

    const refresh = this.startRefresh(key, load);
    return {
      value: await refresh.promise,
      state: 'cold',
      refreshStarted: refresh.started
    };
  }

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry?.version === this.versionFor(key) ? entry.value : undefined;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.invalidationVersions.set(key, (this.invalidationVersions.get(key) ?? 0) + 1);
  }

  set(key: string, value: T, writeOptions: CodexModelCacheWriteOptions = {}): void {
    const refreshedAt = this.now();
    const freshTtlMs = writeOptions.freshTtlMs ?? this.options.freshTtlMs;
    const staleTtlMs = writeOptions.staleTtlMs ?? this.options.staleTtlMs;
    this.entries.set(key, {
      value,
      refreshedAt,
      freshUntil: refreshedAt + freshTtlMs,
      staleUntil: refreshedAt + staleTtlMs,
      version: this.versionFor(key)
    });
    this.evictOverflow();
  }

  clear(): void {
    this.entries.clear();
    this.invalidationVersions.clear();
    this.cacheGeneration += 1;
  }

  private startRefresh(key: string, load: () => Promise<T>): { promise: Promise<T>; started: boolean } {
    const version = this.versionFor(key);
    const existing = this.inFlightRefreshes.get(key);
    if (existing?.version === version) {
      return { promise: existing.promise, started: false };
    }

    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (this.versionFor(key) === version) {
          this.set(key, value);
        }
        return value;
      })
      .finally(() => {
        if (this.inFlightRefreshes.get(key)?.promise === promise) {
          this.inFlightRefreshes.delete(key);
        }
      });
    this.inFlightRefreshes.set(key, { promise, version });
    return { promise, started: true };
  }

  private versionFor(key: string): string {
    return `${this.cacheGeneration}:${this.invalidationVersions.get(key) ?? 0}`;
  }

  private evictOverflow(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    const entriesByAge = [...this.entries.entries()]
      .sort((left, right) => left[1].refreshedAt - right[1].refreshedAt);
    while (this.entries.size > this.maxEntries) {
      const oldest = entriesByAge.shift();
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest[0]);
    }
  }
}
