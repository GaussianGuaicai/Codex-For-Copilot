import * as vscode from 'vscode';
import type { ProviderConfig } from './config';
import type { ApiCredentials } from './secrets';
import { normalizeBaseURL } from './responsesClient';

const REASONING_ID_DELIMITER = '::reasoning=';
const FIXED_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.5': 272000,
  'gpt-5.4': 272000,
  'gpt-5.4-mini': 272000,
  'gpt-5.3-codex-spark-preview': 128000,
  'codex-auto-review': 272000
};

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface UpstreamReasoningLevel {
  effort?: unknown;
  description?: unknown;
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
  const models = upstreamModels.flatMap((model) => buildDiscoveredVariants(model, config));
  return models.length > 0 ? models : [buildFallbackModel(config)];
}

export function buildFallbackModel(config: ProviderConfig): ResolvedProviderModel {
  const reasoningEffort = normalizeReasoningEffort(undefined);
  return {
    requestModel: config.model,
    reasoningEffort,
    info: {
      id: config.model,
      name: getFallbackDisplayName(config.model, config.displayName),
      family: config.model,
      version: '1.0.0',
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      tooltip: 'ChatGPT Codex Responses model provider',
      detail: `${config.baseURL} | Context: ${formatTokenCount(config.maxInputTokens)}`,
      capabilities: {
        imageInput: false,
        toolCalling: true
      }
    }
  };
}

export function parseModelIdentifier(modelId: string): ParsedModelIdentifier {
  const delimiterIndex = modelId.indexOf(REASONING_ID_DELIMITER);
  if (delimiterIndex < 0) {
    return { requestModel: modelId };
  }

  const requestModel = modelId.slice(0, delimiterIndex);
  const reasoningEffort = normalizeReasoningEffort(modelId.slice(delimiterIndex + REASONING_ID_DELIMITER.length));
  return { requestModel, reasoningEffort };
}

function buildDiscoveredVariants(model: UpstreamModel, config: ProviderConfig): ResolvedProviderModel[] {
  const slug = typeof model.slug === 'string' && model.slug.trim() ? model.slug.trim() : config.model;
  const displayName = getDiscoveredDisplayName(model, config);
  const reasoningEfforts = getOrderedReasoningEfforts(model);
  const maxInputTokens = getModelContextWindow(slug, model.context_window, config.maxInputTokens);
  const imageInput = Array.isArray(model.input_modalities) && model.input_modalities.includes('image');
  const tooltip = typeof model.description === 'string' && model.description.trim()
    ? model.description.trim()
    : 'ChatGPT Codex Responses model provider';
  const versionBase = typeof model.comp_hash === 'string' && model.comp_hash.trim() ? model.comp_hash.trim() : '1.0.0';

  if (reasoningEfforts.length === 0) {
    return [
      {
        requestModel: slug,
        info: {
          id: slug,
          name: displayName,
          family: slug,
          version: versionBase,
          maxInputTokens,
          maxOutputTokens: config.maxOutputTokens,
          tooltip,
          detail: buildModelDetail(maxInputTokens),
          capabilities: {
            imageInput,
            toolCalling: true
          }
        }
      }
    ];
  }

  return reasoningEfforts.map((reasoningEffort, index) => {
    const isDefaultEntry = index === 0;
    const modelId = `${slug}${REASONING_ID_DELIMITER}${reasoningEffort}`;
    const name = isDefaultEntry ? displayName : `${displayName} (${formatReasoningEffort(reasoningEffort)})`;

    return {
      requestModel: slug,
      reasoningEffort,
      info: {
        id: modelId,
        name,
        family: slug,
        version: `${versionBase}:${reasoningEffort}`,
        maxInputTokens,
        maxOutputTokens: config.maxOutputTokens,
        tooltip,
        detail: buildModelDetail(maxInputTokens, reasoningEffort, isDefaultEntry),
        capabilities: {
          imageInput,
          toolCalling: true
        }
      }
    };
  });
}

function getOrderedReasoningEfforts(model: UpstreamModel): ReasoningEffort[] {
  const defaultEffort = normalizeReasoningEffort(model.default_reasoning_level);
  const supportedEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map((level) => normalizeReasoningEffort((level as UpstreamReasoningLevel).effort))
        .filter((level): level is ReasoningEffort => level !== undefined)
    : [];

  const ordered: ReasoningEffort[] = [];
  if (defaultEffort) {
    ordered.push(defaultEffort);
  }

  for (const effort of supportedEfforts) {
    if (!ordered.includes(effort)) {
      ordered.push(effort);
    }
  }

  return ordered;
}

function getDiscoveredDisplayName(model: UpstreamModel, config: ProviderConfig): string {
  if (typeof model.display_name === 'string' && model.display_name.trim()) {
    return model.display_name.trim();
  }

  const slug = typeof model.slug === 'string' && model.slug.trim() ? model.slug.trim() : config.model;
  return getFallbackDisplayName(slug, config.displayName);
}

function getFallbackDisplayName(model: string, configuredDisplayName: string): string {
  const displayName = configuredDisplayName.trim();
  const legacyDefault = formatLegacyDisplayName(model);

  if (!displayName || displayName.toLowerCase() === 'codex model provider' || displayName === legacyDefault) {
    return formatDisplayName(model);
  }

  return displayName;
}

function formatDisplayName(model: string): string {
  const normalized = model.trim() || 'gpt-5.5';
  return normalized
    .replace(/^gpt/i, 'GPT')
    .replace(/codex/gi, 'Codex');
}

function formatLegacyDisplayName(model: string): string {
  const displayName = formatDisplayName(model);
  return /codex/i.test(displayName) ? displayName : `${displayName}-Codex`;
}

function getModelContextWindow(model: string, discoveredContextWindow: unknown, fallbackContextWindow: number): number {
  const fixedContextWindow = FIXED_MODEL_CONTEXT_WINDOWS[model];
  if (fixedContextWindow) {
    return fixedContextWindow;
  }

  return getPositiveInteger(discoveredContextWindow) ?? fallbackContextWindow;
}

function buildModelDetail(maxInputTokens: number, reasoningEffort?: ReasoningEffort, isDefaultEntry?: boolean): string {
  const parts = [`Context: ${formatTokenCount(maxInputTokens)}`];

  if (reasoningEffort) {
    const label = formatReasoningEffort(reasoningEffort);
    parts.push(isDefaultEntry ? `Reasoning: Default (${label})` : `Reasoning: ${label}`);
  }

  return parts.join(' | ');
}

function formatTokenCount(value: number): string {
  return `${value.toLocaleString()} tokens`;
}

function formatReasoningEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') {
    return 'XHigh';
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function isUpstreamModel(value: unknown): value is UpstreamModel {
  return typeof value === 'object' && value !== null;
}

function isModelVisible(model: UpstreamModel): boolean {
  if (model.supported_in_api === false) {
    return false;
  }

  if (typeof model.visibility === 'string' && model.visibility.trim().toLowerCase() === 'hidden') {
    return false;
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