import * as vscode from 'vscode';
import { CODEX_OAUTH } from './codexOAuthCompatibility';
import { CodexAuthManager } from './codexAuthManager';
import type { CodexAuthChangeEvent, CodexAuthStatus, CodexCredentialSnapshot } from './codexAuthTypes';

export const CODEX_AUTHENTICATION_PROVIDER_ID = 'codex-for-copilot';

const supportedScopes = CODEX_OAUTH.scopes.split(' ');

export class CodexAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly sessionChanges = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private readonly authChangeSubscription: vscode.Disposable;
  private currentSession: vscode.AuthenticationSession | undefined;

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
    const session = await this.getCurrentSession();
    this.currentSession = session;
    return session ? [session] : [];
  }

  async createSession(scopes: readonly string[], _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
    if (!supportsRequestedScopes(scopes)) {
      throw new Error('Codex for Copilot does not support the requested authentication scopes.');
    }
    await this.authManager.signInWithBrowser();
    const session = await this.getCurrentSession();
    if (!session) {
      throw new Error('ChatGPT sign-in completed without creating a credential session.');
    }
    this.currentSession = session;
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = await this.getCurrentSession();
    if (!session || session.id !== sessionId) {
      throw new Error('The requested Codex for Copilot authentication session does not exist.');
    }
    await this.authManager.signOut();
  }

  dispose(): void {
    this.authChangeSubscription.dispose();
    this.sessionChanges.dispose();
  }

  private async handleAuthenticationChange(event: CodexAuthChangeEvent): Promise<void> {
    const previousSession = this.currentSession;
    const nextSession = event.reason === 'signedOut' || event.reason === 'reauthRequired'
      ? undefined
      : await this.getCurrentSession();
    this.currentSession = nextSession;

    if (!previousSession && nextSession) {
      this.sessionChanges.fire({ added: [nextSession], removed: [], changed: [] });
    } else if (previousSession && !nextSession) {
      this.sessionChanges.fire({ added: [], removed: [previousSession], changed: [] });
    } else if (previousSession && nextSession) {
      if (previousSession.id === nextSession.id) {
        this.sessionChanges.fire({ added: [], removed: [], changed: [nextSession] });
      } else {
        this.sessionChanges.fire({ added: [nextSession], removed: [previousSession], changed: [] });
      }
    }
  }

  private async getCurrentSession(): Promise<vscode.AuthenticationSession | undefined> {
    const status = await this.authManager.getStatus();
    if (!status.authenticated) {
      return undefined;
    }
    try {
      const snapshot = await this.authManager.getCredentialSnapshot();
      return toAuthenticationSession(status, snapshot);
    } catch {
      return undefined;
    }
  }
}

function supportsRequestedScopes(scopes: readonly string[]): boolean {
  return scopes.every((scope) => supportedScopes.includes(scope));
}

function toAuthenticationSession(status: CodexAuthStatus, snapshot: CodexCredentialSnapshot): vscode.AuthenticationSession {
  const accountId = snapshot.accountId ?? status.email ?? snapshot.source;
  return {
    id: `${snapshot.source}:${accountId}`,
    accessToken: snapshot.accessToken,
    account: {
      id: accountId,
      label: status.email ?? 'ChatGPT'
    },
    scopes: supportedScopes
  };
}