# Codex transport architecture

The compatibility profile is enabled only when both conditions are true:

1. The credential is a ChatGPT Codex access token.
2. The endpoint is `https://chatgpt.com/backend-api/codex`.

API-key and third-party endpoints keep the standard OpenAI SDK request path.

## Modules

- `codexProtocol.ts` owns the upstream commit marker, header names, WebSocket beta value, backend feature gate, metadata serialization, and response-header parsing.
- `codexIdentity.ts` owns installation, extension-host window, synthetic session/thread, fork parent, and turn identifiers.
- `codexRequestBuilder.ts` creates the shared HTTP/WebSocket Responses request and the strict non-input request fingerprint.
- `codexWebSocketSession.ts` is the only module that reaches the SDK Node WebSocket adapter. It serializes streams, captures upgrade headers and metadata events, enforces idle timeout, retains raw output items, prewarms, and creates incremental frames.
- `codexConnectionManager.ts` scopes reusable connections and fallback capabilities by endpoint, credential identity, account, compatibility profile, session, and thread.
- `codexFetchAdapter.ts` wraps the OpenAI SDK fetch hook for timing, raw HTTP response headers, and optional Zstandard request compression.
- `codexTelemetry.ts` supplies irreversible short hashes and redaction helpers.
- `responsesClient.ts` remains the transport-neutral entry point and continues to use `client.responses.create()` and `ResponsesWS`.

## Identity lifetimes

| Identity | Lifetime |
| --- | --- |
| Installation | Persisted in `ExtensionContext.globalState` |
| Window | One extension-host lifetime |
| Session/thread | One synthetic append-only history branch |
| Parent thread | Only a history fork with a non-empty matching prefix |
| Turn | New user input; retained for tool results, retries, and recovery |
| Turn State | One turn only; cleared before the next user turn |

`prompt_cache_key` is the synthetic thread ID. The credential identity contains only account/source data and an irreversible token hash, so refreshed credentials cannot reuse an old connection.

## Failure behavior

- `auto`: a transport-availability failure marks only the current synthetic session as HTTP fallback.
- `websocket`: errors are returned directly and no HTTP request is made.
- `http`: no WebSocket or prewarm connection is created.
- A connection-limit error is retried once on a fresh socket only before visible activity.
- A continuation miss invalidates the response anchor and retries full input once only if no text, reasoning, or tool call was reported.
- Prewarm failure disables prewarm for that endpoint/session, reconnects, and continues ordinary WebSocket generation.
- Configuration or credential changes dispose old sockets. All queues, timers, and capability entries have bounded lifetime.

## Migration

Existing configuration keeps `transport: auto`. The two new settings default to `auto`:

- `codexModelProvider.websocketPrewarm`
- `codexModelProvider.requestCompression`

No Codex-specific identity, beta header, prewarm, Turn State, or compression behavior is sent to ordinary OpenAI API keys or third-party endpoints.
