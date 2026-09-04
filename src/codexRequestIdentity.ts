import os from 'node:os';

export const CODEX_IDENTITY_UPSTREAM_COMMIT = '3c837e568c24e4281bba4abdf3bc3c398f3fff13';
export const CODEX_CLI_COMPATIBLE_VERSION = '0.153.2';

export type CodexRequestIdentityProfile = 'extension' | 'codexCliCompatible' | 'neutral' | 'custom';

export interface CustomRequestIdentity {
  originator?: string;
  userAgent?: string;
  version?: string;
  agentName?: string;
  source?: string;
}

export interface ResolvedRequestIdentity {
  profile: CodexRequestIdentityProfile;
  originator?: string;
  userAgent?: string;
  version?: string;
  agentName?: string;
  source?: string;
}

export interface RequestIdentitySettings {
  profile: CodexRequestIdentityProfile;
  custom: CustomRequestIdentity;
}

export interface ResolveRequestIdentityOptions {
  profile?: CodexRequestIdentityProfile;
  custom?: CustomRequestIdentity;
  extensionVersion: string;
  extensionUserAgent: string;
  platform?: { osType: string; osVersion: string; architecture: string; terminalUserAgent: string };
}

/** Resolve client declaration once; protocol and transports only project this value. */
export function resolveRequestIdentity(options: ResolveRequestIdentityOptions): ResolvedRequestIdentity {
  const profile = options.profile ?? 'extension';
  if (profile === 'neutral') {
    return { profile };
  }
  if (profile === 'custom') {
    return { profile, ...normalizeCustomRequestIdentity(options.custom) };
  }
  if (profile === 'codexCliCompatible') {
    const platform = options.platform ?? currentPlatformIdentity();
    return {
      profile,
      originator: 'codex_cli_rs',
      userAgent: `codex_cli_rs/${CODEX_CLI_COMPATIBLE_VERSION} (${platform.osType} ${platform.osVersion}; ${platform.architecture}) ${platform.terminalUserAgent}`
    };
  }
  return {
    profile: 'extension',
    originator: 'codex-for-copilot',
    userAgent: options.extensionUserAgent,
    version: options.extensionVersion,
    agentName: 'codex-for-copilot',
    source: 'vscode-language-model-provider'
  };
}

export function normalizeCustomRequestIdentity(value: unknown): CustomRequestIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const input = value as Record<string, unknown>;
  return Object.fromEntries(['originator', 'userAgent', 'version', 'agentName', 'source'].flatMap((key) => {
    const normalized = normalizeIdentityValue(input[key], key === 'userAgent' ? 512 : 128);
    return normalized === undefined ? [] : [[key, normalized]];
  })) as CustomRequestIdentity;
}

function normalizeIdentityValue(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && Buffer.byteLength(trimmed) <= maxBytes && /^[\x20-\x7e]+$/.test(trimmed)
    ? trimmed
    : undefined;
}

function currentPlatformIdentity(): ResolveRequestIdentityOptions['platform'] & {} {
  const terminal = process.env.TERM_PROGRAM?.trim();
  const terminalVersion = process.env.TERM_PROGRAM_VERSION?.trim();
  const terminalUserAgent = terminal
    ? `${terminal}${terminalVersion ? `/${terminalVersion}` : ''}`
    : process.env.TERM?.trim() || 'unknown';
  return {
    osType: os.type(),
    osVersion: os.release(),
    architecture: os.arch(),
    terminalUserAgent: terminalUserAgent.replace(/[^\x21-\x7e]/g, '_')
  };
}
