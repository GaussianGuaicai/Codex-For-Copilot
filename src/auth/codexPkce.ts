import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface CodexPkceCodes { verifier: string; challenge: string; state: string; }

export function generateCodexPkce(): CodexPkceCodes {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') };
}

export function statesMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected); const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
