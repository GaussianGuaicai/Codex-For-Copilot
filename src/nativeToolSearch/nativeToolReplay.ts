import type { CodexContinuationSnapshot } from '../codexContinuation';
import type { CodexResponsesRequest } from '../codexRequestBuilder';
import type { ResponsesInputMessage } from '../convertMessages';

export function buildCanonicalReplayInput(options: {
  previousSnapshot?: CodexContinuationSnapshot;
  convertedInput: readonly ResponsesInputMessage[];
  appendedInput: readonly ResponsesInputMessage[];
  catalogHash?: string;
}): ResponsesInputMessage[] {
  const { previousSnapshot, convertedInput, appendedInput, catalogHash } = options;
  if (!previousSnapshot || (catalogHash && previousSnapshot.catalogHash !== catalogHash)) {
    return [...convertedInput];
  }
  const previousInput = previousSnapshot.fullRequest.input as ResponsesInputMessage[];
  return [...previousInput, ...previousSnapshot.responseItems as ResponsesInputMessage[], ...appendedInput];
}

export function createCanonicalReplayRequest(request: CodexResponsesRequest, input: readonly ResponsesInputMessage[]): CodexResponsesRequest {
  const { previous_response_id: _previousResponseId, ...fullRequest } = request;
  return { ...fullRequest, input: [...input] } as CodexResponsesRequest;
}
