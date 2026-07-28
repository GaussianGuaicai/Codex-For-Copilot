import * as vscode from 'vscode';
import type { CodexOAuthClient, OAuthTokens } from './codexOAuthClient';

export async function signInWithDeviceCode(client: CodexOAuthClient): Promise<OAuthTokens> {
  const device = await client.requestDeviceCode();
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `ChatGPT code: ${device.user_code}`, cancellable: true }, async (_progress, token) => {
    const choice = await vscode.window.showInformationMessage(`Open ${device.verification_uri} and enter code ${device.user_code}.`, 'Open verification page', 'Copy code');
    if (choice === 'Open verification page') await vscode.env.openExternal(vscode.Uri.parse(device.verification_uri));
    if (choice === 'Copy code') await vscode.env.clipboard.writeText(device.user_code);
    const deadline = Date.now() + 15 * 60_000; const interval = Math.max(1, device.interval ?? 5) * 1000;
    while (!token.isCancellationRequested && Date.now() < deadline) { const result = await client.pollDeviceCode(device.device_auth_id, device.user_code); if (result.authorization_code && result.code_verifier) return client.exchangeAuthorizationCode(result.authorization_code, 'https://auth.openai.com/deviceauth/callback', result.code_verifier); await delay(interval); }
    throw new Error(token.isCancellationRequested ? 'Device Code sign-in was cancelled.' : 'Device Code sign-in timed out.');
  });
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
