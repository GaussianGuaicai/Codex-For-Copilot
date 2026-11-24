import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { DeviceCodeRetryableError, type CodexOAuthClient, type OAuthTokens } from './codexOAuthClient';

export async function signInWithDeviceCode(client: CodexOAuthClient): Promise<OAuthTokens> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Sign in to ChatGPT with Device Code',
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () => controller.abort(new Error('Device Code sign-in was cancelled.'));
    const cancellation = token.onCancellationRequested(cancel);
    if (token.isCancellationRequested) cancel();
    let deadline: NodeJS.Timeout | undefined;
    try {
      signal.throwIfAborted();
      const device = await client.requestDeviceCode(signal);
      signal.throwIfAborted();
      deadline = setTimeout(() => controller.abort(new Error('Device Code sign-in timed out.')), 15 * 60_000);
      progress.report({ message: `Enter code ${device.user_code} at ${device.verification_uri}.` });
      void showVerificationActions(device.verification_uri, device.user_code, signal);

      let interval = Math.min(15 * 60, Math.max(1, device.interval)) * 1000;
      let consecutiveFailures = 0;
      while (true) {
        signal.throwIfAborted();
        let result;
        try {
          result = await client.pollDeviceCode(device.device_auth_id, device.user_code, signal);
          consecutiveFailures = 0;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof DeviceCodeRetryableError) || ++consecutiveFailures > 3) throw error;
          interval = Math.max(interval, 5000);
          await delay(Math.min(15 * 60_000, Math.max(interval * consecutiveFailures, error.retryAfterMs)), undefined, { signal });
          continue;
        }
        if (result.authorization_code && result.code_verifier) {
          signal.throwIfAborted();
          const exchangeSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
          const tokens = await client.exchangeAuthorizationCode(result.authorization_code, 'https://auth.openai.com/deviceauth/callback', result.code_verifier, exchangeSignal);
          exchangeSignal.throwIfAborted();
          return tokens;
        }
        await delay(interval, undefined, { signal });
      }
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
      cancellation.dispose();
      controller.abort();
    }
  });
}

async function showVerificationActions(uri: string, code: string, signal: AbortSignal): Promise<void> {
  try {
    const choice = await vscode.window.showInformationMessage(`Open ${uri} and enter code ${code}.`, 'Open verification page', 'Copy code');
    if (signal.aborted) return;
    if (choice === 'Open verification page') await vscode.env.openExternal(vscode.Uri.parse(uri));
    if (choice === 'Copy code') await vscode.env.clipboard.writeText(code);
  } catch {
    // The verification URL and code remain visible in the progress notification.
  }
}
