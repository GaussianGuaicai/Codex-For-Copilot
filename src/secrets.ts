import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CodexAuthManager } from './auth/codexAuthManager';

export const API_KEY_SECRET = 'codexModelProvider.apiKey';
export const DEFAULT_USER_AGENT = 'local.codex-for-copilot/1.0.1 Codex-Extension';

export interface ApiCredentials {
  apiKey: string;
  headers: Record<string, string>;
  source: 'secretStorage' | 'codexAuth';
  authManager?: CodexAuthManager;
  kind: 'codexAccessToken' | 'openaiApiKey';
  omitMaxOutputTokens: boolean;
}

export async function getApiKey(context: vscode.ExtensionContext, authManager?: CodexAuthManager): Promise<string | undefined> {
  return (await getApiCredentials(context, authManager))?.apiKey;
}

export async function getApiCredentials(context: vscode.ExtensionContext, authManager?: CodexAuthManager): Promise<ApiCredentials | undefined> {
  const credentialSource = vscode.workspace.getConfiguration('codexModelProvider').get<'auto' | 'codexAuth' | 'secretStorage'>('credentialsSource', 'auto');

  if (credentialSource === 'secretStorage') {
    return readSecretStorageCredentials(context);
  }

  if (credentialSource === 'codexAuth') {
    return readCodexAuthCredentials(authManager);
  }

  const codexCredentials = await readCodexAuthCredentials(authManager);
  if (codexCredentials) {
    return codexCredentials;
  }

  return readSecretStorageCredentials(context);
}

export async function setApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
  await context.secrets.store(API_KEY_SECRET, apiKey);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
}

async function readCodexAuthCredentials(authManager?: CodexAuthManager): Promise<ApiCredentials | undefined> {
  if (authManager) {
    try {
      const status = await authManager.getStatus();
      const accessToken = await authManager.getAccessToken();
      const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
      if (status.accountId?.trim()) {
        headers['ChatGPT-Account-ID'] = status.accountId.trim();
      }
      return {
        apiKey: accessToken,
        headers,
        source: 'codexAuth',
        authManager,
        kind: 'codexAccessToken',
        omitMaxOutputTokens: true
      };
    } catch {
      // Fall through to legacy file-based discovery for backwards compatibility.
    }
  }

  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    const raw = await readFile(authPath, 'utf8');
    const auth = JSON.parse(raw) as {
      OPENAI_API_KEY?: unknown;
      tokens?: {
        access_token?: unknown;
        account_id?: unknown;
      };
    };

    if (typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token.trim()) {
      const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
      if (typeof auth.tokens.account_id === 'string' && auth.tokens.account_id.trim()) {
        headers['ChatGPT-Account-ID'] = auth.tokens.account_id.trim();
      }

      return {
        apiKey: auth.tokens.access_token.trim(),
        headers,
        source: 'codexAuth',
        kind: 'codexAccessToken',
        omitMaxOutputTokens: true
      };
    }

    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
      return {
        apiKey: auth.OPENAI_API_KEY.trim(),
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
        source: 'codexAuth',
        kind: 'openaiApiKey',
        omitMaxOutputTokens: false
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function readSecretStorageCredentials(context: vscode.ExtensionContext): Promise<ApiCredentials | undefined> {
  const stored = await context.secrets.get(API_KEY_SECRET);
  if (stored?.trim()) {
    return {
      apiKey: stored.trim(),
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      source: 'secretStorage',
      kind: 'openaiApiKey',
      omitMaxOutputTokens: false
    };
  }

  return undefined;
}
