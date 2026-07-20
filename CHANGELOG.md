# Changelog

This changelog is maintained by Release Please from Conventional Commit titles merged into `master`.

## [1.2.1](https://github.com/GaussianGuaicai/Codex-For-Copilot/compare/v1.2.0...v1.2.1) (2026-07-20)


### Bug Fixes

* match IPv6 no_proxy hosts ([47f7856](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/47f78567b5dae52259aa9d45640ad15affd8aeda))
* match IPv6 no_proxy hosts ([8edd2ad](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/8edd2adb9540b4b06a3f895df6826fa111746aa3))

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
