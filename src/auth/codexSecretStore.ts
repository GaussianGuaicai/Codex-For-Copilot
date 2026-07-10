import * as vscode from 'vscode';
import type { CodexAuthBundle } from './codexAuthTypes';

export const CODEX_AUTH_SECRET_KEY = 'codexForCopilot.codexAuthBundle';

export class CodexSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getAuthBundle(): Promise<CodexAuthBundle | undefined> {
    const raw = await this.secrets.get(CODEX_AUTH_SECRET_KEY);
    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as CodexAuthBundle;
    } catch {
      return undefined;
    }
  }

  async setAuthBundle(bundle: CodexAuthBundle): Promise<void> {
    await this.secrets.store(CODEX_AUTH_SECRET_KEY, JSON.stringify(bundle));
  }

  async deleteAuthBundle(): Promise<void> {
    await this.secrets.delete(CODEX_AUTH_SECRET_KEY);
  }
}
