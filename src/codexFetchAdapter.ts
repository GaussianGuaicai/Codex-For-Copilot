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

const compressionDisabledEndpoints = new Set<string>();

export function createCodexFetchAdapter(options: CodexFetchAdapterOptions): typeof fetch {
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
      && !compressionDisabledEndpoints.has(options.endpointKey);
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

    if (shouldCompress && isCompressionRejection(response)) {
      compressionDisabledEndpoints.add(options.endpointKey);
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

function isCompressionRejection(response: Response): boolean {
  return response.status === 400 || response.status === 415 || response.status === 422;
}
