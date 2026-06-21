import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

export const API_KEY_SECRET = 'codexModelProvider.apiKey';
export const DEFAULT_USER_AGENT = 'local.codex-model-provider/0.0.1 Codex-Extension';

export interface ApiCredentials {
  apiKey: string;
  headers: Record<string, string>;
  source: 'secretStorage' | 'codexAuth';
  omitMaxOutputTokens: boolean;
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return (await getApiCredentials(context))?.apiKey;
}

export async function getApiCredentials(context: vscode.ExtensionContext): Promise<ApiCredentials | undefined> {
  const codexCredentials = await readCodexAuthCredentials();
  if (codexCredentials) {
    return codexCredentials;
  }

  const stored = await context.secrets.get(API_KEY_SECRET);
  if (stored?.trim()) {
    return {
      apiKey: stored.trim(),
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      source: 'secretStorage',
      omitMaxOutputTokens: false
    };
  }

  return undefined;
}

export async function setApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
  await context.secrets.store(API_KEY_SECRET, apiKey);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
}

async function readCodexAuthCredentials(): Promise<ApiCredentials | undefined> {
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
        omitMaxOutputTokens: true
      };
    }

    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
      return {
        apiKey: auth.OPENAI_API_KEY.trim(),
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
        source: 'codexAuth',
        omitMaxOutputTokens: false
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}
