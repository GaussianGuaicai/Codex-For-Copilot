# Codex For Copilot

[![Install from VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=Gaussian.gaussian-codex-for-copilot)

A lightweight VS Code language model provider for the ChatGPT Codex Responses backend.

It makes Codex appear in the VS Code model picker, discovers upstream models when available, streams responses back into chat, and forwards VS Code tool calls through the Responses API.

## Features

- Registers a `Codex` language model provider in VS Code.
- Discovers available models from the backend and falls back to the configured model when discovery is unavailable.
- Streams text, reasoning, and tool-call output back to VS Code.
- Reads credentials from `~/.codex/auth.json` or VS Code SecretStorage.
- Shows last-response usage in the status bar and supports account-limit refresh.

## Requirements

- VS Code 1.104.0 or newer.
- Either a valid Codex login in `~/.codex/auth.json` or an API key saved with `Codex: Set API Key`.

## Credentials

This extension only consumes credentials you already have. It does not sign you in to ChatGPT, and it cannot fetch Codex credentials from your ChatGPT account for you.

Prepare credentials in one of these ways before using the extension:

- Place a valid Codex login in `~/.codex/auth.json`. The extension prefers `tokens.access_token`, and also uses `tokens.account_id` when present.
- Or run `Codex: Set API Key` and store an API key in VS Code SecretStorage.

If both are present, the extension uses the credential source selected by `codexModelProvider.credentialsSource`.

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
- `codexModelProvider.credentialsSource`: `auto`, `codexAuth`, or `secretStorage`
- `codexModelProvider.model`: fallback model when discovery fails
- `codexModelProvider.instructions`: top-level Responses API instructions sent with every request
- `codexModelProvider.defaultServiceTier`: default `service_tier` behavior
- `codexModelProvider.defaultReasoningEffort`: fallback Thinking Effort setting
- `codexModelProvider.maxOutputTokens`: maximum output tokens when supported
- `codexModelProvider.showUsageInStatusBar`: show the last completed usage summary

## Commands

- `Codex: Manage`
- `Codex: Set API Key`
- `Codex: Clear API Key`
- `Codex: Open Settings`
- `Codex: Open Debug Logs`
- `Codex: View Last Usage`
- `Codex: Refresh Account Limits`

## Development

```bash
npm run check
npm run compile
npm run test:smoke
npm run test:real-backend
npm run package:vsix
```

`npm run test:smoke` runs the local mock-based client checks. `npm run test:real-backend` talks to the live Codex backend and expects valid Codex credentials.

## Troubleshooting

- If the model does not appear, confirm credentials are present and VS Code is new enough.
- If you see `Instructions are required`, set `codexModelProvider.instructions` to a non-empty value.
- If requests fail with 401, check `~/.codex/auth.json`, the saved API key, and `codexModelProvider.baseURL`.
- If the backend URL ends with `/responses`, the extension normalizes it before sending requests.
