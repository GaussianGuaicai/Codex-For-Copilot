import { CodexAuthManager } from './codexAuthManager';
import { ReauthRequiredError } from './codexAuthTypes';

export async function codexFetch(
  authManager: CodexAuthManager,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  performFetch: typeof fetch = fetch,
  accountKey?: string
): Promise<Response> {
  const compatibleManager = authManager as CodexAuthManager & { getAccessToken?: () => Promise<string>; refreshAfter401?: () => Promise<void> };
  const snapshot = typeof compatibleManager.getCredentialSnapshot === 'function'
    ? await compatibleManager.getCredentialSnapshot(accountKey)
    : { accessToken: await compatibleManager.getAccessToken!(), revision: 'legacy', accountKey };
  const first = await performFetch(input, withAuthorization(init, snapshot));
  if (first.status !== 401) {
    return first;
  }

  await first.body?.cancel().catch(() => undefined);
  const retrySnapshot = typeof compatibleManager.recoverFromUnauthorized === 'function'
    ? await compatibleManager.recoverFromUnauthorized({ accountKey: accountKey ?? snapshot.accountKey ?? '', snapshotRevision: snapshot.revision, visibleActivity: false, reason: 'http401' })
    : (await compatibleManager.refreshAfter401!(), { accessToken: await compatibleManager.getAccessToken!() });
  const retry = await performFetch(input, withAuthorization(init, retrySnapshot));
  if (retry.status === 401) {
    throw new ReauthRequiredError();
  }
  return retry;
}

function withAuthorization(init: RequestInit, snapshot: { accessToken: string; accountId?: string }): RequestInit {
  const headers = headersToRecord(init.headers);
  deleteHeader(headers, 'Authorization');
  deleteHeader(headers, 'ChatGPT-Account-ID');
  return {
    ...init,
    headers: {
      ...headers,
      Authorization: `Bearer ${snapshot.accessToken}`,
      ...(snapshot.accountId?.trim() ? { 'ChatGPT-Account-ID': snapshot.accountId.trim() } : {})
    }
  };
}

function deleteHeader(headers: Record<string, string>, target: string): void { for (const name of Object.keys(headers)) if (name.toLowerCase() === target.toLowerCase()) delete headers[name]; }

function headersToRecord(headers: RequestInit['headers'] | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]));
}
