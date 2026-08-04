import { createHash, randomUUID } from 'node:crypto';

export type LogFields = Record<string, unknown>;

export interface CodexLogSink {
  trace?(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(error: string | Error, ...args: unknown[]): void;
}

export type CodexLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const MAX_DEPTH = 5;
const MAX_FIELDS = 40;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;
const MAX_ERROR_CAUSES = 3;

const SECRET_KEY = /(?:^|[_-])(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)(?:$|[_-])/i;
const CONTENT_KEY = /^(?:prompt|instructions|input|output|content|reasoning|arguments?|result|encrypted|toolArguments|toolResult)$/i;
const TURN_STATE_KEY = /(?:turn[_-]?state|sticky[_-]?state)/i;
const IDENTIFIER_KEY = /(?:^|[_-])(response|previous[_-]?response|branch|call|thread|turn|session|installation|window)(?:[_-]?(?:id|key))?$/i;

export class CodexLogger {
  private readonly context: LogFields;
  private readonly legacySink: boolean;

  constructor(
    private readonly sink: CodexLogSink,
    component = 'extension',
    context: LogFields = {}
  ) {
    this.context = { sessionId: randomUUID().slice(0, 12), component, ...context };
    // Test doubles created before LogOutputChannel gained trace can continue to
    // observe their historical event/payload pair. Real VS Code log channels
    // always implement trace and receive the structured single-line format.
    this.legacySink = typeof sink.trace !== 'function';
  }

  child(component: string, fields: LogFields = {}): CodexLogger {
    return new CodexLogger(this.sink, component, { ...this.context, ...fields, component });
  }

  operation(name: string, fields: LogFields = {}): CodexLogger {
    return new CodexLogger(this.sink, String(this.context.component), {
      ...this.context,
      ...fields,
      operation: name,
      operationId: randomUUID().slice(0, 12),
      attempt: 1
    });
  }

  with(fields: LogFields): CodexLogger {
    return new CodexLogger(this.sink, String(this.context.component), { ...this.context, ...fields });
  }

  nextAttempt(): CodexLogger {
    const attempt = typeof this.context.attempt === 'number' ? this.context.attempt + 1 : 2;
    return this.with({ attempt });
  }

  trace(event: string, fields?: LogFields): void { this.write('trace', event, fields); }
  debug(event: string, fields?: LogFields): void { this.write('debug', event, fields); }
  info(event: string, fields?: LogFields): void { this.write('info', event, fields); }
  warn(event: string, fields?: LogFields): void { this.write('warn', event, fields); }

  error(event: string, error?: unknown, fields?: LogFields): void {
    this.write('error', event, { ...fields, error: serializeError(error) });
  }

  private write(level: CodexLogLevel, event: string, fields: LogFields = {}): void {
    try {
      if (this.legacySink) {
        this.writeToSink(level, event, fields);
        return;
      }
      const payload = sanitizeLogFields({ ...this.context, ...fields });
      const message = `[${payload.component ?? 'extension'}] ${event} ${stableStringify(payload)}`;
      this.writeToSink(level, message);
    } catch {
      // Logging must never affect the provider or authentication flow.
    }
  }

  private writeToSink(level: CodexLogLevel, message: string, payload?: LogFields): void {
    try {
      switch (level) {
        case 'trace':
          this.sink.trace?.(message, payload);
          return;
        case 'debug':
          this.sink.debug(message, payload);
          return;
        case 'info':
          this.sink.info(message, payload);
          return;
        case 'warn':
          this.sink.warn(message, payload);
          return;
        case 'error':
          this.sink.error(message, payload);
      }
    } catch {
      // Logging must never affect the provider or authentication flow.
    }
  }
}

export function createCodexLogger(sink: CodexLogSink, component = 'extension'): CodexLogger {
  return new CodexLogger(sink, component);
}

export function sanitizeLogFields(fields: LogFields): LogFields {
  return sanitizeValue(fields, 0, new WeakSet<object>()) as LogFields;
}

export function serializeError(error: unknown, causeDepth = 0): unknown {
  if (error instanceof Error) {
    const record = error as Error & { cause?: unknown; code?: unknown; status?: unknown; requestID?: unknown; requestId?: unknown };
    const result: LogFields = {
      name: boundedString(record.name || 'Error'),
      message: sanitizeMessage(record.message),
      code: safeScalar(record.code),
      status: safeScalar(record.status),
      requestId: safeScalar(record.requestID ?? record.requestId)
    };
    if (record.cause !== undefined && causeDepth < MAX_ERROR_CAUSES) {
      result.cause = serializeError(record.cause, causeDepth + 1);
    }
    return compact(result);
  }
  return sanitizeValue(error, 0, new WeakSet<object>());
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>, key?: string): unknown {
  if (TURN_STATE_KEY.test(key ?? '')) return { present: value !== undefined && value !== null };
  if (SECRET_KEY.test(key ?? '')) return { present: value !== undefined && value !== null };
  if (CONTENT_KEY.test(key ?? '')) return summarizeContent(value);
  if (IDENTIFIER_KEY.test(key ?? '') && typeof value === 'string') return shortHash(value);
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (value instanceof Error) return serializeError(value);
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(`[+${value.length - MAX_ARRAY_ITEMS} items]`);
    return result;
  }
  const result: LogFields = {};
  let keys: string[];
  try { keys = Object.keys(value); } catch { return '[unreadable-object]'; }
  for (const property of keys.slice(0, MAX_FIELDS)) {
    try {
      result[property] = sanitizeValue((value as Record<string, unknown>)[property], depth + 1, seen, property);
    } catch {
      result[property] = '[unreadable]';
    }
  }
  if (keys.length > MAX_FIELDS) result.truncatedFieldCount = keys.length - MAX_FIELDS;
  return result;
}

function summarizeContent(value: unknown): LogFields {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { return { present: true, unreadable: true }; }
  return { present: value !== undefined && value !== null, bytes: Buffer.byteLength(text ?? ''), hash: shortHash(text ?? '') };
}

function sanitizeMessage(message: string): string {
  return boundedString(message
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]'));
}

function boundedString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
}

function safeScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return boundedString(value);
  return typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

function compact(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value) ?? '{}';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
