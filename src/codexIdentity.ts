import { randomUUID } from 'node:crypto';
import type { CodexRequestIdentity } from './codexProtocol';

const INSTALLATION_ID_STATE_KEY = 'codexModelProvider.installationId';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class CodexIdentityManager {
  readonly windowId = randomUUID();
  private installationIdPromise?: Promise<string>;

  constructor(private readonly globalState: MementoLike) {}

  getInstallationId(): Promise<string> {
    this.installationIdPromise ??= this.loadOrCreateInstallationId();
    return this.installationIdPromise;
  }

  async createThread(parentThreadId?: string): Promise<CodexRequestIdentity> {
    const installationId = await this.getInstallationId();
    const sessionId = randomUUID();
    return {
      installationId,
      sessionId,
      threadId: randomUUID(),
      turnId: randomUUID(),
      windowId: this.windowId,
      ...(parentThreadId ? { parentThreadId } : {})
    };
  }

  createNextTurn(identity: CodexRequestIdentity): CodexRequestIdentity {
    return {
      ...identity,
      turnId: randomUUID(),
      windowId: this.windowId
    };
  }

  bindToCurrentWindow(identity: CodexRequestIdentity): CodexRequestIdentity {
    return { ...identity, windowId: this.windowId };
  }

  private async loadOrCreateInstallationId(): Promise<string> {
    const stored = this.globalState.get<string>(INSTALLATION_ID_STATE_KEY)?.trim();
    if (stored && isUuid(stored)) {
      return stored;
    }
    const created = randomUUID();
    await this.globalState.update(INSTALLATION_ID_STATE_KEY, created);
    return created;
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function inputStartsNewTurn(input: readonly { type?: string | null; role?: string | null }[]): boolean {
  return input.some((item) => item.type === 'message' && item.role === 'user');
}
