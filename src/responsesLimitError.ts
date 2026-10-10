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

/**
 * Preserve classification across LM RPC, but keep diagnostics out of Chat.
 * Copilot's ExtChatEndpoint formats third-party failures with toErrorMessage(e, true),
 * which appends the stack (including its duplicate message) whenever it is present.
 * Log the original error before converting it; do not forward its cause or stack.
 */
export function toChatLimitError(error: ResponsesQuotaExceededError | ResponsesRateLimitedError): Error {
  const quota = error instanceof ResponsesQuotaExceededError;
  const retryHint = getRetryHint(error.message);
  const message = quota
    ? `Codex usage limit reached. ${retryHint ?? 'Try again after your usage resets'}, or switch accounts.`
    : `Codex is temporarily rate limited. ${retryHint ?? 'Try again shortly'}.`;
  const result = new Error(message);
  result.name = quota ? 'ChatQuotaExceeded' : 'ChatRateLimited';
  result.stack = undefined;
  return result;
}

function getRetryHint(message: string): string | undefined {
  // Keep only actionable retry timing, never append an SDK envelope or raw error.
  // Decimal delays must remain intact, while JSON delimiters and stack lines stop it.
  const hint = message.match(/\btry again (?:at|in|after|on|tomorrow\b|later\b)[^.!?\r\n"}\]]*(?:\.\d+[^.!?\r\n"}\]]*)*/i)?.[0].trim();
  return hint && hint.length <= 200 ? hint[0].toUpperCase() + hint.slice(1) : undefined;
}
