<div align="center">
  <img src="assets/codex-for-copilot.png" alt="Codex For Copilot logo" width="128" height="128">

  <h1>Codex For Copilot</h1>

  <p><strong>Use your Codex models directly inside VS Code Chat and Agent mode.</strong></p>

  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=Gaussian.gaussian-codex-for-copilot">
      <img src="https://img.shields.io/badge/Install_from-VS_Code_Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install from VS Code Marketplace">
    </a>
  </p>
</div>

Codex For Copilot is a lightweight VS Code Language Model Provider that connects VS Code Chat to the ChatGPT Codex Responses backend. Select **Codex** from the model picker and keep the native VS Code experience for chat, tools, confirmations, workspace trust, and extensions.

## Highlights

- **Native VS Code integration** — works in Chat and Agent mode through the standard model picker.
- **Automatic model discovery** — exposes available upstream Codex models with configurable fallbacks.
- **Fast streaming transport** — supports reusable WebSocket sessions with HTTP fallback.
- **VS Code tool support** — forwards built-in, extension, and MCP tool calls through the Responses API.
- **Conversation continuity** — reuses compatible response branches for efficient follow-up turns.
- **Usage visibility** — shows available account limits or Credits in the status bar when supplied by the backend.

## Get started

### 1. Install

Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Gaussian.gaussian-codex-for-copilot).

### 2. Add credentials

Open the Command Palette and choose one of the following:

- **`Codex for Copilot: Sign in with ChatGPT`** for the normal browser-based login flow.
- **`Codex for Copilot: Sign in with Device Code`** when a loopback browser callback is unavailable.
- **`Codex for Copilot: Import Codex auth.json`** only for a read-only legacy credential snapshot.
- **`Codex: Set API Key`** to store an API key in VS Code SecretStorage.

The extension stores its own ChatGPT credentials in VS Code SecretStorage and refreshes them automatically. The legacy `~/.codex/auth.json` fallback is never modified, refreshed, or revoked.

### 3. Select Codex

Open VS Code Chat, choose **Codex** from the model picker, and start chatting or using Agent mode.

## Requirements

- VS Code 1.104.0 or newer.
- A ChatGPT sign-in, legacy Codex credential snapshot, or API key.

## Common commands

- `Codex: Manage`
- `Codex: Open Settings`
- `Codex: Open Logs`
- `Codex: Refresh Account Limits`
- `Codex for Copilot: Sign in with ChatGPT`
- `Codex for Copilot: Sign in with Device Code`
- `Codex for Copilot: Import Codex auth.json`
- `Codex for Copilot: Show Auth Status`
- `Codex for Copilot: Sign Out`

## Diagnostics and privacy

Use **Codex: Open Logs** to view the extension's structured VS Code log channel. Each model request, authentication flow, model discovery operation, and account-limit refresh receives an `operationId`; search for that value to follow one operation through retries, WebSocket fallback, and completion.

The channel follows VS Code's native log level. Use **Developer: Set Log Level...** and select the Codex channel to enable Debug or Trace detail when investigating a problem.

Logs never include prompt or instruction text, reasoning, tool arguments/results, credentials, cookies, or Turn State. They retain only safe counts, sizes, hashes, identifiers hashed for correlation, transport decisions, and redacted error metadata.

## Configuration

Most users can keep the defaults. Advanced settings are available under **Settings → Extensions → Codex**, including:

- credential source
- backend URL
- HTTP or WebSocket transport
- fallback model and model visibility
- reasoning effort and service tier
- request compression and WebSocket prewarming

For a proxy-required network, set VS Code's `http.proxy` setting or the Extension Host's `HTTPS_PROXY`/`HTTP_PROXY` environment variable. The provider applies that proxy consistently to model discovery, account usage, HTTP Responses requests, token counting, and WebSocket requests; `NO_PROXY` remains honored.

## Develop locally

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

Useful checks:

```bash
npm run check
npm run test:smoke
npm run test:extension-host
npm run package:vsix
```

Release and Marketplace publishing details are documented in [docs/releasing.md](docs/releasing.md).

## Remote-SSH

The extension runs in the local UI extension host so it can use credentials stored on your computer. When working over Remote-SSH, keep the extension installed locally rather than installing a second copy on the remote host.

## License

[MIT](LICENSE)
