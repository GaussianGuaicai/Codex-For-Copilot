/** Backend limit semantics, independent of VS Code's UI and transport. */
export class ResponsesQuotaExceededError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResponsesQuotaExceededError';
  }
}

export class ResponsesRateLimitedError extends Error {
  constructor(message: string, readonly retryDelayMs?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResponsesRateLimitedError';
  }
}

export function classifyResponsesLimit(payload: unknown): 'quota' | 'rate' | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  const code = typeof value.code === 'string' ? value.code : '';
  const type = typeof value.type === 'string' ? value.type : '';
  const message = typeof value.message === 'string' ? value.message : '';
  if ([code, type].some((field) => /^(?:usage_limit_reached|usage_limit_exceeded|quota_exceeded|insufficient_quota|billing_hard_limit_reached)$/.test(field))
    || /\b(?:usage limit (?:has been )?(?:reached|exceeded)|(?:reached|hit|exceeded) (?:your |the |current )?(?:usage limit|quota)|(?:insufficient|exhausted) quota|quota (?:exhausted|exceeded))\b/i.test(message)) {
    return 'quota';
  }
  if (code === 'rate_limit_exceeded' || type === 'rate_limit_error') {
    return 'rate';
  }
  return undefined;
}

/** Use ordinary Error names so they survive the LM RPC serialization boundary. */
export function toChatLimitError(error: ResponsesQuotaExceededError | ResponsesRateLimitedError): Error {
  const quota = error instanceof ResponsesQuotaExceededError;
  const message = quota
    ? `Codex usage limit reached. Try again after your usage resets, or switch accounts. ${error.message}`
    : `Codex is temporarily rate limited. Try again shortly. ${error.message}`;
  const result = new Error(message, { cause: error });
  result.name = quota ? 'ChatQuotaExceeded' : 'ChatRateLimited';
  return result;
}
