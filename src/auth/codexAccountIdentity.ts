import { decodeJwtPayload } from './codexJwt';
import type { CodexTokenData, RefreshableCodexCredentialRecord } from './codexAuthTypes';

export interface CodexAccountIdentity {
  userId?: string;
  accountId?: string;
  email?: string;
}

/** Extracts optional owner claims without making valid credentials depend on JWT parsing. */
export function parseCodexAccountIdentity(tokens: CodexTokenData, email?: string): CodexAccountIdentity {
  const payload = safePayload(tokens.id_token);
  const auth = objectValue(payload['https://api.openai.com/auth']);
  const profile = objectValue(payload['https://api.openai.com/profile']);
  return {
    userId: stringValue(auth.chatgpt_user_id) ?? stringValue(auth.user_id) ?? stringValue(payload['https://api.openai.com/auth.chatgpt_user_id']) ?? stringValue(payload['https://api.openai.com/auth.user_id']),
    accountId: stringValue(tokens.account_id) ?? stringValue(auth.chatgpt_account_id) ?? stringValue(payload['https://api.openai.com/auth.chatgpt_account_id']),
    email: stringValue(email) ?? stringValue(payload.email) ?? stringValue(profile.email) ?? stringValue(payload['https://api.openai.com/profile.email'])
  };
}

export function identityForCredential(record: RefreshableCodexCredentialRecord): CodexAccountIdentity {
  return parseCodexAccountIdentity(record.tokens, record.email);
}

/** Returns true only when both credentials identify the same remote ChatGPT owner. */
export function isSameCodexAccountOwner(left: CodexAccountIdentity, right: CodexAccountIdentity): boolean {
  if (!left.accountId || !right.accountId || left.accountId !== right.accountId) return false;
  if (left.userId && right.userId) return left.userId === right.userId;
  return !left.userId && !right.userId && normalizeEmail(left.email) === normalizeEmail(right.email) && normalizeEmail(left.email) !== undefined;
}

function safePayload(token: string): Record<string, unknown> {
  try {
    return objectValue(decodeJwtPayload(token));
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeEmail(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}