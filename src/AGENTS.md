# Source Guidelines

## Purpose

`src/` contains the VS Code provider runtime: configuration loading, credential resolution, model discovery, request execution, and usage reporting.

## Key Files

- `config.ts`: user-facing settings normalization, including transport policy.
- `provider.ts`: VS Code `LanguageModelChatProvider` implementation and logging.
- `responsesClient.ts`: shared request builder and the HTTP/WebSocket transport facade for Responses streaming.
- `convertMessages.ts`: conversion from VS Code chat messages into Responses input items.
- `responseBranchStore.ts`: in-memory branch reuse cache keyed by normalized request envelope and transcript prefix.
- `models.ts`: upstream model discovery and provider model shaping.

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
- Tool-result continuations must replay the matching `function_call` and `function_call_output` as full input; neither the provider nor a managed WebSocket session may compress that replay back into a standalone tool-output continuation.
- Preserve configured `instructions` verbatim when tools are provided; tool definitions and the model determine tool-call ordering.
- Capture function-call metadata from `response.output_item.added` and report it once at `response.function_call_arguments.done`, preferring the captured non-empty name; retain `response.output_item.done` only as a deduplicated compatibility fallback.
- Never replay a `function_call` with an empty call ID or name. Drop its matching `function_call_output`, but retain standalone valid tool outputs used by normal continuation flows.
- Preserve each Responses reasoning item's identity when creating VS Code thinking parts. Once visible text starts, do not insert later reasoning parts into that text stream.
