# Source Guidelines

## Purpose

`src/` contains the VS Code provider runtime: configuration loading, credential resolution, model discovery, request execution, and usage reporting.

## Key Files

- `config.ts`: user-facing settings normalization, including transport policy.
- `provider.ts`: VS Code `LanguageModelChatProvider` implementation and logging.
- `responsesClient.ts`: shared request builder and the HTTP/WebSocket transport facade for Responses streaming.
- `convertMessages.ts`: conversion from VS Code chat messages into Responses input items.
- `responseBranchStore.ts`: in-memory branch reuse cache keyed by normalized request envelope and transcript prefix.
- `codexWebSocketSession.ts`: serializes managed WebSocket streams and preserves safe continuation state.
- `models.ts`: upstream model discovery and provider model shaping.
- `codexModelCache.ts`: bounded stale-while-revalidate cache for discovered provider models.
- `codexLatency.ts`: redacted provider-to-response stage timing and derived latency metrics.
- `codexContinuation.ts`: shared full-request/response snapshot for branch recovery and managed WebSocket continuation.
- `codexToolSchemaCache.ts`: bounded immutable conversion cache for stable tool definitions and branch signatures.

## Constraints

- Keep provider-visible callback semantics transport-agnostic: HTTP and WebSocket must report the same deltas and terminal events.
- Keep ChatGPT Codex compatibility logic centralized in `responsesClient.ts`, `config.ts`, and `secrets.ts`; do not duplicate header or base URL normalization across call sites.
- Keep Responses tool conversion and request-field shaping in `codexRequestBuilder.ts`; transport code consumes its shared request output rather than maintaining a second conversion path.
- WebSocket requests must send `response.create` payloads without the HTTP-only `stream` field.
- When `transport` is `auto`, only fall back to HTTP for transport availability failures, not for successful in-band model responses.
- A `Model not found` response for the requested model is an in-band model error, not a transport failure; surface it without an HTTP retry.
- Conversation reuse is allowed only for append-only transcript growth with an identical shared-builder request fingerprint; input, prior-response IDs, cache routing, and turn metadata are excluded, while model settings, tools, and schema changes must bust reuse.
- Request-compression capability is endpoint-normalized, TTL-bounded, and reset for connection configuration or credential changes; only an explicit Content-Encoding rejection may disable it.
- Both transports must convert a rejected `previous_response_id` into a continuation miss so the provider can retry once with the full input history.
- Tool-result continuations may send only appended `function_call_output` items with `previous_response_id` on an eligible managed WebSocket. HTTP, socket changes, history forks, incompatible envelopes, and cached capability misses must retain the full `function_call` plus `function_call_output` replay.
- Preserve configured `instructions` verbatim when tools are provided; tool definitions and the model determine tool-call ordering.
- Capture function-call metadata from `response.output_item.added` and report it once at `response.function_call_arguments.done`, preferring the captured non-empty name; retain `response.output_item.done` only as a deduplicated compatibility fallback.
- Never replay a `function_call` with an empty call ID or name. Drop its matching `function_call_output`, but retain standalone valid tool outputs used by normal continuation flows.
- Preserve each Responses reasoning item's identity when creating VS Code thinking parts. Once visible text starts, do not insert later reasoning parts into that text stream.
- Latency traces may include timestamps, counts, transport state, and request byte sizes, but never prompt text, tool arguments or results, credentials, Turn State, or reasoning content.
- Model discovery may block only for a cold or expired cache entry. Fresh entries are returned directly; stale entries remain usable while one background refresh is in flight, and failed background refreshes must retain the stale entry.
- A valid selected `codex::` model ID resolves directly for chat requests; only untrusted, disabled, or temporarily unavailable IDs require a model-directory lookup.
- `generate:false` prewarm is strictly opt-in and best effort: `auto` skips speculative work, while an enabled prewarm has a short independent budget, must not cancel the formal request, and a timed-out prewarm socket must be discarded before the formal request starts.
- An idle WebSocket preconnection is keyed only by endpoint/account/auth compatibility, carries no synthetic request identity, and must be short-lived, bounded, and claimed by at most one formal thread request.
- Latency context is a fixed whitelist of timing-safe counts and enums; never pass raw transport event payloads or request data into it.
- Tool schema caching may retain only cloned function definitions, semantic signatures, and byte counts. It must never cache user input, tool output, prompt content, or raw tool-result data.
- Branch Store owns ordinary conversation continuation snapshots. A managed WebSocket may retain only its short-lived prewarm snapshot; it must not independently choose ordinary or tool-result continuation.
- Fork diagnostics must use redacted item summaries only. Provider-validated ordinary appends and eligible WebSocket tool-result appends may retain their explicit `previous_response_id`; all other tool-result requests must omit it.
- Request diagnostics must distinguish ordinary `previous_response_id` reuse, WebSocket tool-result incremental continuation, and tool-result full replay. Thinking Effort may arrive through `modelOptions`; support recognized reasoning and thinking shapes while logging only the resolved enum and its source.
- Account usage must normalize server-provided Credit budgets, balances, and rate-limit windows before display selection. Do not infer account usage from plan names or label a Credit budget with an unsupported billing period.
- A complete workspace Credit budget is the compact account-usage display; all remaining rate limits and Credit budgets must remain visible in the details tooltip.
