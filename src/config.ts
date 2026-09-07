import * as vscode from 'vscode';
import { normalizeKnownReasoningEffort, type KnownReasoningEffort } from './reasoningEffort';
import { MAX_NAMESPACE_FUNCTIONS } from './nativeToolSearch/nativeToolPolicy';
import type { CodexProtocolProfileName, CodexProtocolSettings } from './codexProtocol';
import {
  normalizeCustomRequestIdentity,
  type CodexRequestIdentityProfile,
  type RequestIdentitySettings
} from './codexRequestIdentity';

export interface ModelPricing {
  input?: number;
  cachedInput?: number;
  output?: number;
}

export interface WebSearchConfig {
  externalWebAccess: boolean;
  contextSize?: 'low' | 'medium' | 'high';
  allowedDomains: string[];
  statusDetail: 'compact' | 'actions' | 'actionsAndSources';
  statusMaxSources: number;
}

export interface ProviderConfig {
  baseURL: string;
  clientVersion: string;
  credentialsSource: 'auto' | 'codexAuth' | 'secretStorage';
  transport: 'auto' | 'http' | 'websocket';
  websocketPrewarm: 'auto' | 'enabled' | 'disabled';
  requestCompression: 'auto' | 'enabled' | 'disabled';
  protocol: CodexProtocolSettings;
  requestIdentity: RequestIdentitySettings;
  nativeToolSearch: 'auto' | 'enabled' | 'disabled';
  nativeToolSearchMaxToolsPerNamespace: number;
  webSearch: WebSearchConfig;
  model: string;
  includeHiddenModels: boolean;
  disabledModels: string[];
  modelAliases: Record<string, string>;
  instructions: string;
  defaultServiceTier?: 'default' | 'fast';
  defaultReasoningEffort?: KnownReasoningEffort;
  maxOutputTokens: number;
  modelPricingUsdPerMTok: Record<string, ModelPricing>;
}

export function getProviderConfig(): ProviderConfig {
  const config = vscode.workspace.getConfiguration('codexModelProvider');

  return {
    baseURL: config.get('baseURL', 'https://chatgpt.com/backend-api/codex/responses'),
    clientVersion: config.get('clientVersion', '0.0.0'),
    credentialsSource: config.get('credentialsSource', 'auto'),
    transport: normalizeTransport(config.get('transport', 'auto')),
    websocketPrewarm: normalizeTriState(config.get('websocketPrewarm', 'auto')),
    requestCompression: normalizeTriState(config.get('requestCompression', 'auto')),
    protocol: {
      profile: normalizeProtocolProfile(config.get('protocolProfile', 'auto')),
      headerOverrides: normalizeStringRecord(config.get('headerOverrides', {}), 32, 1024),
      clientMetadataOverrides: normalizeStringRecord(config.get('clientMetadataOverrides', {}), 16, 128),
      turnMetadataOverrides: normalizeJsonRecord(config.get('turnMetadataOverrides', {}), 16),
      omitGeneratedHeaders: normalizeStringList(config.get('omitGeneratedHeaders', [])),
      allowUnsafeProtocolOverrides: config.get('allowUnsafeProtocolOverrides', false)
    },
    requestIdentity: {
      profile: normalizeRequestIdentityProfile(config.get('requestIdentityProfile', 'extension')),
      custom: normalizeCustomRequestIdentity(config.get('customRequestIdentity', {}))
    },
    nativeToolSearch: normalizeTriState(config.get('nativeToolSearch', 'disabled'), 'disabled'),
    nativeToolSearchMaxToolsPerNamespace: normalizeNativeToolSearchMaxToolsPerNamespace(
      config.get('nativeToolSearchMaxToolsPerNamespace', MAX_NAMESPACE_FUNCTIONS)
    ),
    webSearch: {
      externalWebAccess: config.get('webSearchExternalAccess', true),
      contextSize: normalizeWebSearchContextSize(config.get('webSearchContextSize', 'default')),
      allowedDomains: normalizeWebSearchDomains(config.get('webSearchAllowedDomains', [])),
      statusDetail: normalizeWebSearchStatusDetail(config.get('webSearchStatusDetail', 'actionsAndSources')),
      statusMaxSources: normalizeWebSearchStatusMaxSources(config.get('webSearchStatusMaxSources', 3))
    },
    model: config.get('model', 'gpt-5.5'),
    includeHiddenModels: config.get('includeHiddenModels', false),
    disabledModels: normalizeStringList(config.get('disabledModels', [])),
    modelAliases: normalizeModelAliases(config.get('modelAliases', {})),
    instructions: config.get('instructions', 'You are a helpful coding assistant integrated with VS Code.'),
    defaultServiceTier: normalizeDefaultServiceTier(config.get('defaultServiceTier', 'auto')),
    defaultReasoningEffort: normalizeDefaultReasoningEffort(config.get('defaultReasoningEffort', 'auto')),
    maxOutputTokens: config.get('maxOutputTokens', 8192),
    modelPricingUsdPerMTok: normalizeModelPricing(config.get('modelPricingUsdPerMTok', {}))
  };
}

function normalizeRequestIdentityProfile(value: unknown): CodexRequestIdentityProfile {
  return value === 'codexCliCompatible' || value === 'neutral' || value === 'custom' ? value : 'extension';
}

function normalizeProtocolProfile(value: unknown): CodexProtocolProfileName {
  return value === 'codexCompatible' || value === 'minimal' || value === 'custom' ? value : 'auto';
}

function normalizeTriState(
  value: string,
  fallback: 'auto' | 'enabled' | 'disabled' = 'auto'
): 'auto' | 'enabled' | 'disabled' {
  return value === 'auto' || value === 'enabled' || value === 'disabled' ? value : fallback;
}

function normalizeNativeToolSearchMaxToolsPerNamespace(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_NAMESPACE_FUNCTIONS;
  }
  return Math.min(MAX_NAMESPACE_FUNCTIONS, Math.max(1, Math.floor(value)));
}

function normalizeWebSearchContextSize(value: unknown): WebSearchConfig['contextSize'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function normalizeWebSearchStatusDetail(value: unknown): WebSearchConfig['statusDetail'] {
  return value === 'compact' || value === 'actions' ? value : 'actionsAndSources';
}

function normalizeWebSearchStatusMaxSources(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 3;
  }
  return Math.min(10, Math.max(0, Math.floor(value)));
}

function normalizeWebSearchDomains(value: unknown): string[] {
  return [...new Set(normalizeStringList(value)
    .map((domain) => domain.toLowerCase())
    .filter(isDomainName))]
    .slice(0, 100);
}

function isDomainName(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.includes('://') || value.includes('/')) {
    return false;
  }
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function normalizeTransport(value: string): ProviderConfig['transport'] {
  switch (value) {
    case 'http':
    case 'websocket':
      return value;
    default:
      return 'auto';
  }
}

function normalizeDefaultServiceTier(value: string): ProviderConfig['defaultServiceTier'] {
  switch (value) {
    case 'default':
    case 'fast':
      return value;
    default:
      return undefined;
  }
}

function normalizeDefaultReasoningEffort(value: string): ProviderConfig['defaultReasoningEffort'] {
  return normalizeKnownReasoningEffort(value);
}

function normalizeModelPricing(value: unknown): Record<string, ModelPricing> {
  if (!isObjectRecord(value)) {
    return {};
  }

  const normalized: Record<string, ModelPricing> = {};

  for (const [model, pricing] of Object.entries(value)) {
    if (!isObjectRecord(pricing)) {
      continue;
    }

    const normalizedPricing: ModelPricing = {
      input: normalizePricingNumber(pricing.input),
      cachedInput: normalizePricingNumber(pricing.cachedInput),
      output: normalizePricingNumber(pricing.output)
    };

    if (
      normalizedPricing.input !== undefined ||
      normalizedPricing.cachedInput !== undefined ||
      normalizedPricing.output !== undefined
    ) {
      normalized[model] = normalizedPricing;
    }
  }

  return normalized;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0))];
}

function normalizeModelAliases(value: unknown): Record<string, string> {
  if (!isObjectRecord(value)) {
    return {};
  }

  const aliases: Record<string, string> = {};
  for (const [source, target] of Object.entries(value)) {
    const normalizedSource = source.trim();
    const normalizedTarget = typeof target === 'string' ? target.trim() : '';
    if (normalizedSource && normalizedTarget && normalizedSource !== normalizedTarget) {
      aliases[normalizedSource] = normalizedTarget;
    }
  }

  return aliases;
}

function normalizeStringRecord(
  value: unknown,
  maxEntries: number,
  maxValueBytes: number
): Record<string, string> {
  if (!isObjectRecord(value)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (Object.keys(normalized).length >= maxEntries) {
      break;
    }
    if (key.trim().length > 0 && typeof nested === 'string' && Buffer.byteLength(nested) <= maxValueBytes) {
      normalized[key] = nested;
    }
  }
  return normalized;
}

function normalizeJsonRecord(value: unknown, maxEntries: number): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).slice(0, maxEntries));
}

function normalizePricingNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
