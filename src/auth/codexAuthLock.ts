import * as vscode from 'vscode';

const STALE_LOCK_MS = 60_000;
const RETRY_DELAY_MS = 150;

export class CodexAuthLock {
  constructor(private readonly lockUri: vscode.Uri) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      try {
        await vscode.workspace.fs.delete(this.lockUri);
      } catch {
        // Best effort cleanup only.
      }
    }
  }

  private async acquire(): Promise<void> {
    while (true) {
      if (!(await this.lockExists())) {
        await vscode.workspace.fs.writeFile(this.lockUri, Buffer.from(String(Date.now())));
        return;
      }

      if (await this.replaceIfStale()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  private async lockExists(): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.lockUri);
      return true;
    } catch {
      return false;
    }
  }

  private async replaceIfStale(): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(this.lockUri);
      if (Date.now() - stat.mtime <= STALE_LOCK_MS) {
        return false;
      }
      await vscode.workspace.fs.delete(this.lockUri);
      await vscode.workspace.fs.writeFile(this.lockUri, Buffer.from(String(Date.now())));
      return true;
    } catch {
      return false;
    }
  }
}
