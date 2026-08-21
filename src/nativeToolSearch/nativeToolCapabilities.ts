import { supportsNativeToolSearchModel } from './nativeToolPolicy';

const unsupported = new Map<string, number>();
const TTL_MS = 10 * 60 * 1000;
const MAX_UNSUPPORTED_CAPABILITIES = 64;

export function nativeToolSearchCapabilityKey(baseURL: string, authIdentity: string, model: string): string {
  return JSON.stringify([baseURL, authIdentity, model]);
}

export function canUseNativeToolSearch(model: string, key: string): boolean {
  pruneUnsupportedCapabilities(Date.now());
  const rejectedAt = unsupported.get(key);
  if (rejectedAt !== undefined) {
    unsupported.delete(key);
    unsupported.set(key, rejectedAt);
    return false;
  }
  return supportsNativeToolSearchModel(model);
}

export function markNativeToolSearchUnsupported(key: string): void {
  const now = Date.now();
  pruneUnsupportedCapabilities(now);
  unsupported.delete(key);
  unsupported.set(key, now);
  pruneUnsupportedCapabilities(now);
}

export function isNativeToolSearchUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(unsupported tool type:\s*(namespace|tool_search)|unknown field:\s*defer_loading|model does not support tool_search)/i.test(message);
}

function pruneUnsupportedCapabilities(now: number): void {
  for (const [key, rejectedAt] of unsupported) {
    if (now - rejectedAt > TTL_MS) {
      unsupported.delete(key);
    }
  }
  while (unsupported.size > MAX_UNSUPPORTED_CAPABILITIES) {
    const oldestKey = unsupported.keys().next().value;
    if (typeof oldestKey !== 'string') {
      return;
    }
    unsupported.delete(oldestKey);
  }
}
