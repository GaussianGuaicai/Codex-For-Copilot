# Changelog

This changelog is maintained by Release Please from Conventional Commit titles merged into `master`.

## [1.4.2](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.4.1...v1.4.2) (2026-08-04)


### Bug Fixes

* improve extension logging diagnostics ([#59](https://github.com/GaussianGuaicai/Codex-For-Copilot/issues/59)) ([7722eeb](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/7722eeb85dc2857366f28faa8b4d6acf0371a8e6))

## [1.4.1](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.4.0...v1.4.1) (2026-08-01)


### Bug Fixes

* improve Codex reasoning thinking presentation ([#56](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/56)) ([abb6ca2](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/abb6ca235d402c0f27377d5f62faa89c441f67ec))

## [1.4.0](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.3.3...v1.4.0) (2026-07-27)


### Features

* **auth:** add native ChatGPT OAuth sign-in ([#52](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/52)) ([ce83ec2](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/ce83ec2dc23dc0d7bc7c433f02a7081df755a863))

## [1.3.3](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.3.2...v1.3.3) (2026-07-26)


### Bug Fixes

* **models:** support catalog reasoning efforts ([f209b9d](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/f209b9d3e9afd3483050a52fc49e4232e63dd980))

## [1.3.2](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.3.1...v1.3.2) (2026-07-25)


### Bug Fixes

* isolate WebSocket custom headers ([cf543eb](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/cf543eb1c87fa1a852b8885250ed54e03179e375))

## [1.3.1](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.3.0...v1.3.1) (2026-07-22)


### Bug Fixes

* enforce model discovery policy ([#31](https://github.com/GaussianGuaicai/Codex-For-Copilot/issues/31)) ([a4e4cbe](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/a4e4cbeb35774bccbc836bbefe66ae8a6c27b086))
* keep exhausted credit budgets visible ([#35](https://github.com/GaussianGuaicai/Codex-For-Copilot/issues/35)) ([556af22](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/556af22a52b273a3dbf8f9a8d107130038762e5b))

## [1.3.0](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.2.1...v1.3.0) (2026-07-22)


### Features

* add selectable context window profiles ([#23](https://github.com/GaussianGuaicai/Codex-For-Copilot/issues/23)) ([06db8ad](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/06db8adb3c4852c5d130fd43cca7ec5a2d8980c9)), closes [#21](https://github.com/GaussianGuaicai/Codex-For-Copilot/issues/21)

## [1.2.1](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.2.0...v1.2.1) (2026-07-20)


### Bug Fixes

* classify wrapped continuation misses ([80da656](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/80da656fc4fcd1769e9c8aab11cefd11005bca29))
* invalidate stale continuation branches ([f45a755](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/f45a755f9a84fca70172ea311814ae63d8c7e23d))
* match IPv6 no_proxy hosts ([#26](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/26)) ([47f7856](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/47f78567b5dae52259aa9d45640ad15affd8aeda))
* recover wrapped continuation misses ([ed38c37](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/ed38c37363bb37cd15f2e0ef42431987e995c103))

## [1.2.0](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.1.2...v1.2.0) (2026-07-19)

### Codex protocol compatibility

* Align the ChatGPT Codex transport with the current Codex CLI request protocol while preserving the VS Code `LanguageModelChatProvider` contract and the official OpenAI Node SDK as the primary client ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Add installation, window, session, thread, parent-thread, and turn identity lifecycles together with stable per-thread `prompt_cache_key`, canonical `client_metadata`, truthful extension origin/version metadata, and dynamic request identifiers ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Capture and reuse supported server routing and response metadata, including Codex Turn State, request IDs, resolved models, and model-catalog ETags ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Restrict Codex-specific compatibility behavior to ChatGPT Codex access-token credentials on the canonical backend, leaving API-key and third-party Responses-compatible endpoints on the standard SDK path ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).

### HTTP, WebSocket, and continuation lifecycle

* Unify HTTP and WebSocket request construction so tools, reasoning, text configuration, service tier, identity metadata, and continuation state use the same validated request semantics ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Add managed SDK `ResponsesWS` sessions with connection pooling, serialized streams, upgrade-header capture, idle preconnection, bounded optional prewarm, cancellation, reconnect, and credential/config invalidation ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Add per-session HTTP fallback, bounded connection-limit recovery, and strict continuation fingerprints so incompatible requests safely use full replay instead of reusing stale state ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Retain raw Responses output items required for `store: false` recovery and prevent continuation failures from duplicating visible model or tool output in VS Code Chat ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Preserve full replay for tool-result turns when the ChatGPT Codex backend rejects standalone `function_call_output` continuation ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).

### Performance and model discovery

* Add bounded stale-while-revalidate model discovery caching, direct parsing of trusted selected `codex::` model IDs, and targeted invalidation when the backend rejects a stale model ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Cache immutable tool schemas with signature validation so stable definitions avoid repeated conversion while in-place schema changes are detected correctly ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Add SDK custom-fetch timing and thresholded Zstandard request compression with a safe uncompressed retry; speculative prewarm and compression remain conservative in `auto` mode by default ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).

### Diagnostics, privacy, and validation

* Add structured latency measurements across provider setup, model resolution, request construction, connection establishment, first reasoning/text/tool output, continuation dispatch, and completion ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Separate extension transport latency from the VS Code Chat tool-execution loop and keep logs limited to redacted timings, counts, enums, sizes, and hashes rather than prompts, credentials, reasoning, tool data, or Turn State values ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).
* Expand protocol, identity, request-builder, HTTP, WebSocket, cancellation, fallback, compression, model-cache, tool-loop, and extension-host smoke coverage, with architecture and live-backend findings documented under `docs/` ([#10](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/10)).

## [1.1.2](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.1.1...v1.1.2) (2026-07-17)

### Model metadata and compatibility

* Surface the known 372K raw context ceiling for exact GPT-5.6 Sol, Terra, and Luna models when using Codex access-token credentials on the canonical ChatGPT Codex backend, while keeping the authenticated remote `context_window` authoritative for VS Code input limits ([#15](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/15)).
* Isolate discovered-model caches by credential kind and add regression coverage for account-specific context rollbacks, custom backends, API-key credentials, unrelated model names, and future remote context increases ([#15](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/15)).

### Remote development

* Run Codex For Copilot in the local VS Code UI extension host for Remote-SSH workspaces so it can use credentials stored on the local computer and avoid requiring a second remote installation ([#17](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/17)).

### CI and release automation

* Add pull-request CI for changed-file whitespace, TypeScript checks, extension compilation, and smoke tests with read-only permissions and superseded-run cancellation ([#16](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/16)).
* Adopt Release Please for semantic versioning, generated release pull requests, changelog updates, version tags, and GitHub Releases ([#18](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/18)).
* Replace long-lived Marketplace PAT publishing with GitHub OIDC and Microsoft Entra ID workload identity federation using `vsce --azure-credential` ([#18](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/18)).
* Add a Marketplace identity verification workflow, protected `marketplace` environment, exact-tag rebuilds, safe historical retries, VSIX asset uploads, and draft GitHub Releases that become public only after Marketplace publishing succeeds ([#18](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/18)).

### Bug fixes

* Allow Marketplace publishing identities to use tenant-scoped Entra login without Azure subscription access or Azure RBAC assignments ([#20](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/20)).
* Preserve the current GitHub Latest Release when manually retrying an older historical tag ([fc08b1f](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/fc08b1ff7957a1c8eafe8b304a3e5260afd8f679)).

## 1.1.1 (2026-07-14)

This version is the baseline for automated release management. Earlier releases were managed manually.
