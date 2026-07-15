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

## Approximate

- VS Code does not expose a stable chat session identifier. Session/thread/fork identity is inferred from append-only `ResponseBranchStore` history with a TTL.
- WebSocket preconnection starts when the first request resolves its synthetic identity. It is not scheduled during model discovery because no reliable VS Code chat/session identity exists at that point.
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
```

The benchmark prints median/p95 first-visible and total latency, request/compressed bytes, connection reuse rate, and fallback rate. Use `CODEX_BENCHMARK_LABEL` to distinguish baseline and candidate runs.

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

The candidate HTTP median was slower in this sample, while p95 was substantially better for the short request and similar for the first long-history run. An immediate candidate rerun also showed backend variance (short 1898/2463 ms; long 1676/6956 ms first-visible median/p95). Because the request semantics now include Codex identity, cache key, and continuation metadata, the old and new HTTP payloads are not byte-identical. The default remains `auto`: prewarm improved fresh WebSocket median first-visible latency by about 15%, and reused WebSocket was the fastest candidate median. Compression remains thresholded rather than forced for small requests.

## Real-backend functional validation

- `gpt-5.5`: HTTP initial + recovery continuation passed 5/5 runs.
- `gpt-5.5`: WebSocket prewarm + reused continuation passed 5/5 runs, always reporting `[false, true]` connection reuse and no fallback.
- `gpt-5.6-sol`: HTTP initial and WebSocket prewarm + reused continuation passed.
- `auto`: a deliberately unavailable direct WebSocket route fell back to HTTP for only that session and completed successfully.
