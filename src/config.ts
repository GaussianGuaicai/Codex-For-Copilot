import * as vscode from 'vscode';

export interface ModelPricing {
  input?: number;
  cachedInput?: number;
  output?: number;
}

export interface ProviderConfig {
  baseURL: string;
  clientVersion: string;
  credentialsSource: 'auto' | 'codexAuth' | 'secretStorage';
  transport: 'auto' | 'http' | 'websocket';
  model: string;
  instructions: string;
  defaultServiceTier?: 'default' | 'fast';
  defaultReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
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
    model: config.get('model', 'gpt-5.5'),
    instructions: config.get('instructions', 'You are a helpful coding assistant integrated with VS Code.'),
    defaultServiceTier: normalizeDefaultServiceTier(config.get('defaultServiceTier', 'auto')),
    defaultReasoningEffort: normalizeDefaultReasoningEffort(config.get('defaultReasoningEffort', 'auto')),
    maxOutputTokens: config.get('maxOutputTokens', 8192),
    modelPricingUsdPerMTok: normalizeModelPricing(config.get('modelPricingUsdPerMTok', {}))
  };
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
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
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

function normalizePricingNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
