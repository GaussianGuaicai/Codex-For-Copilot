# Test Guidelines

## Purpose

`test/` contains focused integration-style checks for request shape, transport behavior, and live backend probes.

## Key Files

- `smokeResponsesClient.mjs`: local mock coverage for HTTP transport, WebSocket transport, and WebSocket-to-HTTP fallback.
- `smokeProviderFallback.mjs`: local mock coverage for hiding legacy catalog models and reporting a direct error when `/responses` rejects a discovered model.
- `smokeConversationReuse.mjs`: local semantic coverage for append detection, stable serialization, and branch reuse invalidation.
- `realBackendProbe.mjs`: live ChatGPT Codex backend probe using local credentials.
- `extensionHostSmoke.cjs`: lightweight extension-host-facing smoke coverage.

## Constraints

- Prefer narrow transport semantics checks over broad suites.
- Keep HTTP and WebSocket assertions aligned so transport parity regressions are caught in one place.
- Keep branch reuse semantics deterministic: append-only reuse, fork reset, and tool-change busting should be covered by local smoke tests.
- Live backend probes should stay opt-in and credential-dependent; local smoke tests must remain self-contained.