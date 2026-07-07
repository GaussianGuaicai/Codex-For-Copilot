# Source Guidelines

## Purpose

`src/` contains the VS Code provider runtime: configuration loading, credential resolution, model discovery, request execution, and usage reporting.

## Key Files

- `config.ts`: user-facing settings normalization, including transport policy.
- `provider.ts`: VS Code `LanguageModelChatProvider` implementation and logging.
- `responsesClient.ts`: shared request builder and the HTTP/WebSocket transport facade for Responses streaming.
- `convertMessages.ts`: conversion from VS Code chat messages into Responses input items.
- `models.ts`: upstream model discovery and provider model shaping.

## Constraints

- Keep provider-visible callback semantics transport-agnostic: HTTP and WebSocket must report the same deltas and terminal events.
- Keep ChatGPT Codex compatibility logic centralized in `responsesClient.ts`, `config.ts`, and `secrets.ts`; do not duplicate header or base URL normalization across call sites.
- WebSocket requests must send `response.create` payloads without the HTTP-only `stream` field.
- When `transport` is `auto`, only fall back to HTTP for transport availability failures, not for successful in-band model responses.