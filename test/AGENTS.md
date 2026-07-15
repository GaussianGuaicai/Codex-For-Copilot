# Test Guidelines

## Purpose

`test/` contains focused integration-style checks for request shape, transport behavior, and live backend probes.

## Key Files

- `smokeResponsesClient.mjs`: local mock coverage for HTTP transport, WebSocket transport, WebSocket-to-HTTP fallback, and reasoning-item identity.
- `smokeCodexRequestBuilder.mjs`: request-shape coverage, including configured-instruction preservation for requests with function tools.
- `smokeProviderFallback.mjs`: local mock coverage for provider recovery, unavailable-model handling, full-input replay for tool-result continuations, and interleaved reasoning/text presentation.
- `smokeCodexWebSocketLifecycle.mjs`: managed WebSocket handshake, prewarm, incremental request, full tool-replay request shape, and reasoning-item identity coverage.
- `smokeConversationReuse.mjs`: local semantic coverage for append detection, stable serialization, branch reuse invalidation, and malformed tool-history filtering.
- `realBackendProbe.mjs`: live ChatGPT Codex backend probe using local credentials.
- `extensionHostSmoke.cjs`: lightweight extension-host-facing smoke coverage.

## Constraints

- Prefer narrow transport semantics checks over broad suites.
- Keep HTTP and WebSocket assertions aligned so transport parity regressions are caught in one place.
- Keep branch reuse semantics deterministic: append-only reuse, fork reset, and tool-change busting should be covered by local smoke tests.
- A full replay containing `function_call_output` must retain its matching `function_call` and omit `previous_response_id`, including after managed WebSocket incremental processing.
- Repeated reasoning deltas for one Responses item must retain one thinking-part ID, and reasoning that arrives after visible text must not interrupt the text sequence.
- Complete function calls must be reported from `response.function_call_arguments.done` before later text, using the non-empty `output_item.added` name when the early event omits it; `response.output_item.done` must not duplicate the tool call.
- Malformed historical function calls and their matched outputs must be excluded, while valid standalone tool outputs remain available for continuation.
- Live backend probes should stay opt-in and credential-dependent; local smoke tests must remain self-contained.
