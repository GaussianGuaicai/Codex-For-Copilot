import * as zlib from 'node:zlib';
import { normalizeCodexEndpoint, parseCodexResponseHeaders } from './codexProtocol';

export type RequestCompressionPolicy = 'auto' | 'enabled' | 'disabled';

export interface CodexFetchObservation {
  requestBytes: number;
  compressedBytes?: number;
  compressionAttempted: boolean;
  compressionUsed: boolean;
  durationMs: number;
  responseStatus: number;
  responseHeaders: ReturnType<typeof parseCodexResponseHeaders>;
}

export interface CodexFetchAdapterOptions {
  endpointKey: string;
  compatibilityEnabled: boolean;
  compression: RequestCompressionPolicy;
  compressionThresholdBytes?: number;
  onObservation?: (observation: CodexFetchObservation) => void;
}

const COMPRESSION_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const MAX_COMPRESSION_CAPABILITIES = 128;
const compressionDisabledEndpoints = new Map<string, number>();

export function createCodexFetchAdapter(options: CodexFetchAdapterOptions): typeof fetch {
  const endpointKey = normalizeCodexEndpoint(options.endpointKey);

  return async (input, init) => {
    const startedAt = Date.now();
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const body = init?.body;
    const bodyBuffer = typeof body === 'string' ? Buffer.from(body) : undefined;
    const requestBytes = bodyBuffer?.byteLength ?? 0;
    const threshold = options.compressionThresholdBytes ?? 64 * 1024;
    const eligible = options.compatibilityEnabled
      && method === 'POST'
      && /\/responses(?:\?.*)?$/.test(new URL(url).pathname)
      && headers.get('content-type')?.toLowerCase().includes('application/json') === true
      && bodyBuffer !== undefined
      && requestBytes >= threshold
      && options.compression !== 'disabled'
      && !isCompressionDisabled(endpointKey);
    const compressedBody = eligible ? tryZstdCompress(bodyBuffer) : undefined;
    const shouldCompress = eligible && compressedBody !== undefined;
    const compressedHeaders = new Headers(headers);
    if (shouldCompress) {
      compressedHeaders.set('Content-Encoding', 'zstd');
      compressedHeaders.set('Content-Length', String(compressedBody.byteLength));
    }

    let response = await fetch(input, {
      ...init,
      headers: compressedHeaders,
      body: shouldCompress ? compressedBody : body
    });

    if (shouldCompress && await isExplicitCompressionRejection(response)) {
      disableCompression(endpointKey);
      await response.body?.cancel().catch(() => undefined);
      const retryHeaders = new Headers(headers);
      retryHeaders.delete('Content-Encoding');
      retryHeaders.set('Content-Length', String(bodyBuffer.byteLength));
      response = await fetch(input, { ...init, headers: retryHeaders, body });
    }

    options.onObservation?.({
      requestBytes,
      compressedBytes: shouldCompress ? compressedBody.byteLength : undefined,
      compressionAttempted: eligible,
      compressionUsed: shouldCompress,
      durationMs: Date.now() - startedAt,
      responseStatus: response.status,
      responseHeaders: parseCodexResponseHeaders(response.headers)
    });
    return response;
  };
}

export function resetCodexFetchCapabilities(endpoint?: string): void {
  if (endpoint) {
    compressionDisabledEndpoints.delete(normalizeCodexEndpoint(endpoint));
  } else {
    compressionDisabledEndpoints.clear();
  }
}

export function isCodexCompressionRuntimeAvailable(): boolean {
  return typeof (zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
}

function tryZstdCompress(body: Buffer): Buffer | undefined {
  const compress = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;
  if (typeof compress !== 'function') {
    return undefined;
  }
  try {
    return compress(body);
  } catch {
    return undefined;
  }
}

function isCompressionDisabled(endpointKey: string): boolean {
  evictCompressionCapabilities();
  return compressionDisabledEndpoints.has(endpointKey);
}

function disableCompression(endpointKey: string): void {
  compressionDisabledEndpoints.set(endpointKey, Date.now());
  evictCompressionCapabilities();
}

function evictCompressionCapabilities(): void {
  const cutoff = Date.now() - COMPRESSION_CAPABILITY_TTL_MS;
  for (const [endpointKey, disabledAt] of compressionDisabledEndpoints) {
    if (disabledAt < cutoff) {
      compressionDisabledEndpoints.delete(endpointKey);
    }
  }

  if (compressionDisabledEndpoints.size <= MAX_COMPRESSION_CAPABILITIES) {
    return;
  }

  const oldest = [...compressionDisabledEndpoints.entries()]
    .sort((left, right) => left[1] - right[1])
    .slice(0, compressionDisabledEndpoints.size - MAX_COMPRESSION_CAPABILITIES);
  for (const [endpointKey] of oldest) {
    compressionDisabledEndpoints.delete(endpointKey);
  }
}

async function isExplicitCompressionRejection(response: Response): Promise<boolean> {
  if (response.status === 415) {
    return true;
  }
  if (response.status !== 400 && response.status !== 422) {
    return false;
  }

  try {
    const body = await response.clone().text();
    return /\b(?:content[- ]encoding|zstd|compression)\b/i.test(body);
  } catch {
    return false;
  }
}
