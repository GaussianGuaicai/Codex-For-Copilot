# Auth Guidelines

## Purpose

`auth/` owns ChatGPT credential import, OAuth sign-in, refresh coordination, encrypted SecretStorage records, and VS Code authentication sessions.

## Key Files

- `codexAccountIdentity.ts`: best-effort JWT owner identity extraction and conservative owner matching.
- `codexSecretStore.ts`: local credential slots, account index, and legacy-storage migration.
- `codexAuthManager.ts`: import, sign-in, refresh, and account selection orchestration.

## Constraints

- Local `accountKey` values are opaque implementation details, never remote workspace IDs for newly stored refreshable credentials.
- Reuse a stored key only for a matching user and workspace; without user IDs, a normalized email and matching workspace is the compatibility fallback. Ambiguous identities must be retained separately.
- Refresh and 401 recovery must continue to use the explicitly pinned local key so concurrent accounts cannot share locks or rotated refresh tokens.
- Authentication diagnostics may log account lifecycle and refresh outcomes, but local account keys must be hashed and logs must never contain tokens, JWT claims, or email addresses.
- VS Code authentication-session enumeration must read stored snapshots without triggering refresh; only an active account request may refresh a token.