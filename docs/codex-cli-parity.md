# Codex CLI transport parity

Protocol baseline:

- Codex For Copilot: `2987db25dc15b79cd22dc2ccc08f4c44b7db1351`
- `openai/codex`: `72b41c55fb32f62373e070d6ac0cde7ba563989b`
- WebSocket beta: `responses_websockets=2026-02-06`

## Baseline checklist

| Capability | Baseline | Target |
| --- | --- | --- |
| Official OpenAI Node SDK HTTP streaming | Existing | Preserve |
| SDK `ResponsesWS` transport | Existing | Encapsulate and harden |
| HTTP/WebSocket shared request body | Partial | Central request builder |
| `previous_response_id` append continuation | Existing, branch-cache based | Validate full request fingerprint and retain raw output items |
| Installation/session/thread/turn/window identity | Missing | Implement with explicit lifetimes |
| Stable `prompt_cache_key` | Missing | Stable per synthetic thread |
| Codex `client_metadata` | Missing | Canonical identity and turn metadata projection |
| Dynamic request headers | Partial fixed credential headers | Per request and per turn |
| WebSocket upgrade response headers | Missing | Read via the SDK Node socket adapter |
| `x-codex-turn-state` | Missing | Turn-scoped capture and replay |
| Connection reuse | Existing, keyed only by response ID | Session/endpoint/auth keyed manager |
| `generate:false` prewarm | Missing | Best effort with endpoint/session disable |
| Session-level HTTP fallback | Missing; global socket disposal | Per synthetic session |
| Request compression | Missing | SDK custom `fetch`, Codex backend only |
| Continuation recovery | Existing basic full replay | Preserve identity and prevent duplicate visible output |
| Structured transport telemetry | Partial | Add redacted timing and route fields |
| Attestation / Agent Identity | Not available | Deliberately not sent |
| Native Codex session IDs from VS Code | VS Code API limitation | Deterministic synthetic branch identity |

Protocol constants are centralized in `src/codexProtocol.ts` and carry the upstream commit reference.

The final upstream recheck found no changes between the initial `4df8027a…` snapshot and `72b41c55…` in the inspected Responses transport, request, metadata, or header files.

## Implemented

- Truthful extension originator/version/User-Agent plus dynamic session, thread, installation, window, parent-thread, turn metadata, and request IDs.
- Shared typed HTTP/WebSocket request construction, stable per-thread cache key, canonical client metadata, raw output item retention, and strict request fingerprints.
- SDK `ResponsesWS` encapsulation, upgrade-header adapter, `response.metadata` Turn State capture, same-turn replay, stream serialization, idle timeout, connection reuse, prewarm, and incremental frames.
- Per-session automatic HTTP fallback, bounded connection/capability caches, connection-limit retry, continuation recovery without duplicate visible output, and credential/config invalidation.
- SDK custom-fetch timing and optional Zstandard request compression with one safe uncompressed retry.
- Focused protocol, identity, request, turn, HTTP, WebSocket, fallback, and compression smoke tests plus an opt-in real-backend benchmark.

## Latency and continuation behavior

The provider records a redacted latency trace from the entry of
`provideLanguageModelChatResponse` through completion. It includes setup, model
resolution, conversion, branch resolution, identity resolution, connection,
prewarm, request-created, first-visible, and completion timing. The accompanying
context is restricted to counts and enums such as cache state, transport origin,
request bytes, tool count, tool-schema byte count/cache state, request-build time,
and service tier. It never contains prompt content,
tool arguments or results, credentials, Turn State, or reasoning content.

Stable tool definitions are converted into a bounded immutable cache keyed by
tool order, names, descriptions, and input schemas. Each lookup verifies the
current canonical tool signature before reusing an object-identity entry, so an
in-place name, description, or nested schema change rebuilds the definition and
branch-envelope tool signature. The cache serves both the Responses request
builder and branch-envelope tool signatures. It retains cloned schema definitions
and aggregate byte counts only; no input, prompt, tool output, or raw tool-result
content is cached.

Model discovery uses a bounded stale-while-revalidate cache:

| Cache state | Request behavior |
| --- | --- |
| Fresh, up to 10 minutes | Return the discovered models without a `/models` request. |
| Stale, up to 1 hour | Use the existing models immediately and run one background refresh. |
| Cold or expired | Wait for discovery once; discovery failure falls back for 60 seconds. |
| Selected `codex::` model ID | Parse the trusted provider ID directly for chat requests, including configured aliases, without waiting for `/models`. |
| Exact `Model not found` | Invalidate the scoped cache, temporarily hide the rejected model, and refresh the directory in the background. |

For compatible ChatGPT Codex WebSocket sessions, model discovery may schedule one
45-second idle preconnection per endpoint/account/auth scope. The empty handshake
contains authentication, account, extension origin, and the WebSocket beta header,
but deliberately omits synthetic installation, session, thread, and turn identity.
The next formal request claims that socket and supplies its actual identity. A
`generate:false` prewarm remains an explicit experimental option with a 400ms
independent budget. `auto` skips it and relies on idle handshake preconnection,
because the live Codex backend probe observed a bounded prewarm timeout. When
explicitly enabled, a timeout discards that socket and a fresh formal request
proceeds without duplicate output.

### Tool result continuation

`CodexContinuationSnapshot` is the shared state model for the branch store and a
managed WebSocket session. It records the full request, completed response ID,
raw response items, semantic request fingerprint, and turn ID after every
successful response.

The extension currently sends a full input replay whenever appended input contains
`function_call_output`. This is intentional. Official Responses guidance requires
manual history management to preserve prior response output items, including
encrypted reasoning, for `store: false` workflows. The ChatGPT Codex backend has
also rejected the standalone tool-output continuation in five repeated bounded
WebSocket probes; every run recovered through a full replay. The replay retained
the matching `function_call`, omitted `previous_response_id`, used three input
items, and produced one initial tool call without duplicate output. A future
backend-specific capability probe may enable a strictly matched incremental
tool-output path only after repeatable real-backend validation accepts it.

The local suite covers a model-generated single-tool loop, full replay shape,
no duplicate tool-call reporting, stale-model non-blocking behavior, preconnection
claiming, and bounded prewarm recovery. The existing real-backend benchmark table
above remains the recorded transport baseline; new provider-level latency numbers
must be measured against the same model, prompt, and network conditions rather
than inferred from local mock timings.

## Approximate

- VS Code does not expose a stable chat session identifier. Session/thread/fork identity is inferred from append-only `ResponseBranchStore` history with a TTL.
- WebSocket preconnection can be scheduled after model discovery or while a formal request is being prepared. It is keyed only by endpoint/account/auth compatibility, so the idle handshake needs no VS Code chat/session identity; the formal request claims that socket and supplies its synthetic identity.
- `generate:false` is best effort. Unsupported sessions disable it without changing the selected transport.

## VS Code API limitations

- The provider cannot obtain a canonical Chat session ID or branch event from the stable `LanguageModelChatProvider` API.
- The provider cannot report raw usage into VS Code's internal context-window widget.
- Only VS Code-supported text, thinking, and tool-call parts are emitted; other response items remain internal continuation state.

## Official identity limitations

- The extension does not send `x-oai-attestation`, Agent Identity, `x-openai-subagent`, memory-generation, Responses Lite, or FedRAMP headers.
- The `ResponsesWS` upgrade adapter depends on the public SDK Node adapter's `platformSocket`; its focused test fails clearly if that surface changes.

## Validation commands

```text
npm run check
npm run test:codex-parity
npm run test:smoke
npm run compile
CODEX_BENCHMARK_BACKEND=1 npm run test:benchmark-backend
CODEX_BENCHMARK_BACKEND=1 npm run test:benchmark-provider
```

The transport benchmark prints median/p95 first-visible and total latency, request/compressed bytes, request-build time, schema-cache hit rate, connection reuse rate, and fallback rate. The provider benchmark exercises `CodexModelProvider` from entry through completion and reports provider-to-first-visible, model resolution, full request preparation (schema lookup, envelope construction, and branch fingerprinting), request-to-created, created-to-first-visible, and total timing. Its `provider-websocket-preconnected` scenario waits for an identity-free handshake and asserts that the formal request claims that exact idle socket before timing it. Use `CODEX_BENCHMARK_LABEL` to distinguish baseline and candidate runs.

## Real-backend benchmark

Model: `gpt-5.5`. Samples: 10 per scenario. Results vary with backend load, so these values describe this run rather than a service-level guarantee.

| Candidate scenario | First visible median / p95 | Total median / p95 | Median request bytes | Reuse | Fallback |
| --- | ---: | ---: | ---: | ---: | ---: |
| HTTP short | 1805 / 2329 ms | 1943 / 2524 ms | 981 | 0% | 0% |
| WebSocket fresh | 2260 / 3629 ms | 2374 / 3750 ms | 1045 | 0% | 0% |
| WebSocket prewarm | 1915 / 2885 ms | 2045 / 3011 ms | 1072 | 100% | 0% |
| WebSocket reused continuation | 1748 / 5482 ms | 1973 / 7390 ms | 1132 | 100% | 0% |
| HTTP long history | 1474 / 2269 ms | 1678 / 2462 ms | 35,536 | 0% | 0% |
| HTTP large compressed | 1763 / 3873 ms | 1881 / 4020 ms | 160,983 → 560 | 0% | 0% |

The locked pre-change commit was also run 10 times for the directly comparable HTTP scenarios:

| Scenario | Baseline first visible median / p95 | Candidate first visible median / p95 | Baseline total median / p95 | Candidate total median / p95 |
| --- | ---: | ---: | ---: | ---: |
| HTTP short | 1439 / 5580 ms | 1805 / 2329 ms | 1822 / 5999 ms | 1943 / 2524 ms |
| HTTP long history | 1065 / 2200 ms | 1474 / 2269 ms | 1370 / 2501 ms | 1678 / 2462 ms |

The candidate HTTP median was slower in this sample, while p95 was substantially better for the short request and similar for the first long-history run. An immediate candidate rerun also showed backend variance (short 1898/2463 ms; long 1676/6956 ms first-visible median/p95). Because the request semantics now include Codex identity, cache key, and continuation metadata, the old and new HTTP payloads are not byte-identical. The historical prewarm candidate improved fresh WebSocket median first-visible latency by about 15%, but the current default `auto` skips speculative `generate:false` requests after a live timeout observation; explicit `enabled` remains available for controlled measurement. Compression remains thresholded rather than forced for small requests.

### Full Provider-path run

Model: `gpt-5.5`. Samples: 10 per scenario. This run uses the full provider
path and the same minimal `OK` workload for every scenario. It is not directly
comparable to the earlier transport-only table.

| Scenario | Provider-to-first-visible median / p95 | Total median / p95 | Model resolution median | Request preparation median | Median request bytes | Reuse |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First HTTP request | 2642 / 4962 ms | 2723 / 5456 ms | 316 ms | 0.073 ms | 991 | 0% |
| Direct selected-model HTTP | 1756 / 3073 ms | 1874 / 3175 ms | 0 ms | 0.025 ms | 991 | 0% |
| WebSocket, verified preconnected | 1774 / 2698 ms | 1842 / 2908 ms | 0 ms | 0.038 ms | 1055 | 0% |
| WebSocket, previous-response reuse | 1698 / 2194 ms | 1806 / 2257 ms | 1 ms | 0.042 ms | 1061 | 100% |

The direct selected-model path removes the model-directory wait from this
workload. The remaining first-visible time is dominated by backend request and
generation phases rather than local request preparation, which remains below
0.1 ms at the median for this no-tool workload.

## Real-backend functional validation

- `gpt-5.5`, HTTP, low reasoning, disabled prewarm: initial response succeeded; `store: false` ordinary continuation rejected `previous_response_id` and recovered to `PONG` with full input.
- `gpt-5.5`, WebSocket, medium reasoning, enabled prewarm: identity-free preconnection was claimed by the formal request, the 400 ms prewarm timed out and was discarded, and the next turn reused the response session without fallback.
- `gpt-5.5`, `auto`, high reasoning, auto prewarm: `skipped-auto` was recorded, the preconnected socket was claimed, and the next turn reused the response session without fallback.
- `gpt-5.5`, WebSocket tool loop, disabled prewarm: 5/5 side-effect-free probes rejected standalone incremental tool output and recovered via full replay with one initial tool call and no duplicate output.
- `gpt-5.6-sol`: HTTP initial and WebSocket prewarm + reused continuation passed.
- `auto`: a deliberately unavailable direct WebSocket route fell back to HTTP for only that session and completed successfully.
