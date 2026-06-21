# Codex Model Provider

This extension contributes one VS Code language model provider named **Codex Model Provider**. It sends text-only VS Code Chat requests to the ChatGPT Codex Responses backend and streams text deltas back into VS Code.

Every request includes the configured `codexModelProvider.instructions` value as the top-level Responses API `instructions` field.

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
Codex Model Provider: Set API Key
```

That stores the API key in VS Code SecretStorage under `codexModelProvider.apiKey`. API keys are never stored in `settings.json`.

The default request `User-Agent` is:

```text
local.codex-model-provider/0.0.1 Codex-Extension
```

## Settings

```json
{
  "codexModelProvider.baseURL": "https://chatgpt.com/backend-api/codex/responses",
  "codexModelProvider.model": "gpt-5.5",
  "codexModelProvider.displayName": "GPT-5.5-Codex",
  "codexModelProvider.instructions": "You are a helpful coding assistant integrated with VS Code.",
  "codexModelProvider.maxInputTokens": 120000,
  "codexModelProvider.maxOutputTokens": 8192
}
```

## What It Does Not Do

- It does not depend on `codex-responses-api-proxy`.
- It advertises tool-call compatibility so VS Code can show it in the Chat model picker, but the MVP still only streams text and does not execute agent tools.
- It does not support image input, model discovery, webviews, or apply-patch/edit tools.
- It does not keep multi-turn state with `previous_response_id`.

## Development

```bash
npm install
npm run compile
npm run test:smoke
npm run test:real-backend
```

Press F5 in VS Code to launch an Extension Development Host.

`npm run test:real-backend` uses the extension's real credential resolution path against the ChatGPT Codex backend. It expects `~/.codex/auth.json` to contain a valid ChatGPT Codex login and will use `HTTPS_PROXY` or `HTTP_PROXY` when present.

## Troubleshooting

### Model Does Not Appear

Check that `~/.codex/auth.json` exists or run `Codex Model Provider: Set API Key`. Also confirm the extension activated and VS Code is version 1.104.0 or newer.

### `Instructions are required`

Set `codexModelProvider.instructions` to a non-empty string. Instructions are sent as top-level `instructions`, not as a user message.

### Request Fails With 401

Check the stored API key, `~/.codex/auth.json`, and `codexModelProvider.baseURL`.

### Invalid Endpoint Or Connection Failure

Check `codexModelProvider.baseURL`. The default value is `https://chatgpt.com/backend-api/codex/responses`; if a URL ends with `/responses`, the client strips that suffix before the SDK appends its own `/responses` path.

### Stream Starts But No Text Appears

The MVP only forwards `response.output_text.delta` events. A model that returns only non-text output will not display text.

### Agent Mode Does Not Work

Tool execution is not implemented in the MVP. The model is visible in the Chat picker, but tool calls are ignored by the text-only Responses path.
