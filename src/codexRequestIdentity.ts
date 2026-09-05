import os from 'node:os';
import { readFileSync } from 'node:fs';

export const CODEX_IDENTITY_UPSTREAM_COMMIT = '657a993cbee87acf52d14b758ce49dbd46d1b8eb';
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
      userAgent: `codex_cli_rs/${CODEX_CLI_COMPATIBLE_VERSION} (${platform.osType} ${platform.osVersion}; ${platform.architecture}) ${platform.terminalUserAgent}`,
      agentName: '/root'
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
  const platform = upstreamPlatform();
  return {
    ...platform,
    architecture: normalizeArchitecture(os.arch()),
    terminalUserAgent: detectTerminalUserAgent(process.env)
  };
}

/** Pinned subset of codex-terminal-detection's ordered probes and token normalization. */
export function detectTerminalUserAgent(environment: NodeJS.ProcessEnv): string {
  const value = (name: string) => environment[name]?.trim() || undefined;
  const termProgram = value('TERM_PROGRAM');
  if (termProgram) {
    return sanitizeToken(`${termProgram}${value('TERM_PROGRAM_VERSION') ? `/${value('TERM_PROGRAM_VERSION')}` : ''}`);
  }
  const detected: [boolean, string, string?][] = [
    [Boolean(value('WEZTERM_VERSION')), 'WezTerm', value('WEZTERM_VERSION')],
    [Boolean(value('ITERM_SESSION_ID') || value('ITERM_PROFILE') || value('ITERM_PROFILE_NAME')), 'iTerm.app'],
    [Boolean(value('TERM_SESSION_ID')), 'Apple_Terminal'],
    [Boolean(value('KITTY_WINDOW_ID') || value('TERM')?.includes('kitty')), 'kitty'],
    [Boolean(value('ALACRITTY_SOCKET') || value('TERM') === 'alacritty'), 'Alacritty'],
    [Boolean(value('KONSOLE_VERSION')), 'Konsole', value('KONSOLE_VERSION')],
    [Boolean(value('GNOME_TERMINAL_SCREEN')), 'gnome-terminal'],
    [Boolean(value('VTE_VERSION')), 'VTE', value('VTE_VERSION')],
    [Boolean(value('WT_SESSION')), 'WindowsTerminal']
  ];
  const match = detected.find(([present]) => present);
  if (match) return sanitizeToken(`${match[1]}${match[2] ? `/${match[2]}` : ''}`);
  return sanitizeToken(value('TERM') ?? 'unknown');
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, '_');
}

function normalizeArchitecture(value: string): string {
  return value === 'x64' ? 'x86_64' : value === 'arm64' ? 'aarch64' : value;
}

function upstreamPlatform(): Pick<NonNullable<ResolveRequestIdentityOptions['platform']>, 'osType' | 'osVersion'> {
  if (process.platform === 'win32') return { osType: 'Windows', osVersion: os.release() };
  if (process.platform === 'darwin') return { osType: 'Mac OS', osVersion: os.release() };
  if (process.platform !== 'linux') return { osType: os.type(), osVersion: os.release() };
  try {
    const fields = Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split('\n').flatMap((line) => {
      const separator = line.indexOf('=');
      if (separator < 1) return [];
      return [[line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, '')]];
    }));
    return { osType: fields.NAME || 'Linux', osVersion: fields.VERSION_ID || os.release() };
  } catch {
    return { osType: 'Linux', osVersion: os.release() };
  }
}
