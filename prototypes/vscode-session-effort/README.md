# Native session-scoped Thinking Effort prototype

This is an experimental VS Code + bundled Copilot patch and its Codex For Copilot consumer. It is not an existing Microsoft API and has not been accepted upstream. Installing only the normal extension in stock VS Code retains request-boundary confirmation; it cannot display an immediate native-picker notification.

## Build and try

1. Check out `microsoft/vscode` at `ff05b50d4efafeaa0c1e025b13b7c1c5b196bc9f` (the tested source baseline, Code OSS 1.144.0).
2. Apply the zero-context `bridge.patch` from this directory with `git apply --unidiff-zero --check /path/to/bridge.patch`, then `git apply --unidiff-zero /path/to/bridge.patch`.
3. Build the patched editor **and bundled Copilot extension** using that repository's development instructions. The Copilot change attaches the actual ChatRequest resource and ID to ordinary Agent-loop model calls. Updating only the core editor is insufficient.
4. In Codex For Copilot, run `npm run prepare:session-effort-prototype`. This builds an isolated development extension under `work/session-effort-extension` and adds `enabledApiProposals: ["chatProvider"]` to that generated manifest only. The production manifest remains unchanged.
5. Launch the patched editor with `--extensionDevelopmentPath=/absolute/path/to/Codex-For-Copilot/work/session-effort-extension --enable-proposed-api Gaussian.codex-for-copilot`. Authenticate the editor's bundled Copilot normally. Use its ordinary Agent surface and select a Codex model directly.
6. Start two Agent conversations using the same model. While A streams or waits for a tool, change A's native Thinking Effort. Confirm **Apply to Current Task**. Verify one immediate notification, no session picker, an uninterrupted current response, and a configuration update only on A's next model request. B must remain unchanged.

Do not publish the generated proposed-API development extension as a production VSIX. The patch's API spelling and contract are prototype proposals and may need revision for upstream review.

## Routing and consent

The native per-editor store's explicit-selection event supplies the bound input-model session resource. It does not observe global configuration files, selected tabs, active editors, profile databases, or timestamps. Restore/sync/schema events do not use this event path.

The built-in Copilot participant supplies `chatRequest: { sessionResource, requestId }` for its ordinary Agent tool loop. Core accepts the association only when the caller is the configured built-in participant, the identified task is still active, and the session's selected model matches the target provider model. Supplied provider-context fields are stripped and rebuilt by core. Utility calls and subagents omit the association.

Core maintains a revisioned, content-free association until the whole Agent task ends, including the interval between individual model calls. Model changes, session disposal, cancellation/completion, and replacement tasks retire the association. It delivers opaque session/task IDs, effort, revision and lifecycle to the owning Provider, guarded by the `chatProvider` proposal. No conversation resource path or content is sent in the event.

The Codex consumer asks immediately and stores only per-task consent. Unanswered, dismissed, or future-only choices preserve the running task's effort. Late confirmations cannot overwrite a later selection or a closed/replaced task. Subsequent model calls retain confirmed consent even if Copilot still supplies old request options. Request baselines and canonical replay remain owned by the existing Branch Store; verified native session IDs also partition branch reuse, including for identical transcripts.

Prototype scope: the ordinary bundled Copilot Agent loop with a directly selected model. Auto routing, third-party participants, custom session providers, and subagents deliberately retain legacy behavior unless they receive their own verified association. The patch does not change native picker persistence or other conversations' active effort. **Future Tasks Only** keeps the native picker's existing behavior for future tasks; it does not rewrite other conversations.

## Validation and limits

Executed on the pinned VS Code source:

- The tracker suite: 3 passing tests for A/B identity isolation, stale configuration on tool continuations, model changes and task completion.
- The MainThreadLanguageModels suite: 7 passing tests including a native selection during a pending model request and changes while waiting for tools.
- The ExtHostLanguageModels suite: 11 passing tests, including opted-in provider delivery and no callback for a provider without the proposal.
- Targeted ESLint passed for the new tracker and modified main-thread/extension-host implementation.

These tests were bundled individually with esbuild and executed with Mocha (`--ui=tdd`), without starting Electron. A full `npm run typecheck-client` was attempted but the process was killed by the workspace memory limit. A full editor/Copilot build and an interactive native-picker run have **not** been validated. Do not interpret the passing mock/bridge tests as verification of the complete graphical editor flow or all platform variants.

In the extension, `npm run test:reasoning-effort` exercises immediate notification while an HTTP response is deliberately held open, no response restart, A/B isolation, stale options, future-only and out-of-order confirmations, ended tasks, and unpatched-host fallback. `npm run test:smoke` includes the consent-state and provider integration tests.
