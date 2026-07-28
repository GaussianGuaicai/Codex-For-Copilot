# ChatGPT Codex OAuth Authentication Plan

## Status

Implementation plan for adding first-party ChatGPT Codex OAuth sign-in, credential refresh, unauthorized recovery, and logout to Codex For Copilot.

This document is intended to be executed directly by Codex. Keep the implementation in this pull request and update the checklist as work progresses.

## Goal

Allow users to sign in to Codex For Copilot with their ChatGPT account without installing Codex CLI or manually importing `~/.codex/auth.json`.

The finished implementation must:

- provide browser-based OAuth Authorization Code + PKCE sign-in as the default flow;
- provide Device Code sign-in as a fallback;
- store extension-owned OAuth credentials in VS Code `SecretStorage`;
- proactively refresh access tokens and recover once from an unauthorized request;
- safely coordinate refreshes across concurrent requests and multiple VS Code windows;
- apply refreshed credentials consistently to model discovery, usage requests, HTTP Responses streaming, and Responses WebSocket sessions;
- revoke the OAuth session on sign-out when possible;
- preserve API-key authentication and a read-only legacy Codex credential fallback;
- never log authorization codes, PKCE verifiers, access tokens, refresh tokens, ID tokens, or complete callback URLs.

## Upstream references

Use the current `openai/codex` implementation as the behavioral reference, while keeping all upstream-derived constants and protocol details isolated behind a compatibility module because this is not a separately versioned public OAuth specification.

Relevant upstream files:

- `codex-rs/login/src/server.rs`
- `codex-rs/login/src/device_code_auth.rs`
- `codex-rs/login/src/pkce.rs`
- `codex-rs/login/src/auth/manager.rs`
- `codex-rs/login/src/auth/revoke.rs`

Important upstream behavior to preserve:

- OAuth issuer: `https://auth.openai.com`
- preferred loopback port: `1455`
- registered fallback loopback port: `1457`
- callback path: `/auth/callback`
- token endpoint: `/oauth/token`
- revoke endpoint: `/oauth/revoke`
- access-token proactive refresh window: 5 minutes
- fallback periodic refresh interval: 8 days
- refresh-token error classification for expired, reused, and invalidated refresh tokens
- Device Code polling timeout: 15 minutes

Do not impersonate the Codex CLI user agent or originator. Use the extension's own identity, for example `originator=codex-for-copilot`.

## Current repository state

The repository already contains a partial credential subsystem:

- `src/auth/codexAuthManager.ts`
- `src/auth/codexAuthRequest.ts`
- `src/auth/codexAuthJsonImporter.ts`
- `src/auth/codexAuthLock.ts`
- `src/auth/codexSecretStore.ts`
- `src/auth/codexTokenRefresh.ts`
- `src/auth/codexJwt.ts`
- `src/auth/codexAuthTypes.ts`

Existing capabilities include:

- importing a ChatGPT-style Codex `auth.json`;
- persisting a normalized token bundle in `SecretStorage`;
- proactive refresh near JWT expiry;
- an 8-day fallback refresh interval;
- a file-based cross-window refresh lock;
- one retry after HTTP 401 in `codexFetch`;
- an unimplemented Device Code command placeholder.

The implementation must extend and simplify this subsystem rather than add a second independent authentication stack.

## Known gaps to close

1. There is no native OAuth login implementation.
2. The main Responses HTTP and WebSocket paths use an API-key snapshot when the OpenAI client is created and do not consistently participate in token refresh and 401 recovery.
3. The current refresh error classification treats every HTTP 400 as permanent.
4. Imported Codex CLI refresh tokens can be copied into extension storage and then rotated independently by multiple clients.
5. Sign-out only removes local credentials and does not attempt OAuth revocation.
6. Authentication changes do not provide one centralized lifecycle event that invalidates model caches and authenticated WebSocket sessions.
7. The current lock can wait indefinitely and does not explicitly protect lock ownership during stale-lock cleanup.

## Design principles

### Single source of truth

`CodexAuthManager` must be the only component that resolves, refreshes, replaces, or clears ChatGPT OAuth credentials.

Callers must request a credential snapshot from the manager instead of caching access tokens independently.

### Explicit credential ownership

Distinguish extension-owned OAuth credentials from legacy credentials discovered from Codex CLI.

- `extensionOAuth`: created by this extension; refresh and revoke are allowed.
- `legacyCodexFile`: read from `~/.codex/auth.json`; read-only; never write, rotate, revoke, or copy its refresh token.
- `openaiApiKey`: existing API-key flow; not refreshable.

The legacy import command may remain for compatibility, but it must be presented as a legacy snapshot path. It must not create a second owner for a Codex CLI refresh token.

### Safe retries

An authenticated request may be retried at most once after refresh, and only before visible response activity or tool execution has been emitted.

Never replay a request after text, reasoning, or a tool call has been surfaced to VS Code.

### Atomic credential replacement

Refresh-token rotation must replace the complete stored credential record atomically. Never update access, ID, and refresh tokens in separate writes.

### No secret-bearing telemetry

Logs may contain:

- authentication source;
- state transition;
- HTTP status;
- error classification;
- token expiry timestamp;
- credential revision hash or presence flags;
- whether a refresh or retry occurred.

Logs must not contain token values, authorization codes, PKCE data, raw callback query strings, or unredacted auth URLs.

## Proposed credential model

Replace the current unversioned bundle with a versioned discriminated union.

```ts
export type CodexCredentialRecord =
  | ExtensionOAuthCredentialRecord
  | LegacyCodexCredentialRecord;

export interface ExtensionOAuthCredentialRecord {
  schemaVersion: 2;
  source: 'extensionOAuth';
  revision: string;
  tokens: {
    idToken: string;
    accessToken: string;
    refreshToken: string;
  };
  accountId?: string;
  email?: string;
  accessTokenExpiresAt?: number;
  lastRefreshAt: string;
}

export interface LegacyCodexCredentialRecord {
  schemaVersion: 2;
  source: 'legacyCodexFile';
  revision: string;
  accessToken: string;
  accountId?: string;
  email?: string;
  accessTokenExpiresAt?: number;
  loadedAt: string;
}
```

Requirements:

- Generate a new random `revision` for every extension-owned login or successful refresh.
- Store extension-owned OAuth records under one `SecretStorage` key.
- Resolve `legacyCodexFile` dynamically from disk; do not persist its refresh token.
- Migrate existing stored bundles conservatively. Treat them as legacy imported credentials and require native sign-in before performing future refresh-token rotation.
- Keep the existing API-key secret separate.

## Target architecture

### `CodexOAuthCompatibilityProfile`

Add a small immutable module containing upstream-derived OAuth compatibility values:

- issuer;
- client ID;
- authorize endpoint;
- token endpoint;
- revoke endpoint;
- loopback ports;
- callback path;
- scopes;
- Device Code endpoint paths;
- extension originator.

No other file should hard-code these values.

Suggested file:

- `src/auth/codexOAuthCompatibility.ts`

### `CodexOAuthClient`

Own protocol-level HTTP operations:

- build authorization URL;
- exchange authorization code for tokens;
- refresh tokens;
- request Device Code;
- poll Device Code authorization;
- revoke token;
- parse and classify auth service errors;
- redact sensitive URL/error information.

Suggested file:

- `src/auth/codexOAuthClient.ts`

The class must accept an injectable `fetch` implementation and endpoint profile so tests do not contact production services.

### `CodexLoginCoordinator`

Own user-facing login sessions:

- one active login session per extension host;
- browser PKCE flow;
- Device Code fallback;
- cancellation;
- progress reporting;
- login completion and cleanup;
- state transitions through `CodexAuthManager`.

Suggested files:

- `src/auth/codexLoginCoordinator.ts`
- `src/auth/codexLoopbackLogin.ts`
- `src/auth/codexDeviceCodeLogin.ts`
- `src/auth/codexPkce.ts`

### `CodexAuthManager`

Remain the central session authority and expose:

```ts
interface CodexCredentialSnapshot {
  source: 'extensionOAuth' | 'legacyCodexFile' | 'openaiApiKey';
  accessToken: string;
  accountId?: string;
  expiresAt?: number;
  revision: string;
  refreshable: boolean;
}

interface UnauthorizedRecoveryContext {
  snapshotRevision: string;
  visibleActivity: boolean;
  reason: 'http401' | 'websocketUnauthorized';
}

class CodexAuthManager {
  readonly onDidChangeAuth: vscode.Event<CodexAuthChangeEvent>;

  getStatus(): Promise<CodexAuthStatus>;
  getCredentialSnapshot(): Promise<CodexCredentialSnapshot>;
  signInWithBrowser(): Promise<void>;
  signInWithDeviceCode(): Promise<void>;
  refreshIfNeeded(): Promise<CodexCredentialSnapshot>;
  recoverFromUnauthorized(context: UnauthorizedRecoveryContext): Promise<CodexCredentialSnapshot>;
  signOut(): Promise<void>;
}
```

Exact names may change, but responsibilities must remain centralized.

## Phase 1: credential storage and migration

- [ ] Add the versioned credential types and source ownership.
- [ ] Replace `CodexSecretStore` with a store that validates schema and performs complete-record writes.
- [ ] Add migration for the existing `codexForCopilot.codexAuthBundle` secret.
- [ ] Ensure migrated imported credentials cannot rotate a Codex CLI refresh token.
- [ ] Update `getApiCredentials` to resolve credentials through `CodexAuthManager` first.
- [ ] Preserve explicit `secretStorage` API-key selection.
- [ ] Update configuration descriptions so `codexAuth` means extension-managed ChatGPT login, not only `~/.codex/auth.json`.
- [ ] Keep a read-only automatic fallback to `~/.codex/auth.json` when configured.

Suggested cleanup:

- rename `CodexSecretStore` to `CodexCredentialStore`;
- remove token-bundle parsing responsibilities from `secrets.ts`;
- keep API-key storage and OAuth credential storage clearly separated.

## Phase 2: browser Authorization Code + PKCE login

Implement the primary sign-in flow.

### PKCE

- [ ] Generate a cryptographically random verifier.
- [ ] Derive an S256 challenge.
- [ ] Generate a cryptographically random 32-byte state value.
- [ ] Use base64url encoding without padding.
- [ ] Keep verifier and state in memory only.

### Loopback server

- [ ] Bind only to `127.0.0.1`.
- [ ] Prefer port `1455` and fall back to registered port `1457`.
- [ ] Use redirect URI `http://localhost:{port}/auth/callback` exactly.
- [ ] Reject every path except the callback, success/cancel paths if used, and a minimal health-independent request set.
- [ ] Validate OAuth `state` using a timing-safe comparison where practical.
- [ ] Reject missing code, missing state, state mismatch, or OAuth callback errors.
- [ ] Close the server after success, failure, cancellation, or timeout.
- [ ] Add a bounded login timeout.
- [ ] Ensure a previous stale login server cannot leave the next login hanging.

Use Node's built-in HTTP server unless a dependency is demonstrably necessary.

### Authorization request

Build the authorization URL from the compatibility profile with:

- `response_type=code`;
- the current upstream client ID;
- the loopback redirect URI;
- scopes matching current upstream Codex;
- `code_challenge`;
- `code_challenge_method=S256`;
- `id_token_add_organizations=true`;
- `codex_cli_simplified_flow=true` when still required upstream;
- random `state`;
- `originator=codex-for-copilot`.

Open it with `vscode.env.openExternal`.

### Token exchange

- [ ] POST to `/oauth/token` with `application/x-www-form-urlencoded`.
- [ ] Send `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and `code_verifier`.
- [ ] Require non-empty ID, access, and refresh tokens.
- [ ] Decode identity metadata without treating unverified JWT claims as authorization decisions.
- [ ] Derive account ID using the same claim precedence as upstream where possible.
- [ ] Persist only after the complete exchange and validation succeed.
- [ ] Emit one `signedIn` auth-change event.
- [ ] Show a simple local success page or redirect, without embedding tokens in the URL.

## Phase 3: Device Code fallback

Implement the current Codex Device Code protocol behind the compatibility profile.

- [ ] Request a user code from `/api/accounts/deviceauth/usercode`.
- [ ] Display the verification URL and one-time code in a modal/progress UI.
- [ ] Add actions to copy the code and open the verification page.
- [ ] Poll `/api/accounts/deviceauth/token` using the server-provided interval.
- [ ] Stop after 15 minutes.
- [ ] Respect VS Code cancellation.
- [ ] Treat expected pending statuses as pending, not failures.
- [ ] Exchange the returned authorization code through the same token-exchange implementation used by browser PKCE.
- [ ] Persist through the same `CodexAuthManager` completion path.

Browser PKCE remains the default. Device Code is a fallback for loopback restrictions, remote browser environments, and explicit user choice.

## Phase 4: robust refresh and concurrency

### Proactive refresh

- [ ] Refresh extension-owned OAuth credentials when the access token expires within 5 minutes.
- [ ] If JWT expiration cannot be parsed, use the 8-day last-refresh fallback.
- [ ] Do not proactively refresh API keys or legacy Codex file credentials.

### In-process single-flight

- [ ] Store the active refresh promise in `CodexAuthManager`.
- [ ] Make all concurrent callers await one refresh operation.
- [ ] Clear the promise in `finally`.

### Cross-window coordination

Improve `CodexAuthLock`:

- [ ] add a bounded acquisition timeout;
- [ ] support cancellation;
- [ ] write an owner nonce and acquisition timestamp;
- [ ] only remove a lock when ownership still matches;
- [ ] retain stale-lock recovery;
- [ ] re-read `SecretStorage` after acquiring the lock;
- [ ] skip network refresh if another window already changed the credential revision.

### Refresh response handling

- [ ] Submit `client_id`, `grant_type=refresh_token`, and the current refresh token.
- [ ] Atomically persist any returned ID, access, and rotated refresh tokens.
- [ ] Preserve an existing token only when the successful response legitimately omits that field.
- [ ] update `lastRefreshAt` and generate a new revision;
- [ ] emit `tokensRefreshed` only after successful persistence.

### Error classification

Permanent reauthentication errors:

- HTTP 401 from the token endpoint;
- `refresh_token_expired`;
- `refresh_token_reused`;
- `refresh_token_invalidated`;
- explicit revoked/invalid-grant responses that clearly require reauthentication.

Transient errors:

- network errors;
- timeouts;
- HTTP 408, 429, and 5xx;
- unknown 400 responses unless their structured code is known to be permanent.

Cache a permanent refresh failure only for the exact credential revision that failed. A new login or externally changed credential record must clear that cached failure.

## Phase 5: unified authenticated request pipeline

The final implementation must not rely on a long-lived OAuth access token copied into an OpenAI client at activation time.

### HTTP and SSE

Refactor the custom fetch path so authenticated Codex HTTP requests:

1. obtain a current credential snapshot immediately before sending;
2. override the `Authorization` header with that snapshot;
3. set or replace `ChatGPT-Account-ID` from the same snapshot;
4. retain compression, proxy, timeout, retry, and telemetry behavior;
5. detect a 401 before exposing the response stream;
6. request one guarded unauthorized recovery from `CodexAuthManager`;
7. replay the original request once with the refreshed snapshot;
8. return the second response without another auth retry.

Avoid layering the SDK's generic automatic retries on top of an unsafe authentication replay. Authentication recovery must have an explicit one-retry budget.

### WebSocket

For Responses WebSocket sessions:

- build each new connection from the latest credential snapshot;
- include credential revision in the connection scope/key;
- invalidate all sessions bound to the old revision after login, refresh, account change, or sign-out;
- recover once from an unauthorized handshake or unauthorized event only before visible activity;
- close the failed socket before refresh;
- recreate the OpenAI client and WebSocket with the new snapshot;
- resend the request once;
- never retry after text, reasoning, or tool-call activity is visible.

### Existing request surfaces

Route all first-party Codex requests through the same authentication behavior:

- model discovery;
- account usage and limits;
- input-token counting;
- HTTP Responses streaming;
- WebSocket Responses streaming;
- preconnection and prewarm;
- any future Codex backend endpoint.

API-key and third-party endpoint behavior must remain unchanged.

## Phase 6: auth lifecycle integration

Add a centralized event:

```ts
type CodexAuthChangeReason =
  | 'signedIn'
  | 'tokensRefreshed'
  | 'reauthRequired'
  | 'signedOut'
  | 'accountChanged';
```

On a material credential revision change:

- [ ] dispose reusable Responses WebSockets;
- [ ] clear managed preconnections and prewarm state;
- [ ] clear model-discovery caches tied to the old credential;
- [ ] reset authenticated connection configuration keys;
- [ ] refresh account usage state;
- [ ] fire `onDidChangeLanguageModelChatInformation`;
- [ ] update status UI without exposing secrets.

Do not perform these invalidations repeatedly when only non-material status metadata changes.

## Phase 7: sign-out and revocation

Implement best-effort OAuth revocation for extension-owned credentials.

- [ ] Prefer revoking the refresh token with `token_type_hint=refresh_token` and the OAuth client ID.
- [ ] Fall back to the access token only when no refresh token is available.
- [ ] Use the upstream `/oauth/revoke` endpoint.
- [ ] Apply a bounded timeout, approximately 10 seconds.
- [ ] Never block local sign-out on a revoke failure.
- [ ] Always delete local extension-owned credentials.
- [ ] Clear permanent refresh failures, active login state, WebSocket sessions, model caches, and usage state.
- [ ] Do not revoke credentials read from `~/.codex/auth.json`.

## Phase 8: VS Code commands and UX

Update the Manage command and command palette.

Recommended order:

1. `Sign in with ChatGPT`
2. `Sign in with Device Code`
3. `Show Account Status`
4. `Refresh Credentials`
5. `Sign Out`
6. `Import Codex auth.json (Legacy)`
7. `Set API Key`
8. `Clear API Key`
9. `Refresh Account Limits`
10. `Open Debug Logs`
11. `Open Settings`

Behavior:

- When no credentials exist, the main action must be `Sign in with ChatGPT`.
- Do not tell users to import `auth.json` as the normal path.
- Show which source is active: ChatGPT OAuth, legacy Codex file, or API key.
- Show email/account metadata, token expiry, and last refresh time when available.
- On permanent refresh failure, present `Sign in again` and `Sign out` actions.
- Avoid repeated modal prompts from concurrent failing requests.
- Preserve a clear fallback for API-key users.

Update user-facing error messages throughout the provider so they refer to native sign-in rather than requiring `auth.json` import.

## Test plan

Keep protocol logic dependency-injected and testable without real credentials.

### Unit and smoke tests

Add or expand tests for:

- [ ] PKCE verifier/challenge format and deterministic fixture validation;
- [ ] state generation and mismatch rejection;
- [ ] authorization URL parameters;
- [ ] callback missing code/state and OAuth callback errors;
- [ ] preferred port and fallback port behavior;
- [ ] login cancellation and timeout cleanup;
- [ ] token exchange content type and form fields;
- [ ] Device Code request, pending polling, completion, cancellation, and timeout;
- [ ] credential schema migration;
- [ ] no refresh-token persistence for legacy Codex file credentials;
- [ ] proactive 5-minute refresh;
- [ ] 8-day fallback refresh;
- [ ] in-process refresh single-flight;
- [ ] cross-window refresh revision recheck;
- [ ] rotated refresh-token atomic persistence;
- [ ] permanent versus transient refresh error classification;
- [ ] permanent failure scoped to one credential revision;
- [ ] HTTP 401 refresh and one replay;
- [ ] no HTTP replay after visible activity;
- [ ] WebSocket unauthorized recovery before visible activity;
- [ ] no WebSocket replay after visible activity;
- [ ] stale WebSocket invalidation after credential revision changes;
- [ ] revoke request construction and timeout;
- [ ] local sign-out after revoke failure;
- [ ] redaction of auth URL query values and token-like error fields.

Suggested files:

- `test/smokeOAuthPkce.mjs`
- `test/smokeOAuthCallback.mjs`
- `test/smokeDeviceCodeAuth.mjs`
- `test/smokeTokenRefresh.mjs`
- `test/smokeAuthConcurrency.mjs`
- `test/smokeAuthHttpRecovery.mjs`
- `test/smokeAuthWebSocketRecovery.mjs`
- `test/smokeAuthMigration.mjs`
- `test/smokeAuthRevoke.mjs`

Integrate them into `npm run test:smoke` or a focused `test:auth` script that is also run by `test:smoke`.

### Extension-host tests

Verify:

- commands are registered;
- browser login can be cancelled cleanly;
- SecretStorage round trips the new schema;
- auth change events invalidate provider state;
- VS Code reload preserves extension-owned login;
- UI messages do not include secrets.

### Real-backend validation

Real-backend tests must be opt-in and must not print credentials.

Validate manually or through a local credential-enabled probe:

1. browser sign-in from a clean profile;
2. Device Code sign-in;
3. model discovery;
4. account usage refresh;
5. HTTP first turn and continuation;
6. WebSocket fresh and reused turns;
7. tool-call continuation;
8. proactive refresh using a controlled near-expiry fixture or test endpoint;
9. two VS Code windows making concurrent requests;
10. sign-out followed by verification that old WebSockets are unusable;
11. sign-in to a different account and confirm all account-bound state is replaced.

Run the complete check, smoke, and compile suites five consecutive times before marking the PR ready.

## Security review checklist

- [ ] OAuth state is mandatory and validated.
- [ ] PKCE uses S256 and a cryptographically secure verifier.
- [ ] Callback server binds only to loopback.
- [ ] Login server has cancellation and timeout cleanup.
- [ ] No token is ever placed in a success redirect URL.
- [ ] No token, code, verifier, state, or raw callback query is logged.
- [ ] Legacy Codex refresh tokens are not copied or rotated.
- [ ] Refresh-token writes are atomic.
- [ ] Unauthorized replay is limited to one attempt before visible activity.
- [ ] Sign-out clears local state even if revocation fails.
- [ ] Authentication changes invalidate sockets and account-bound caches.
- [ ] Tests use fake endpoints and fake tokens by default.

## Non-goals

Do not include the following in this PR unless they are strictly required for authentication correctness:

- Agent Identity bootstrap support;
- Personal Access Token support;
- enterprise forced-workspace policy UI;
- changes to the Responses request schema unrelated to authentication;
- changes to Tool Search behavior;
- changes to conversation continuation semantics;
- a new general-purpose OAuth dependency when Node and VS Code primitives are sufficient;
- writing credentials back to Codex CLI storage.

Leave clear extension points for future workspace restrictions and additional first-party auth modes, but do not expand scope prematurely.

## Suggested commit structure

1. `refactor(auth): version credential ownership and storage`
2. `feat(auth): add ChatGPT browser PKCE login`
3. `feat(auth): add device code login fallback`
4. `fix(auth): align token refresh and concurrency semantics`
5. `fix(auth): integrate recovery with HTTP and WebSocket transports`
6. `feat(auth): add revocation and authentication lifecycle UI`
7. `test(auth): cover OAuth login refresh and recovery`

Keep commits cohesive. Do not create multiple commits with identical descriptions.

## Acceptance criteria

The implementation is complete only when all of the following are true:

- [ ] A user can install the extension and sign in through `Sign in with ChatGPT` without Codex CLI.
- [ ] Browser PKCE login succeeds on Windows, macOS, and Linux extension hosts.
- [ ] Device Code login works as an explicit fallback.
- [ ] Extension-owned tokens survive VS Code restart through `SecretStorage`.
- [ ] Access tokens refresh automatically before expiry.
- [ ] Concurrent requests and multiple VS Code windows do not reuse or double-rotate a refresh token.
- [ ] Model discovery, account usage, HTTP Responses, and WebSocket Responses all use the current credential revision.
- [ ] One pre-output unauthorized failure can refresh and retry safely.
- [ ] No request is replayed after visible output or tool activity.
- [ ] Credential changes close old authenticated WebSockets and clear account-bound caches.
- [ ] Permanent refresh failure produces a clear sign-in-again path without repeated network attempts.
- [ ] Sign-out attempts revocation and always removes local extension-owned credentials.
- [ ] Legacy Codex file credentials remain read-only and are never modified or revoked.
- [ ] API-key and non-Codex endpoint behavior remains compatible.
- [ ] `npm run check`, all auth/smoke tests, and `npm run compile` pass five consecutive times.
- [ ] No secret appears in logs, test output, PR descriptions, or committed fixtures.
