import { supportsNativeToolSearchModel } from './nativeToolPolicy';

const unsupported = new Map<string, number>();
const TTL_MS = 10 * 60 * 1000;

export function nativeToolSearchCapabilityKey(baseURL: string, authIdentity: string, model: string): string {
  return JSON.stringify([baseURL, authIdentity, model]);
}

export function canUseNativeToolSearch(model: string, key: string): boolean {
  const rejectedAt = unsupported.get(key);
  if (rejectedAt !== undefined && Date.now() - rejectedAt <= TTL_MS) {
    return false;
  }
  if (rejectedAt !== undefined) {
    unsupported.delete(key);
  }
  return supportsNativeToolSearchModel(model);
}

export function markNativeToolSearchUnsupported(key: string): void {
  unsupported.set(key, Date.now());
}

export function isNativeToolSearchUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(unsupported tool type:\s*(namespace|tool_search)|unknown field:\s*defer_loading|model does not support tool_search)/i.test(message);
}
