# Changelog

This changelog is maintained by Release Please from Conventional Commit titles merged into `master`.

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
* Add a Marketplace identity verification workflow, protected `marketplace` environment, exact-tag rebuilds, safe historical release retries, VSIX asset uploads, and draft GitHub Releases that become public only after Marketplace publishing succeeds ([#18](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/18)).

### Bug fixes

* Allow Marketplace publishing identities to use tenant-scoped Entra login without Azure subscription access or Azure RBAC assignments ([#20](https://github.com/GaussianGuaicai/Codex-For-Copilot/pull/20)).
* Preserve the current GitHub Latest Release when manually retrying an older historical tag ([fc08b1f](https://github.com/GaussianGuaicai/Codex-For-Copilot/commit/fc08b1ff7957a1c8eafe8b304a3e5260afd8f679)).

## 1.1.1 (2026-07-14)

This version is the baseline for automated release management. Earlier releases were managed manually.
