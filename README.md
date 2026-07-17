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
- Shows last-response usage in the status bar and supports account-limit refresh.

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

## Configuration

Common settings:

- `codexModelProvider.baseURL`: Codex backend URL, defaulting to `https://chatgpt.com/backend-api/codex/responses`
- `codexModelProvider.credentialsSource`: `auto`, `codexAuth`, or `secretStorage`. `auto` prefers the Codex auth manager, then the legacy `~/.codex/auth.json` fallback, then SecretStorage.
- `codexModelProvider.transport`: `auto`, `http`, or `websocket`. `auto` prefers WebSocket and falls back to HTTP only when the WebSocket transport is unavailable; API errors are returned directly.
- `codexModelProvider.websocketPrewarm`: `auto`, `enabled`, or `disabled`. `auto` skips speculative `generate:false` requests and relies on idle WebSocket preconnection; use `enabled` only when backend measurements show a benefit.
- `codexModelProvider.model`: fallback model when discovery fails
- `codexModelProvider.disabledModels`: model IDs to hide when the backend advertises a model that should not appear in the picker
- `codexModelProvider.modelAliases`: map stale or rejected model IDs to replacements, for example `{ "gpt-5.6-luna": "gpt-5.6-sol" }`
- `codexModelProvider.instructions`: top-level Responses API instructions sent with every request
- `codexModelProvider.defaultServiceTier`: default `service_tier` behavior
- `codexModelProvider.defaultReasoningEffort`: fallback Thinking Effort setting
- `codexModelProvider.maxOutputTokens`: maximum output tokens when supported

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

## Troubleshooting

- If the model does not appear, confirm credentials are present and VS Code is new enough.
- If you see `Instructions are required`, set `codexModelProvider.instructions` to a non-empty value.
- If requests fail with 401, check the imported Codex auth bundle, `~/.codex/auth.json` for legacy setups, the saved API key, and `codexModelProvider.baseURL`.
- If account limits do not show up, make sure you imported Codex auth credentials or have `~/.codex/auth.json` available; account usage only works with Codex access-token credentials.
- If the backend URL ends with `/responses`, the extension normalizes it before sending requests.
