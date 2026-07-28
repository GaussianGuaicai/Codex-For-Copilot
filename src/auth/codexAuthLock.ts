import { open, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
const STALE_LOCK_MS = 60_000; const ACQUIRE_TIMEOUT_MS = 15_000; const RETRY_DELAY_MS = 150;
export class CodexAuthLock {
  constructor(private readonly lockUri: vscode.Uri) {}
  async withLock<T>(fn: () => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
    const owner = await this.acquire(token); try { return await fn(); } finally { await this.release(owner); }
  }
  private async acquire(token?: vscode.CancellationToken): Promise<string> {
    const owner = randomBytes(16).toString('hex'); const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (token?.isCancellationRequested) throw new Error('Credential refresh was cancelled.');
      if (await this.tryCreateLock(owner)) return owner;
      await this.replaceIfStale(); await delay(RETRY_DELAY_MS);
    }
    throw new Error('Timed out waiting for another VS Code window to refresh credentials.');
  }
  private async tryCreateLock(owner: string): Promise<boolean> { try { const handle = await open(this.lockUri.fsPath, 'wx'); try { await handle.writeFile(JSON.stringify({ owner, createdAt: Date.now() }), 'utf8'); } finally { await handle.close(); } return true; } catch { return false; } }
  private async replaceIfStale(): Promise<void> { try { const stat = await vscode.workspace.fs.stat(this.lockUri); if (Date.now() - stat.mtime > STALE_LOCK_MS) await vscode.workspace.fs.delete(this.lockUri); } catch { /* raced with another owner */ } }
  private async release(owner: string): Promise<void> { try { const raw = await readFile(this.lockUri.fsPath, 'utf8'); if (JSON.parse(raw).owner === owner) await vscode.workspace.fs.delete(this.lockUri); } catch { /* best effort cleanup */ } }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
