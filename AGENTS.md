# Repository Guidelines

## Project Structure & Module Organization

The extension source lives in [`src/`](src/). Key modules are:
- `config.ts`: reads and normalizes extension settings
- `convertMessages.ts`: adapts VS Code chat messages into Responses input and compares conversation history
- `extension.ts`: VS Code activation and command registration
- `models.ts`: model discovery and provider metadata
- `provider.ts`: language model provider surface and runtime model availability
- `responseBranchStore.ts`: compatible `previous_response_id` branch reuse
- `responsesClient.ts`: shared Responses request builder plus HTTP/WebSocket streaming transport facade
- `secrets.ts`: credential selection across the Codex auth manager, `~/.codex/auth.json`, and SecretStorage
- `auth/`: imported Codex credential storage, refresh, locking, JWT parsing, and request authentication

Compiled output is written to `out/` and should be treated as build artifacts. Tests live in `test/`. Workspace debug helpers are in `.vscode/`.

Transport-related constraints that must not break:
- `codexModelProvider.transport` defaults to `auto`, which means WebSocket-first with HTTP fallback.
- HTTP and WebSocket transports must emit the same provider-facing callbacks for text, reasoning, tool calls, completion, and failure.
- ChatGPT/Codex custom headers for WebSocket requests are passed via the WebSocket constructor options, not via OpenAI client `defaultHeaders`.
- The runtime now depends on the `ws` package because `openai/resources/responses/ws` requires it outside the SDK bundle.
- `auto` fallback is limited to transport availability failures. Structured WebSocket API errors must be surfaced without an HTTP retry.
- WebSocket sessions may be reused, but concurrent requests must never share an in-use socket.
- Responses branch reuse requires append-only history and an identical request envelope. Model, instructions, tool definitions, or tool schema changes must bust reuse.

Account-usage constraints that must not break:

- Compact account-usage display is driven by fields returned from the usage endpoint, not by guessed plan names or fixed window assumptions.
- A complete workspace Credit budget takes compact-display precedence; unselected Credit budgets and rate-limit windows remain available in the details tooltip.
- `rate_limit_reset_credits` is a reset-credit count, not a workspace Credit balance or budget.

## Build, Test, and Development Commands

- `npm install`: install dependencies
- `npm run check`: run TypeScript type-checking only
- `npm run compile`: type-check and bundle `src/extension.ts` into `out/extension.js`
- `npm run test:smoke`: verify request shape and streaming against a local mock server
- `npm run test:real-backend`: verify the extension request path against the ChatGPT Codex backend using local auth. Set `CODEX_TEST_MODEL` and `CODEX_TEST_SERVICE_TIER` to probe a single model or service tier.
- For transport probes, set `CODEX_TEST_TRANSPORT` to `http`, `websocket`, or `auto`; set `CODEX_TEST_CONTINUATION=1` to exercise `previous_response_id` continuation.

For interactive extension debugging, press `F5` in VS Code and launch the Extension Development Host using `.vscode/launch.json`.

## Coding Style & Naming Conventions

Use TypeScript with 2-space indentation, semicolons, and single quotes, matching the existing codebase. Prefer small focused modules over large utility files. Use `camelCase` for variables and functions, `PascalCase` for classes, and descriptive filenames such as `responsesClient.ts`.

There is no formatter or linter configured here, so keep edits stylistically consistent with neighboring files and run `npm run check` before submitting.

## Testing Guidelines

Add focused tests under `test/` when changing request construction, credential resolution, or VS Code integration points. Name tests by behavior, not implementation detail. Keep mock-based checks in the smoke tests and reserve `test:real-backend` for flows that truly need live backend validation.
For service tier changes, prefer a single real-backend probe with `CODEX_TEST_MODEL` and `CODEX_TEST_SERVICE_TIER` instead of broad runs.

## VS Code AI References

Relevant VS Code AI extension documentation for this repository:
- AI extensibility overview: https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview
- Language Model API guide: https://code.visualstudio.com/api/extension-guides/ai/language-model
- Chat Participant API guide: https://code.visualstudio.com/api/extension-guides/ai/chat
- Language Model Tool API guide: https://code.visualstudio.com/api/extension-guides/ai/tools
- MCP extension guide: https://code.visualstudio.com/api/extension-guides/ai/mcp
- VS Code LM API reference: https://code.visualstudio.com/api/references/vscode-api#lm
- LanguageModelChatProvider reference: https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatProvider
- LanguageModelChatInformation reference: https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatInformation

Current platform limitation:
- VS Code's Chat context usage widget is driven by internal `response.usage` data, not only by `maxInputTokens` or `provideTokenCount`.
- The stable `LanguageModelChatProvider` API currently lets third-party providers stream text, tool calls, thinking, and data parts, but it does not expose a stable way to report `response.usage` back to that widget.
- Because of that, this extension can expose context limits and token-count estimation, but it cannot force the built-in "Context Window used" ring/percentage to appear until VS Code exposes usage reporting for custom language model providers.

## Commit & Pull Request Guidelines

Current history uses short imperative commit messages, for example: `Add Codex Model Provider VS Code extension`. Follow that pattern.

PRs should include:
- a brief summary of user-visible behavior changes
- the commands you ran (`npm run check`, `npm run test:smoke`, etc.)
- screenshots only when UI or model-picker behavior changes

Releases are built by `.github/workflows/release.yml`. Keep `package.json` and `package-lock.json` versions aligned, merge the version bump to `master`, then push a matching `v<version>` tag. The workflow checks, compiles, runs smoke tests, packages the VSIX, creates the GitHub Release, and publishes to the VS Code Marketplace.

## Security & Configuration Tips

Do not commit `~/.codex/auth.json`, API keys, or temporary VSIX artifacts. Prefer account-token auth from the local Codex config. Keep the default backend URL aligned with `https://chatgpt.com/backend-api/codex/responses`.
