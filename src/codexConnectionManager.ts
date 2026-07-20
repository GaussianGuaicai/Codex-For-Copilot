import OpenAI from 'openai';
import type { ResponsesWSClientOptions } from 'openai/resources/responses/ws';
import { CodexWebSocketSession, type CodexWebSocketPreconnectionObserver } from './codexWebSocketSession';

export interface CodexConnectionScope {
  baseURL: string;
  authIdentity: string;
  accountId?: string;
  compatibilityProfile: string;
  sessionId: string;
  threadId: string;
}

export type CodexConnectionScopeBase = Omit<CodexConnectionScope, 'sessionId' | 'threadId'>;

export type CodexConnectionOrigin = 'fresh' | 'preconnected' | 'previous-response';

interface ManagedConnection {
  session: CodexWebSocketSession;
  scopeKey: string;
  threadKey: string;
}

interface PreconnectedConnection {
  session: CodexWebSocketSession;
  scopeKey: string;
}

const MAX_CONNECTIONS = 32;
const CONNECTION_TTL_MS = 10 * 60 * 1000;
const MAX_PRECONNECTIONS = 16;
const PRECONNECTION_TTL_MS = 45 * 1000;

export class CodexConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly preconnections = new Map<string, PreconnectedConnection>();
  private readonly httpFallbackSessions = new Map<string, number>();
  private readonly prewarmDisabledSessions = new Map<string, number>();

  getOrCreate(
    scope: CodexConnectionScope,
    client: OpenAI,
    options: ResponsesWSClientOptions
  ): { session: CodexWebSocketSession; reused: boolean; origin: CodexConnectionOrigin } {
    this.evict();
    const threadKey = this.threadKey(scope);
    const existing = this.connections.get(threadKey);
    if (existing?.session.isUsable()) {
      return { session: existing.session, reused: true, origin: 'previous-response' };
    }
    existing?.session.close();
    const scopeKey = this.scopeKey(scope);
    const preconnected = this.preconnections.get(scopeKey);
    if (preconnected?.session.isUsable()) {
      this.preconnections.delete(scopeKey);
      this.connections.set(threadKey, {
        session: preconnected.session,
        scopeKey,
        threadKey
      });
      return { session: preconnected.session, reused: false, origin: 'preconnected' };
    }
    preconnected?.session.close();
    this.preconnections.delete(scopeKey);
    const session = new CodexWebSocketSession(client, options);
    this.connections.set(threadKey, {
      session,
      scopeKey,
      threadKey
    });
    this.evict();
    return { session, reused: false, origin: 'fresh' };
  }

  preconnect(
    scope: CodexConnectionScopeBase,
    client: OpenAI,
    options: ResponsesWSClientOptions,
    observer?: CodexWebSocketPreconnectionObserver
  ): boolean {
    this.evict();
    const scopeKey = this.scopeKey(scope);
    const existing = this.preconnections.get(scopeKey);
    if (existing?.session.isUsable()) {
      return false;
    }
    existing?.session.close();
    const session = new CodexWebSocketSession(client, options);
    session.protectIdlePreconnection(observer);
    this.preconnections.set(scopeKey, { session, scopeKey });
    this.evict();
    return true;
  }

  isHttpFallback(scope: CodexConnectionScope): boolean {
    this.evictCapabilities();
    return this.httpFallbackSessions.has(this.sessionKey(scope));
  }

  markHttpFallback(scope: CodexConnectionScope): void {
    this.httpFallbackSessions.set(this.sessionKey(scope), Date.now());
    this.closeThread(scope);
  }

  disablePrewarm(scope: CodexConnectionScope): void {
    this.prewarmDisabledSessions.set(this.sessionKey(scope), Date.now());
  }

  isPrewarmDisabled(scope: CodexConnectionScope): boolean {
    this.evictCapabilities();
    return this.prewarmDisabledSessions.has(this.sessionKey(scope));
  }

  closeThread(scope: CodexConnectionScope): void {
    const key = this.threadKey(scope);
    this.connections.get(key)?.session.close();
    this.connections.delete(key);
  }

  invalidateScope(scope: CodexConnectionScopeBase): void {
    const scopeKey = this.scopeKey(scope);
    for (const [key, connection] of this.connections) {
      if (connection.scopeKey === scopeKey) {
        connection.session.close();
        this.connections.delete(key);
      }
    }
    for (const key of this.httpFallbackSessions.keys()) {
      if (key.startsWith(`${scopeKey}|`)) {
        this.httpFallbackSessions.delete(key);
      }
    }
    const preconnected = this.preconnections.get(scopeKey);
    preconnected?.session.close();
    this.preconnections.delete(scopeKey);
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      connection.session.close();
    }
    for (const connection of this.preconnections.values()) {
      connection.session.close();
    }
    this.connections.clear();
    this.preconnections.clear();
    this.httpFallbackSessions.clear();
    this.prewarmDisabledSessions.clear();
  }

  private evict(): void {
    this.evictCapabilities();
    const now = Date.now();
    for (const [key, connection] of this.connections) {
      if (!connection.session.isUsable() || now - connection.session.lastUsedAt > CONNECTION_TTL_MS) {
        connection.session.close();
        this.connections.delete(key);
      }
    }
    for (const [scopeKey, connection] of this.preconnections) {
      if (!connection.session.isUsable() || now - connection.session.lastUsedAt > PRECONNECTION_TTL_MS) {
        connection.session.close();
        this.preconnections.delete(scopeKey);
      }
    }
    if (this.connections.size > MAX_CONNECTIONS) {
      const oldest = [...this.connections.entries()]
        .sort((left, right) => left[1].session.lastUsedAt - right[1].session.lastUsedAt);
      while (this.connections.size > MAX_CONNECTIONS) {
        const entry = oldest.shift();
        if (!entry) {
          break;
        }
        entry[1].session.close();
        this.connections.delete(entry[0]);
      }
    }
    if (this.preconnections.size > MAX_PRECONNECTIONS) {
      const oldestPreconnections = [...this.preconnections.entries()]
        .sort((left, right) => left[1].session.lastUsedAt - right[1].session.lastUsedAt);
      while (this.preconnections.size > MAX_PRECONNECTIONS) {
        const entry = oldestPreconnections.shift();
        if (!entry) {
          break;
        }
        entry[1].session.close();
        this.preconnections.delete(entry[0]);
      }
    }
  }

  private evictCapabilities(): void {
    const cutoff = Date.now() - CONNECTION_TTL_MS;
    for (const map of [this.httpFallbackSessions, this.prewarmDisabledSessions]) {
      for (const [key, updatedAt] of map) {
        if (updatedAt < cutoff) {
          map.delete(key);
        }
      }
      const overflow = map.size - MAX_CONNECTIONS * 4;
      if (overflow > 0) {
        const oldest = [...map.entries()]
          .sort((left, right) => left[1] - right[1])
          .slice(0, overflow);
        for (const [key] of oldest) {
          map.delete(key);
        }
      }
    }
  }

  private scopeKey(scope: CodexConnectionScopeBase): string {
    return [scope.baseURL, scope.authIdentity, scope.accountId ?? '', scope.compatibilityProfile].join('|');
  }

  private sessionKey(scope: CodexConnectionScope): string {
    return `${this.scopeKey(scope)}|${scope.sessionId}`;
  }

  private threadKey(scope: CodexConnectionScope): string {
    return `${this.sessionKey(scope)}|${scope.threadId}`;
  }
}

export const codexConnectionManager = new CodexConnectionManager();
