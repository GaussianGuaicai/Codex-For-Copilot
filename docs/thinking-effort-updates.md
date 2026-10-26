# Thinking Effort updates

The native VS Code Thinking Effort picker and its configuration schema are unchanged.
When VS Code supplies a different selection on the next provider request for a locally
verified conversation, Codex asks **Apply to Current Task** or **Future Tasks Only**.
Dismissal also preserves the current task's effort. A deferred choice is remembered
in the existing continuation snapshot, so tool steps do not repeatedly prompt.
No active response is cancelled, restarted, or modified.

## Public VS Code API limitation

Checked on 2026-10-26 against `@types/vscode` 1.125.0 and the public
[`LanguageModelChatProvider` declarations](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts).
The public provider surface exposes request options, but no event for native Thinking
Effort selection changes, no active Agent task configuration accessor, and no task
lifecycle notification for this purpose. `lm.onDidChangeChatModels` describes changes
to available models; `workspace.onDidChangeConfiguration` does not expose the native
per-chat picker selection.

Consequently this is **request-boundary compatibility, not full live hot-switch
support**. The confirmation can appear only when a subsequent provider invocation
reliably supplies updated options (or resolves an updated fallback setting). If VS Code
continues sending the old options during an Agent loop, the extension cannot detect
the new picker selection. It does not use private APIs, polling, or mutate options
belonging to an in-flight request. Provider-visible conversation continuity is used
because the public provider API does not expose the Agent task's identity.

## Protocol and state

The design follows
[`openai/codex@970111f`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/reasoning_effort.rs):

- Only upstream `supports_reasoning_effort_updates: true` enables durable updates,
  and only on the enabled Codex compatibility path. Missing/false metadata, unknown
  custom efforts, and a cold direct model selection without catalog metadata use
  ordinary `reasoning.effort`; no model-name heuristic enables this feature.
- For supported models, the first selected effort establishes the request baseline
  and a `configuration_update` input item. Later confirmed selections append another
  item while preserving the entire request-level reasoning object, including its
  summary behavior when switching to or from `none`.
- The existing Branch Store owns selection state and canonical history. Only local
  snapshots supply configuration items; text in user messages and model output do
  not establish trusted selection state. There is no second session registry.
- An effort-only branch lookup locates the conversation for confirmation. The final
  request must still have the original exact envelope fingerprint to reuse
  `previous_response_id`. Tools, instructions, identity, model, and other request
  changes retain their existing invalidation rules.
- Unsupported models use the confirmed ordinary request parameter and full canonical
  replay when it changes. HTTP and WebSocket requests use the existing shared builder.
- Tool continuations and continuation recovery retain ordered configuration items,
  function calls, and results. Retries reuse the prepared request; successful responses
  commit state, while failed/cancelled requests do not replace the last good snapshot.
- Full VS Code transcript replay matches the local transcript without treating
  extension-injected configuration items as user messages, then restores canonical
  history for transmission. A history replacement that cannot prove append-only
  continuity establishes a fresh baseline. VS Code owns compaction: there is no
  public compaction-success notification or provider-owned compaction endpoint here.
  Rejected local markers keep the existing explicit local recovery error instead of
  guessing discarded state. State does not persist across extension-host restarts.

This preserves request and prompt-prefix compatibility; it does not guarantee backend
cache hits or a particular latency improvement.

## Validation

Run `npm run test:reasoning-effort` for local HTTP/WebSocket coverage of confirmation,
future-only choices, transitions through `none`, stable request reasoning, ordered
history replay, continuation recovery, tool results, concurrent sessions, context
replacement, and in-flight request isolation. Capability parsing also checks missing,
false, and malformed metadata. The tests require loopback server access and no real
Codex credentials. Live backend cache-hit measurements and an interactive native
picker change during an Agent task have not been verified.

## Experimental native-session bridge

An implementation prototype is available in [prototypes/vscode-session-effort](../prototypes/vscode-session-effort/README.md), including an applicable VS Code/bundled-Copilot patch and an isolated development-extension preparation command. In the patched host it can ask immediately from the originating native picker event and apply consent only to that Agent task. It never infers the source from a configuration file or active panel and never offers a list of candidate sessions.

The normal extension manifest does not enable proposed APIs. Stock VS Code retains the request-boundary behavior described above. The experimental contract, validation performed, and unverified full-editor build are documented with the patch; this does not claim immediate native-picker support in released VS Code.
