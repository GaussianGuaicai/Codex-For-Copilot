# Codex

This extension contributes one VS Code language model provider named **Codex**. It discovers available models from the ChatGPT Codex backend, exposes them in the VS Code model picker, streams text deltas back into VS Code, and forwards VS Code function-style tools through the Responses API.

Every request includes the configured `codexModelProvider.instructions` value as the top-level Responses API `instructions` field.

Model discovery requests use `GET /models?client_version=...` against the normalized Codex backend root and fall back to the configured `codexModelProvider.model` when discovery is unavailable.

## Backend

The default endpoint setting is the ChatGPT Codex Responses URL:

```text
https://chatgpt.com/backend-api/codex/responses
```

The OpenAI Node SDK appends `/responses` internally, so the extension normalizes this configured URL to the API root before creating the SDK client. That prevents accidental `/responses/responses` requests while still exposing the exact backend URL in settings.

## Credentials

By default, the extension reads Codex credentials from:

```text
~/.codex/auth.json
```

It prefers Codex account tokens under `tokens.access_token`, and falls back to `OPENAI_API_KEY` only when no account token is available. When an account token includes `tokens.account_id`, the extension sends `ChatGPT-Account-ID` with the request.

When using Codex account tokens, the extension omits `max_output_tokens` because the ChatGPT Codex backend rejects that standard Responses API parameter.

You can add a fallback API key in VS Code SecretStorage by running:

```text
Codex: Set API Key
```

That stores the API key in VS Code SecretStorage under `codexModelProvider.apiKey`. API keys are never stored in `settings.json`.

You can control which credential source wins with `codexModelProvider.credentialsSource`.

The default request `User-Agent` is:

```text
local.codex-model-provider/0.0.1 Codex-Extension
```

## Settings

```json
{
  "codexModelProvider.baseURL": "https://chatgpt.com/backend-api/codex/responses",
  "codexModelProvider.clientVersion": "0.0.0",
  "codexModelProvider.credentialsSource": "auto",
  "codexModelProvider.model": "gpt-5.5",
  "codexModelProvider.instructions": "You are a helpful coding assistant integrated with VS Code.",
  "codexModelProvider.defaultReasoningEffort": "auto",
  "codexModelProvider.maxOutputTokens": 8192
}
```

## Model Picker

When model discovery succeeds, the provider surfaces the backend's `display_name`, `context_window`, and supported reasoning levels.

- The picker keeps one entry per upstream model instead of duplicating models by reasoning level.
- Supported reasoning levels are exposed through model metadata so VS Code can show a native Thinking Effort selector when that UI path is available.
- `codexModelProvider.defaultReasoningEffort` acts as the fallback when the chat UI does not send a Thinking Effort choice.

When discovery fails, the provider falls back to the configured `codexModelProvider.model` value and derives a readable name from that model ID.

## Tool Calling

When VS Code supplies `options.tools`, the extension now:

- serializes those tool definitions into Responses API `function` tools
- respects VS Code's tool mode (`auto` or `required`)
- emits `LanguageModelToolCallPart` values when the backend returns function calls
- preserves prior tool calls and tool results when VS Code sends the follow-up turn

Tool execution still happens in VS Code's caller flow. This provider bridges tool metadata and tool-call history to the backend; it does not directly run tools itself.

## What It Does Not Do

- It does not depend on `codex-responses-api-proxy`.
- It does not support image input, model discovery, webviews, or apply-patch/edit tools.
- It does not keep multi-turn state with `previous_response_id`.

## Development

```bash
npm install
npm run compile
npm run package:vsix
npm run test:smoke
npm run test:real-backend
```

Press F5 in VS Code to launch an Extension Development Host.

`npm run test:real-backend` uses the extension's real credential resolution path against the ChatGPT Codex backend. It expects `~/.codex/auth.json` to contain a valid ChatGPT Codex login and will use `HTTPS_PROXY` or `HTTP_PROXY` when present.

## Build A VSIX

Build the extension and package it into a local VSIX file:

```bash
npm install
npm run compile
npm run package:vsix
```

That produces a file like `codex-model-provider-0.0.1.vsix` in the repository root.

To install the packaged extension into VS Code locally:

```bash
code --install-extension .\codex-model-provider-0.0.1.vsix --force
```

If you only want to inspect the extension during development, you can still press F5 to launch an Extension Development Host without creating a VSIX.

## Troubleshooting

### Model Does Not Appear

Check that `~/.codex/auth.json` exists or run `Codex: Set API Key`. Also confirm the extension activated and VS Code is version 1.104.0 or newer.

### `Instructions are required`

Set `codexModelProvider.instructions` to a non-empty string. Instructions are sent as top-level `instructions`, not as a user message.

### Request Fails With 401

Check the stored API key, `~/.codex/auth.json`, and `codexModelProvider.baseURL`.

### Invalid Endpoint Or Connection Failure

Check `codexModelProvider.baseURL`. The default value is `https://chatgpt.com/backend-api/codex/responses`; if a URL ends with `/responses`, the client strips that suffix before the SDK appends its own `/responses` path.

### Stream Starts But No Text Appears

The MVP only forwards `response.output_text.delta` events. A model that returns only non-text output will not display text.

### Agent Mode Still Looks Wrong

Check that the chat participant actually provided `options.tools`, and that the selected backend model supports function calling on the configured endpoint. This provider forwards tool definitions and tool-call history, but it does not invent tools on its own.
