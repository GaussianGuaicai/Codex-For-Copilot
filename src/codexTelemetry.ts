import { createHash } from 'node:crypto';

export interface CodexTelemetrySink {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export function shortHash(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : undefined;
}

export function safeCodexTelemetryValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, nested]) => {
    const lowered = key.toLowerCase();
    if (lowered.includes('authorization') || lowered.includes('token') || lowered.includes('turnstate') || lowered.includes('turn_state')) {
      return [key, nested ? { present: true, length: String(nested).length } : { present: false }];
    }
    if (lowered.includes('prompt') || lowered.includes('arguments') || lowered.includes('encrypted')) {
      return [key, typeof nested === 'string' ? { present: true, length: nested.length, hash: shortHash(nested) } : { present: Boolean(nested) }];
    }
    return [key, nested];
  }));
}
