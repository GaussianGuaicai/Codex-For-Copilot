import { isIP } from 'node:net';
import * as vscode from 'vscode';

export function resolveProxyForURL(targetURL: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (shouldBypassProxy(targetURL, environment)) {
    return undefined;
  }

  const workspace = (vscode as typeof vscode & {
    workspace?: { getConfiguration?(section?: string): { get?<T>(key: string): T | undefined } };
  }).workspace;
  let configuredProxy: string | undefined;
  try {
    configuredProxy = workspace?.getConfiguration?.('http').get?.<string>('proxy')?.trim();
  } catch {
    // Keep HTTP requests usable in minimal extension-host shims that do not expose the http section.
  }
  return configuredProxy || environment.HTTPS_PROXY || environment.https_proxy
    || environment.HTTP_PROXY || environment.http_proxy;
}

export function shouldBypassProxy(baseURL: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return false;
  }
  const noProxy = [environment.NO_PROXY, environment.no_proxy]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(',');
  const targetHostname = normalizeProxyHostname(url.hostname);
  if (!noProxy) {
    return targetHostname === 'localhost' || targetHostname === '127.0.0.1' || targetHostname === '::1';
  }
  return noProxy.split(',').some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) {
      return false;
    }
    if (pattern === '*') {
      return true;
    }
    const hostname = parseNoProxyHostname(pattern);
    return Boolean(hostname)
      && (targetHostname === hostname || targetHostname.endsWith(`.${hostname}`));
  });
}

function parseNoProxyHostname(pattern: string): string | undefined {
  if (/^https?:\/\//.test(pattern)) {
    try {
      return normalizeProxyHostname(new URL(pattern).hostname).replace(/^\./, '');
    } catch {
      return undefined;
    }
  }

  if (pattern.startsWith('[')) {
    const closingBracket = pattern.indexOf(']');
    if (closingBracket <= 1) {
      return undefined;
    }

    const hostname = pattern.slice(1, closingBracket);
    const suffix = pattern.slice(closingBracket + 1);
    if (isIP(hostname) !== 6 || !isValidNoProxyPortSuffix(suffix)) {
      return undefined;
    }
    return normalizeProxyHostname(hostname);
  }

  const hostname = pattern.split(':').length > 2 ? pattern : pattern.split(':', 1)[0];
  return normalizeProxyHostname(hostname).replace(/^\./, '') || undefined;
}

function isValidNoProxyPortSuffix(suffix: string): boolean {
  if (!suffix) {
    return true;
  }
  if (!/^:\d+$/.test(suffix)) {
    return false;
  }
  const port = Number(suffix.slice(1));
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

function normalizeProxyHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
}
