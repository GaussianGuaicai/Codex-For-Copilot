export function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Malformed JWT.');
  }

  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
}

export function getJwtExpiration(token: string): number | undefined {
  try {
    const payload = decodeJwtPayload(token) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function isJwtExpiringSoon(token: string, windowMs: number): boolean {
  const expiresAt = getJwtExpiration(token);
  return expiresAt !== undefined && expiresAt <= Date.now() + windowMs;
}
