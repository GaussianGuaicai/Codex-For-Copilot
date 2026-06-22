import * as vscode from 'vscode';
import type { ProviderConfig } from './config';
import type { ApiCredentials } from './secrets';
import { normalizeBaseURL } from './responsesClient';

const REASONING_ID_DELIMITER = '::reasoning=';
const PROVIDER_MODEL_ID_PREFIX = 'codex::';
const DEFAULT_FALLBACK_CONTEXT_WINDOW = 272000;
const FIXED_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.5': 272000,
  'gpt-5.4': 272000,
  'gpt-5.4-mini': 272000,
  'gpt-5.3-codex-spark-preview': 128000,
  'codex-auto-review': 272000
};

const MODEL_DESCRIPTION_FALLBACKS: Record<string, string> = {
  'gpt-5.5': 'Frontier model for complex coding, research, and real-world work.',
  'gpt-5.4': 'Strong model for everyday coding.',
  'gpt-5.4-mini': 'Small, fast, and cost-efficient model for simpler coding tasks.',
  'gpt-5.3-codex-spark-preview': 'Ultra-fast coding model (preview).',
  'codex-auto-review': 'Automatic approval review model for Codex.'
};

const MODEL_DEFAULT_REASONING_FALLBACKS: Partial<Record<string, ReasoningEffort>> = {
  'gpt-5.5': 'xhigh',
  'gpt-5.4': 'medium',
  'gpt-5.4-mini': 'medium',
  'gpt-5.3-codex-spark-preview': 'high',
  'codex-auto-review': 'medium'
};

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High'
};

const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: 'Skip extra reasoning for the fastest replies when the model supports it.',
  minimal: 'Use a very light reasoning pass for small edits and quick follow-ups.',
  low: 'Fast responses with lighter reasoning.',
  medium: 'Balances speed and reasoning depth for everyday tasks.',
  high: 'Greater reasoning depth for complex problems.',
  xhigh: 'Extra high reasoning depth for complex problems.'
};

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface UpstreamReasoningLevel {
  effort?: unknown;
  description?: unknown;
}

interface ReasoningOption {
  effort: ReasoningEffort;
  description: string;
}

interface UpstreamModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  context_window?: unknown;
  input_modalities?: unknown;
  comp_hash?: unknown;
  supported_in_api?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

export interface ResolvedProviderModel {
  info: vscode.LanguageModelChatInformation;
  requestModel: string;
  reasoningEffort?: ReasoningEffort;
}

type ThinkingEffortSchema = {
  readonly properties: {
    readonly reasoningEffort: {
      readonly type: 'string';
      readonly title: string;
      readonly enum: readonly ReasoningEffort[];
      readonly enumItemLabels: readonly string[];
      readonly enumDescriptions: readonly string[];
      readonly default: ReasoningEffort;
      readonly group: 'navigation';
    };
  };
};

type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly configurationSchema?: ThinkingEffortSchema;
};

export interface ParsedModelIdentifier {
  requestModel: string;
  reasoningEffort?: ReasoningEffort;
}

export async function fetchAvailableModels(
  config: ProviderConfig,
  credentials: ApiCredentials,
  token: vscode.CancellationToken
): Promise<UpstreamModel[]> {
  const modelsURL = new URL(`${normalizeBaseURL(config.baseURL)}/models`);
  modelsURL.searchParams.set('client_version', config.clientVersion);

  const response = await fetch(modelsURL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      ...credentials.headers
    },
    signal: toAbortSignal(token)
  });

  if (!response.ok) {
    throw new Error(`Model discovery failed with ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { models?: unknown; data?: unknown };
  const discovered = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  return discovered.filter(isUpstreamModel).filter((model) => isModelVisible(model));
}

export function buildProviderModels(config: ProviderConfig, upstreamModels: UpstreamModel[]): ResolvedProviderModel[] {
  const models = upstreamModels.map((model) => buildDiscoveredModel(model, config));
  return models.length > 0 ? models : [buildFallbackModel(config)];
}

export function buildFallbackModel(config: ProviderConfig): ResolvedProviderModel {
  const fallbackMaxInputTokens = getFallbackContextWindow(config.model);
  const reasoningEffort = getDefaultReasoningEffort(undefined, config.model);
  const reasoningOptions = getReasoningOptions(undefined, config.model);
  return {
    requestModel: config.model,
    reasoningEffort,
    info: {
      id: toProviderModelId(config.model),
      name: formatDisplayName(config.model),
      family: config.model,
      version: '1.0.0',
      maxInputTokens: fallbackMaxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      tooltip: getModelDescription(undefined, config.model),
      detail: buildModelDetail(fallbackMaxInputTokens, reasoningOptions, reasoningEffort, config.baseURL),
      capabilities: {
        imageInput: false,
        toolCalling: true
      }
    }
  };
}

export function parseModelIdentifier(modelId: string): ParsedModelIdentifier {
  const normalizedModelId = stripProviderModelIdPrefix(modelId);
  const delimiterIndex = normalizedModelId.indexOf(REASONING_ID_DELIMITER);
  if (delimiterIndex < 0) {
    return { requestModel: normalizedModelId };
  }

  const requestModel = normalizedModelId.slice(0, delimiterIndex);
  const reasoningEffort = normalizeReasoningEffort(normalizedModelId.slice(delimiterIndex + REASONING_ID_DELIMITER.length));
  return { requestModel, reasoningEffort };
}

function buildDiscoveredModel(model: UpstreamModel, config: ProviderConfig): ResolvedProviderModel {
  const slug = typeof model.slug === 'string' && model.slug.trim() ? model.slug.trim() : config.model;
  const displayName = getDiscoveredDisplayName(model, config.model);
  const reasoningOptions = getReasoningOptions(model, slug);
  const reasoningEfforts = reasoningOptions.map((option) => option.effort);
  const defaultReasoningEffort = getDefaultReasoningEffort(model, slug);
  const maxInputTokens = getModelContextWindow(slug, model.context_window, getFallbackContextWindow(slug));
  const imageInput = Array.isArray(model.input_modalities) && model.input_modalities.includes('image');
  const tooltip = getModelDescription(model, slug);
  const versionBase = typeof model.comp_hash === 'string' && model.comp_hash.trim() ? model.comp_hash.trim() : '1.0.0';

  const info: ModelPickerChatInformation = {
    id: toProviderModelId(slug),
    name: displayName,
    family: slug,
    version: versionBase,
    maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    tooltip,
    detail: buildModelDetail(maxInputTokens, reasoningOptions, defaultReasoningEffort),
    capabilities: {
      imageInput,
      toolCalling: true
    },
    ...(reasoningEfforts.length > 1
      ? { configurationSchema: buildThinkingEffortSchema(reasoningOptions, defaultReasoningEffort ?? reasoningEfforts[0]) }
      : {})
  };

  return {
    requestModel: slug,
    reasoningEffort: defaultReasoningEffort ?? reasoningEfforts[0],
    info
  };
}

function getReasoningOptions(model: UpstreamModel | undefined, slug: string): ReasoningOption[] {
  const upstreamOptions = Array.isArray(model?.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map((level) => toReasoningOption(level as UpstreamReasoningLevel))
        .filter((level): level is ReasoningOption => level !== undefined)
    : [];

  const ordered: ReasoningOption[] = [];
  const defaultEffort = getDefaultReasoningEffort(model, slug);
  if (defaultEffort) {
    ordered.push({
      effort: defaultEffort,
      description: getReasoningEffortDescription(defaultEffort)
    });
  }

  for (const option of upstreamOptions) {
    const existingIndex = ordered.findIndex((entry) => entry.effort === option.effort);
    if (existingIndex >= 0) {
      ordered[existingIndex] = option;
    } else {
      ordered.push(option);
    }
  }

  return ordered;
}

function toReasoningOption(level: UpstreamReasoningLevel): ReasoningOption | undefined {
  const effort = normalizeReasoningEffort(level.effort);
  if (!effort) {
    return undefined;
  }

  return {
    effort,
    description: typeof level.description === 'string' && level.description.trim()
      ? normalizeSentence(level.description.trim())
      : getReasoningEffortDescription(effort)
  };
}

function getDefaultReasoningEffort(model: UpstreamModel | undefined, slug: string): ReasoningEffort | undefined {
  return normalizeReasoningEffort(model?.default_reasoning_level) ?? MODEL_DEFAULT_REASONING_FALLBACKS[slug];
}

function getModelDescription(model: UpstreamModel | undefined, slug: string): string {
  if (typeof model?.description === 'string' && model.description.trim()) {
    return model.description.trim();
  }

  return MODEL_DESCRIPTION_FALLBACKS[slug] ?? 'Codex model discovered from the ChatGPT Codex backend.';
}

function getDiscoveredDisplayName(model: UpstreamModel, fallbackModel: string): string {
  if (typeof model.display_name === 'string' && model.display_name.trim()) {
    return model.display_name.trim();
  }

  const slug = typeof model.slug === 'string' && model.slug.trim() ? model.slug.trim() : fallbackModel;
  return formatDisplayName(slug);
}

function formatDisplayName(model: string): string {
  const normalized = model.trim() || 'gpt-5.5';
  return normalized
    .replace(/^gpt/i, 'GPT')
    .replace(/codex/gi, 'Codex');
}

function getModelContextWindow(model: string, discoveredContextWindow: unknown, fallbackContextWindow: number): number {
  const fixedContextWindow = FIXED_MODEL_CONTEXT_WINDOWS[model];
  if (fixedContextWindow) {
    return fixedContextWindow;
  }

  return getPositiveInteger(discoveredContextWindow) ?? fallbackContextWindow;
}

function getFallbackContextWindow(model: string): number {
  return FIXED_MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_FALLBACK_CONTEXT_WINDOW;
}

function toProviderModelId(requestModel: string): string {
  return `${PROVIDER_MODEL_ID_PREFIX}${requestModel}`;
}

function stripProviderModelIdPrefix(modelId: string): string {
  return modelId.startsWith(PROVIDER_MODEL_ID_PREFIX)
    ? modelId.slice(PROVIDER_MODEL_ID_PREFIX.length)
    : modelId;
}

function buildModelDetail(
  maxInputTokens: number,
  reasoningOptions?: readonly ReasoningOption[],
  defaultReasoningEffort?: ReasoningEffort,
  sourceHint?: string
): string {
  const parts = [`Context: ${formatTokenCount(maxInputTokens)}`];

  if (reasoningOptions && reasoningOptions.length > 0) {
    const labels = reasoningOptions.map((option) => formatReasoningEffort(option.effort));
    if (defaultReasoningEffort) {
      parts.push(`Thinking: ${labels.join(', ')} (default: ${formatReasoningEffort(defaultReasoningEffort)})`);
    } else {
      parts.push(`Thinking: ${labels.join(', ')}`);
    }
  }

  if (sourceHint) {
    parts.push(sourceHint);
  }

  return parts.join(' | ');
}

function buildThinkingEffortSchema(reasoningOptions: readonly ReasoningOption[], defaultEffort: ReasoningEffort): ThinkingEffortSchema {
  const efforts = reasoningOptions.map((option) => option.effort);
  const labels = reasoningOptions.map((option) => formatReasoningEffort(option.effort));
  const descriptions = reasoningOptions.map((option) => option.description);

  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        enum: [...efforts],
        enumItemLabels: labels,
        enumDescriptions: descriptions,
        default: defaultEffort,
        group: 'navigation'
      }
    }
  };
}

function formatTokenCount(value: number): string {
  return `${value.toLocaleString()} tokens`;
}

function formatReasoningEffort(effort: ReasoningEffort): string {
  return REASONING_EFFORT_LABELS[effort];
}

function getReasoningEffortDescription(effort: ReasoningEffort): string {
  return REASONING_EFFORT_DESCRIPTIONS[effort];
}

function normalizeSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function isUpstreamModel(value: unknown): value is UpstreamModel {
  return typeof value === 'object' && value !== null;
}

function isModelVisible(model: UpstreamModel): boolean {
  if (model.supported_in_api === false) {
    return false;
  }

  const slug = typeof model.slug === 'string' ? model.slug.trim().toLowerCase() : '';
  if (slug === 'codex-auto-review') {
    return true;
  }

  if (typeof model.visibility === 'string') {
    const visibility = model.visibility.trim().toLowerCase();
    if (visibility === 'hidden' || visibility === 'hide') {
      return false;
    }
  }

  return true;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
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

function getPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal | undefined {
  if (token.isCancellationRequested) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}