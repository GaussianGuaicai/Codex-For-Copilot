import type { CodexAuthBundle } from './codexAuthTypes';
import { InvalidAuthJsonError } from './codexAuthTypes';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseCodexAuthJson(rawJson: string): CodexAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    throw new InvalidAuthJsonError('Selected file is not valid JSON.');
  }

  const value = parsed as { auth_mode?: unknown; tokens?: Record<string, unknown>; last_refresh?: unknown };
  if (!value || typeof value !== 'object') {
    throw new InvalidAuthJsonError('auth.json must contain a JSON object.');
  }

  if (value.auth_mode !== 'chatgpt') {
    throw new InvalidAuthJsonError('Only auth_mode "chatgpt" is supported.');
  }

  if (!value.tokens || typeof value.tokens !== 'object') {
    throw new InvalidAuthJsonError('auth.json is missing tokens.');
  }

  if (!nonEmptyString(value.tokens.id_token)) {
    throw new InvalidAuthJsonError('auth.json is missing tokens.id_token.');
  }
  if (!nonEmptyString(value.tokens.access_token)) {
    throw new InvalidAuthJsonError('auth.json is missing tokens.access_token.');
  }
  if (!nonEmptyString(value.tokens.refresh_token)) {
    throw new InvalidAuthJsonError('auth.json is missing tokens.refresh_token.');
  }

  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: value.tokens.id_token.trim(),
      access_token: value.tokens.access_token.trim(),
      refresh_token: value.tokens.refresh_token.trim(),
      ...(nonEmptyString(value.tokens.account_id) ? { account_id: value.tokens.account_id.trim() } : {})
    },
    last_refresh: nonEmptyString(value.last_refresh) ? value.last_refresh : new Date().toISOString()
  };
}
