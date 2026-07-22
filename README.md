# Codex For Copilot

[![Install from VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=Gaussian.gaussian-codex-for-copilot)

A lightweight VS Code language model provider for the ChatGPT Codex Responses backend.

It makes Codex appear in the VS Code model picker, discovers upstream models when available, streams responses back into chat, and forwards VS Code tool calls through the Responses API.

## Features

- Registers a `Codex` language model provider in VS Code.
- Discovers available models from the backend and falls back to the configured model when discovery is unavailable.
- Streams text, reasoning, and tool-call output over WebSocket or HTTP with matching behavior.
- Reuses WebSocket sessions and compatible Responses branches for efficient follow-up turns.
- Reads Codex credentials from the built-in Codex auth manager, with a legacy fallback to `~/.codex/auth.json`, or VS Code SecretStorage.
- Shows response-driven account usage in the status bar and supports account-limit refresh. When the backend supplies a complete workspace Credit budget, the status bar shows its remaining percentage and remaining/total Credits; otherwise it shows the returned rate-limit windows or a standalone Credit balance.

## Requirements

- VS Code 1.104.0 or newer.
- Either imported Codex credentials or an API key saved with `Codex: Set API Key`.

## Credentials

This extension only consumes credentials you already have. It does not sign you in to ChatGPT for you, and it cannot fetch Codex credentials from your ChatGPT account on its own.

Prepare credentials in one of these ways before using the extension:

- Import a valid `auth.json` with `Codex for Copilot: Import Codex auth.json`. The extension stores the Codex auth bundle in its credential manager, reads `tokens.access_token`, and also uses `tokens.account_id` when present.
- Or place a valid Codex login in `~/.codex/auth.json` for legacy compatibility.
- Or run `Codex: Set API Key` and store an API key in VS Code SecretStorage.

The `Codex for Copilot: Sign in with Device Code` command is currently only a placeholder. Device Code login is not implemented yet.

If more than one source is present, the extension uses the credential source selected by `codexModelProvider.credentialsSource`.

## Setup

Install the extension from the marketplace, or run it locally with:

```bash
npm install
npm run compile
```

Press F5 in VS Code to launch an Extension Development Host.

The extension also works when the current workspace is opened over Remote-SSH. It is intentionally run in the local UI extension host, so it uses the credentials already stored on your local computer. Do not install a second remote copy of the extension on the SSH host; after updating, run `Developer: Show Running Extensions` and confirm that `Codex For Copilot` is running locally.

## Configuration

Common settings:

- `codexModelProvider.baseURL`: Codex backend URL, defaulting to `https://chatgpt.com/backend-api/codex/responses`
- `codexModelProvider.credentialsSource`: `auto`, `codexAuth`, or `secretStorage`. `auto` prefers the Codex auth manager, then the legacy `~/.codex/auth.json` fallback, then SecretStorage.
- `codexModelProvider.transport`: `auto`, `http`, or `websocket`. `auto` prefers WebSocket and falls back to HTTP only when the WebSocket transport is unavailable; API errors are returned directly.
- `codexModelProvider.websocketPrewarm`: `auto`, `enabled`, or `disabled`. `auto` skips speculative `generate:false` requests and relies on idle WebSocket preconnection; use `enabled` only when backend measurements show a benefit.
- `codexModelProvider.model`: fallback model when discovery fails
- `codexModelProvider.includeHiddenModels`: opt in to callable models that the upstream catalog marks hidden; defaults to `false`
- `codexModelProvider.disabledModels`: real backend model slugs to hide when an advertised model should not appear in the picker; one slug hides all of its local profiles
- `codexModelProvider.modelAliases`: map stale or rejected real backend model slugs to replacements, for example `{ "gpt-5.6-luna": "gpt-5.6-sol" }`; one mapping applies to all local profiles
- `codexModelProvider.instructions`: top-level Responses API instructions sent with every request
- `codexModelProvider.defaultServiceTier`: default `service_tier` behavior
- `codexModelProvider.defaultReasoningEffort`: fallback Thinking Effort setting
- `codexModelProvider.maxOutputTokens`: maximum output tokens when supported

## Context-window profiles

Each picker profile keeps two local values: the backend's raw context window and the effective input budget advertised to VS Code as `maxInputTokens`. The effective budget is `floor(raw context window * effective_context_window_percent / 100)` when the catalog supplies a finite percentage greater than 0 and at most 100; otherwise it uses the Codex-compatible 95% fallback. This is separate from Codex's 90% auto-compaction threshold, which is not exposed as the request budget.

Standard entries use the catalog's active raw `context_window`. When supported and not already active, the picker also shows a separate **Long context** entry: GPT-5.4 at the discovered 1,000,000-token maximum, and GPT-5.6 Sol/Terra/Luna at the known 372,000-token ceiling for Codex access-token accounts on the canonical ChatGPT Codex backend. Synthetic GPT-5.6 372K entries include an `(Experimental)` parenthetical in their picker name and detail.

Profile suffixes such as `::context=1000000` are local picker IDs only. Standard and long entries send the same real backend model slug, with no context-window, profile, compaction, truncation, or summary field added to Responses requests. The extension does not alter caller-supplied history or perform provider-side compaction. A compatible standard-to-long follow-up may reuse the same Responses branch; a long-to-standard downgrade starts a new chain with the caller's full history because the exact retained branch usage is unavailable.

`codexModelProvider.includeHiddenModels` is a global, intentional visibility opt-in. When enabled, every otherwise structurally valid catalog row marked `hide` or `hidden` is eligible; this is not restricted to an allowlist. API-key credentials still exclude rows with `supported_in_api: false`, and the existing Auto Review visibility exception remains unchanged.

## Testing VS Code Chat integration

`code chat --mode agent` can open an Agent-mode chat, but the VS Code CLI does not select a language model. Use the model picker for manual Chat validation. For an automated provider boundary check, run `npm run test:extension-host`: it starts an isolated Extension Development Host, selects this extension through `vscode.lm.selectChatModels()`, and validates a complete tool-call/result loop. Eligible WebSocket tool-result loops use the validated incremental `previous_response_id` continuation path; HTTP tool results and incompatible WebSocket branches keep full replay as the compatibility fallback.

For tool-loop diagnosis, `Codex: Open Debug Logs` records only redacted timing and byte counts. In particular, `toolArgumentsDoneToReportedMs` measures the provider's delivery path, `responseCompletedToResultObservedMs` measures the interval after the provider response has completed until VS Code Chat returns a tool result, and `resultObservedToRequestSentMs` measures continuation dispatch. The middle interval belongs to VS Code's tool loop (including scheduling, confirmation, execution, and result delivery); it is not treated as extension transport latency or as a screen-paint timestamp.

## Commands

- `Codex: Manage`
- `Codex for Copilot: Import Codex auth.json`
- `Codex for Copilot: Show Auth Status`
- `Codex for Copilot: Sign Out`
- `Codex for Copilot: Sign in with Device Code` (planned, not implemented yet)
- `Codex: Set API Key`
- `Codex: Clear API Key`
- `Codex: Open Settings`
- `Codex: Open Debug Logs`
- `Codex: Refresh Account Limits`

## Development

```bash
npm run check
npm run compile
npm run test:smoke
npm run test:real-backend
npm run test:benchmark-provider
npm run package:vsix
```

`npm run test:smoke` runs self-contained checks for HTTP/WebSocket parity, transport fallback, provider model availability, conversation reuse, account usage, and authentication. `npm run test:real-backend` talks to the live Codex backend and expects valid Codex credentials. Set `CODEX_TEST_TRANSPORT=websocket` or `auto` to probe that transport, and set `CODEX_TEST_CONTINUATION=1` to include a follow-up request using `previous_response_id`. `CODEX_BENCHMARK_BACKEND=1 npm run test:benchmark-provider` measures the complete provider path; set `CODEX_BENCHMARK_ITERATIONS` to control sample count.

Release versioning, GitHub Release creation, and keyless Microsoft Entra ID Marketplace publishing are documented in [docs/releasing.md](docs/releasing.md).

## Troubleshooting

- If the model does not appear, confirm credentials are present and VS Code is new enough.
- If you see `Instructions are required`, set `codexModelProvider.instructions` to a non-empty value.
- If requests fail with 401, check the imported Codex auth bundle, `~/.codex/auth.json` for legacy setups, the saved API key, and `codexModelProvider.baseURL`.
- If account limits do not show up, make sure you imported Codex auth credentials or have `~/.codex/auth.json` available; account usage only works with Codex access-token credentials.
- If the backend URL ends with `/responses`, the extension normalizes it before sending requests.
