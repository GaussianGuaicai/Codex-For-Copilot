import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** A webview's file input runs on the client even when the extension runs remotely. */
export function pickLocalAuthJson(): Promise<string | undefined> {
  const nonce = randomBytes(16).toString('hex');
  const panel = vscode.window.createWebviewPanel('codexLocalAuthFile', 'Import Local Codex auth.json', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: []
  });
  return new Promise((resolve) => {
    const disposed = panel.onDidDispose(() => {
      messages.dispose();
      disposed.dispose();
      resolve(undefined);
    });
    const messages = panel.webview.onDidReceiveMessage((message) => {
      if (message?.type !== 'import' || typeof message.raw !== 'string') return;
      resolve(message.raw);
      panel.dispose();
    });
    panel.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'">
  <title>Import Local Codex auth.json</title>
</head>
<body>
  <h1>Import Local Codex auth.json</h1>
  <label for="credentials">Choose an exported auth.json from this computer</label>
  <input id="credentials" type="file" accept=".json,application/json">
  <p id="status" role="status"></p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('credentials');
    const status = document.getElementById('status');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      input.disabled = true;
      try {
        vscode.postMessage({ type: 'import', raw: await file.text() });
      } catch {
        status.textContent = 'The selected file could not be read. Choose it again or select another file.';
        input.value = '';
        input.disabled = false;
      }
    });
  </script>
</body>
</html>`;
  });
}
