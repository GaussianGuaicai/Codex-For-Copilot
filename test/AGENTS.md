# Test Guidelines

## Purpose

`test/` contains focused integration-style checks for request shape, transport behavior, and live backend probes.

## Key Files

- `smokeResponsesClient.mjs`: local mock coverage for HTTP transport, WebSocket transport, WebSocket-to-HTTP fallback, and reasoning-item identity.
- `smokeCodexRequestBuilder.mjs`: request-shape coverage, including configured-instruction preservation for requests with function tools.
- `smokeProviderFallback.mjs`: local mock coverage for provider recovery, unavailable-model handling, full-input replay for tool-result continuations, and interleaved reasoning/text presentation.
- `smokeCodexWebSocketLifecycle.mjs`: managed WebSocket handshake, prewarm, incremental request, full tool-replay request shape, and reasoning-item identity coverage.
- `smokeConversationReuse.mjs`: local semantic coverage for append detection, stable serialization, branch reuse invalidation, and malformed tool-history filtering.
- `smokeCodexLatency.mjs`: deterministic coverage for redacted provider latency stage accounting.
- `smokeCodexModelCache.mjs`: deterministic stale-while-revalidate model-cache coverage without sleeps.
- `smokeCodexToolSchemaCache.mjs`: bounded, order-aware, immutable tool-schema cache coverage.
- `smokeCodexPrewarmBudget.mjs`: local recovery coverage for a timed-out `generate:false` prewarm.
- `smokeCodexPreconnection.mjs`: local identity-free handshake and formal-request socket-claim coverage.
- `smokeCodexTurnLifecycle.mjs`: branch turn identity and continuation-snapshot clone coverage.
- `realBackendProbe.mjs`: live ChatGPT Codex backend probe using local credentials, including opt-in real function-call continuation validation.
- `benchmarkProviderBackend.mjs`: opt-in real-backend benchmark from provider entry through first visible output and completion.
- `extensionHostSmoke.cjs`: Extension Development Host coverage for model selection, streamed tool calls, and compatible full-replay tool-result recovery.
- `runExtensionHostSmoke.mjs`: isolated-profile runner for the Extension Development Host smoke through the VS Code CLI.

## Constraints

- Prefer narrow transport semantics checks over broad suites.
- Keep HTTP and WebSocket assertions aligned so transport parity regressions are caught in one place.
- An in-band `Model not found` error for the requested model must not make `auto` issue an HTTP fallback request.
- Keep branch reuse semantics deterministic: append-only reuse, fork reset, and tool-change busting should be covered by local smoke tests.
- Settings that alter the Responses request envelope, including service tier and output limits, must force full-input replay without `previous_response_id`.
- Compression tests must distinguish explicit encoding rejection from ordinary Responses `400`/`422` errors, which must not disable future compressed requests.
- A full replay containing `function_call_output` must retain its matching `function_call` and omit `previous_response_id`, including after managed WebSocket incremental processing.
- Fork-reuse diagnostics must never expose message content; assert redacted type/role/byte/hash summaries instead. A managed WebSocket must preserve a Provider-validated ordinary append's explicit `previous_response_id` and report it in transport metrics.
- Reasoning-option tests must prove recognized `modelOptions.thinking` shapes override the model's default effort, and request diagnostics must identify tool-output full replay separately from ordinary prior-response reuse.
- A model-generated tool-loop test must verify the first tool call is emitted once and the following tool result is replayed with its matching call.
- The Extension Development Host smoke must exercise `vscode.lm.selectChatModels()` and a complete tool-call/result loop, so the provider-facing VS Code API boundary is covered separately from direct provider tests.
- Repeated reasoning deltas for one Responses item must retain one thinking-part ID, and reasoning that arrives after visible text must not interrupt the text sequence.
- Complete function calls must be reported from `response.function_call_arguments.done` before later text, using the non-empty `output_item.added` name when the early event omits it; `response.output_item.done` must not duplicate the tool call.
- Malformed historical function calls and their matched outputs must be excluded, while valid standalone tool outputs remain available for continuation.
- Live backend probes should stay opt-in and credential-dependent; local smoke tests must remain self-contained.
- Provider benchmarks must instantiate `CodexModelProvider` and report redacted latency traces, not infer provider cost from transport-only timings.
- Real tool-continuation probes must use a side-effect-free test tool and must report only aggregate outcomes, never credentials, prompt content, tool arguments, or tool output.
- Latency tests must use deterministic timestamps or mocks; do not introduce sleeps to assert timing behavior.
- Model-cache tests must prove cold blocking, fresh reuse, stale immediate return, and single-flight background refresh with deterministic promises.
- Provider-level stale-cache coverage must hold the refresh pending and prove `/responses` proceeds before the refresh resolves.
- Provider coverage must prove a valid selected `codex::` model ID reaches `/responses` without waiting for a cold `/models` lookup and still applies a configured alias.
- Tool-schema tests must cover first-build miss, repeat-build hit, order-sensitive invalidation, immutable cached definitions, and same-object semantic mutation invalidation.
- Prewarm timeout tests must prove that an explicitly enabled prewarm uses a new formal-request socket and streams once; `auto` must skip speculative prewarm without a test sleep.
- Preconnection tests must prove a single upgrade, no synthetic identity in the handshake, and identity only on the formal `response.create` request.
- The `provider-websocket-preconnected` benchmark must wait for the idle handshake and assert a `preconnected` formal connection origin before recording the timed request.
- Continuation state tests must prove snapshot mutation cannot leak back into the stored branch state.
