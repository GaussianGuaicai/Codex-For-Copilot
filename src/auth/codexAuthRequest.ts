import { CodexAuthManager } from './codexAuthManager';
import { ReauthRequiredError } from './codexAuthTypes';

export async function codexFetch(
  authManager: CodexAuthManager,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {}
): Promise<Response> {
  const accessToken = await authManager.getAccessToken();
  const first = await fetch(input, withAuthorization(init, accessToken));
  if (first.status !== 401) {
    return first;
  }

  await authManager.refreshAfter401();
  const retryToken = await authManager.getAccessToken();
  const retry = await fetch(input, withAuthorization(init, retryToken));
  if (retry.status === 401) {
    throw new ReauthRequiredError();
  }
  return retry;
}

function withAuthorization(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: {
      ...headersToRecord(init.headers),
      Authorization: `Bearer ${token}`
    }
  };
}

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
