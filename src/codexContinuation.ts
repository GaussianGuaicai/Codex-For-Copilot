import { fingerprintCodexRequest, type CodexResponsesRequest } from './codexRequestBuilder';

export interface CodexContinuationSnapshot {
  fullRequest: CodexResponsesRequest;
  responseId: string;
  responseItems: unknown[];
  requestFingerprint: string;
  turnId: string;
}

export function createCodexContinuationSnapshot(
  fullRequest: CodexResponsesRequest,
  responseId: string,
  responseItems: readonly unknown[],
  turnId: string
): CodexContinuationSnapshot {
  return {
    fullRequest: structuredClone(fullRequest),
    responseId,
    responseItems: structuredClone([...responseItems]),
    requestFingerprint: fingerprintCodexRequest(fullRequest),
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
    turnId: snapshot.turnId
  };
}