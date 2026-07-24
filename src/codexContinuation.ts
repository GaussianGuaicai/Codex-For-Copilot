import { fingerprintCodexRequest, type CodexResponsesRequest } from './codexRequestBuilder';

export interface CodexContinuationSnapshot {
  fullRequest: CodexResponsesRequest;
  responseId: string;
  responseItems: unknown[];
  requestFingerprint: string;
  catalogHash?: string;
  toolPlanMode?: 'legacy' | 'native-hosted';
  turnId: string;
}

export function createCodexContinuationSnapshot(
  fullRequest: CodexResponsesRequest,
  responseId: string,
  responseItems: readonly unknown[],
  turnId: string,
  options: {
    clone?: boolean;
    requestFingerprint?: string;
    catalogHash?: string;
    toolPlanMode?: 'legacy' | 'native-hosted';
  } = {}
): CodexContinuationSnapshot {
  const clone = options.clone !== false;
  return {
    fullRequest: clone ? structuredClone(fullRequest) : fullRequest,
    responseId,
    responseItems: clone ? structuredClone([...responseItems]) : [...responseItems],
    requestFingerprint: options.requestFingerprint ?? fingerprintCodexRequest(fullRequest),
    ...(options.catalogHash ? { catalogHash: options.catalogHash } : {}),
    ...(options.toolPlanMode ? { toolPlanMode: options.toolPlanMode } : {}),
    turnId
  };
}

export function cloneCodexContinuationSnapshot(
  snapshot: CodexContinuationSnapshot
): CodexContinuationSnapshot {
  return {
    fullRequest: structuredClone(snapshot.fullRequest),
    responseId: snapshot.responseId,
    responseItems: structuredClone(snapshot.responseItems),
    requestFingerprint: snapshot.requestFingerprint,
    catalogHash: snapshot.catalogHash,
    toolPlanMode: snapshot.toolPlanMode,
    turnId: snapshot.turnId
  };
}
