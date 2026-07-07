# Test Guidelines

## Purpose

`test/` contains focused integration-style checks for request shape, transport behavior, and live backend probes.

## Key Files

- `smokeResponsesClient.mjs`: local mock coverage for HTTP transport, WebSocket transport, and WebSocket-to-HTTP fallback.
- `realBackendProbe.mjs`: live ChatGPT Codex backend probe using local credentials.
- `extensionHostSmoke.cjs`: lightweight extension-host-facing smoke coverage.

## Constraints

- Prefer narrow transport semantics checks over broad suites.
- Keep HTTP and WebSocket assertions aligned so transport parity regressions are caught in one place.
- Live backend probes should stay opt-in and credential-dependent; local smoke tests must remain self-contained.