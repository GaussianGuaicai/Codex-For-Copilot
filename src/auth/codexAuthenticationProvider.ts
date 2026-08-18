import * as vscode from 'vscode';
import { CODEX_OAUTH } from './codexOAuthCompatibility';
import { CodexAuthManager } from './codexAuthManager';
import type { CodexAuthChangeEvent, CodexCredentialSnapshot } from './codexAuthTypes';

export const CODEX_AUTHENTICATION_PROVIDER_ID = 'codex-for-copilot';

const supportedScopes = CODEX_OAUTH.scopes.split(' ');

export class CodexAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly sessionChanges = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private readonly authChangeSubscription: vscode.Disposable;
  /** Sessions as last reported to VS Code, keyed by session id. */
  private knownSessions = new Map<string, vscode.AuthenticationSession>();

  readonly onDidChangeSessions = this.sessionChanges.event;

  constructor(private readonly authManager: CodexAuthManager) {
    this.authChangeSubscription = authManager.onDidChangeAuth((event) => {
      void this.handleAuthenticationChange(event);
    });
  }

  async getSessions(scopes: readonly string[] | undefined, _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
    if (scopes && !supportsRequestedScopes(scopes)) {
      return [];
    }
    const sessions = await this.getAllSessions();
    this.knownSessions = new Map(sessions.map((session) => [session.id, session]));
    return sessions;
  }

  async createSession(scopes: readonly string[], _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
    if (!supportsRequestedScopes(scopes)) {
      throw new Error('Codex for Copilot does not support the requested authentication scopes.');
    }
    await this.authManager.signInWithBrowser();
    const sessions = await this.getAllSessions();
    const session = sessions.find((candidate) => !this.knownSessions.has(candidate.id)) ?? sessions.at(-1);
    if (!session) {
      throw new Error('ChatGPT sign-in completed without creating a credential session.');
    }
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.knownSessions.get(sessionId) ?? await this.findSessionById(sessionId);
    if (!session) {
      throw new Error('The requested Codex for Copilot authentication session does not exist.');
    }
    await this.authManager.signOut(session.account.id);
  }

  dispose(): void {
    this.authChangeSubscription.dispose();
    this.sessionChanges.dispose();
  }

  private async handleAuthenticationChange(_event: CodexAuthChangeEvent): Promise<void> {
    // Recompute the full session set and diff against what VS Code last saw.
    const previous = this.knownSessions;
    const nextSessions = await this.getAllSessions();
    const next = new Map(nextSessions.map((session) => [session.id, session]));
    this.knownSessions = next;

    const added = nextSessions.filter((session) => !previous.has(session.id));
    const removed = [...previous.values()].filter((session) => !next.has(session.id));
    const changed = nextSessions.filter((session) => {
      const prior = previous.get(session.id);
      return prior !== undefined && prior.accessToken !== session.accessToken;
    });

    if (added.length || removed.length || changed.length) {
      this.sessionChanges.fire({ added, removed, changed });
    }
  }

  private async findSessionById(sessionId: string): Promise<vscode.AuthenticationSession | undefined> {
    const sessions = await this.getAllSessions();
    return sessions.find((session) => session.id === sessionId);
  }

  private async getAllSessions(): Promise<vscode.AuthenticationSession[]> {
    const accounts = await this.authManager.listAccounts();
    const sessions: vscode.AuthenticationSession[] = [];
    for (const account of accounts) {
      try {
        const snapshot = await this.authManager.getCredentialSnapshot(account.accountKey);
        sessions.push(toAuthenticationSession(account, snapshot));
      } catch {
        // Skip accounts whose credentials can no longer be read.
      }
    }
    return sessions;
  }
}

function supportsRequestedScopes(scopes: readonly string[]): boolean {
  return scopes.every((scope) => supportedScopes.includes(scope));
}

function toAuthenticationSession(account: { accountKey: string; source: string; email?: string; accountId?: string }, snapshot: CodexCredentialSnapshot): vscode.AuthenticationSession {
  const label = account.email ?? account.accountId ?? 'ChatGPT';
  return {
    id: `${account.source}:${account.accountKey}`,
    accessToken: snapshot.accessToken,
    account: {
      id: account.accountKey,
      label
    },
    scopes: supportedScopes
  };
}