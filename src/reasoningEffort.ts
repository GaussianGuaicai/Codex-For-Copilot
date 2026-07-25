import type { Reasoning } from 'openai/resources/shared';

export const KNOWN_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const;

export type KnownReasoningEffort = typeof KNOWN_REASONING_EFFORTS[number];
export type ReasoningEffort = KnownReasoningEffort | (string & {});

export type ReasoningEffortSource =
  | 'modelConfiguration'
  | 'configuration'
  | 'modelOptions.reasoningEffort'
  | 'modelOptions.thinkingEffort'
  | 'modelOptions.reasoning.effort'
  | 'modelOptions.thinking.effort'
  | 'modelOptions.thinking'
  | 'default'
  | 'model'
  | 'none';

export interface ReasoningEffortInputOptions {
  readonly modelOptions?: Record<string, unknown>;
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
}

export interface ReasoningEffortResolution {
  effort: ReasoningEffort | undefined;
  source: ReasoningEffortSource;
  hasExplicitConflict: boolean;
}

const KNOWN_REASONING_EFFORT_SET = new Set<string>(KNOWN_REASONING_EFFORTS);

const REASONING_EFFORT_LABELS: Readonly<Record<KnownReasoningEffort, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Maximum',
  ultra: 'Ultra'
};

const REASONING_EFFORT_DESCRIPTIONS: Readonly<Record<KnownReasoningEffort, string>> = {
  none: 'Skip extra reasoning for the fastest replies when the model supports it.',
  minimal: 'Use a very light reasoning pass for small edits and quick follow-ups.',
  low: 'Fast responses with lighter reasoning.',
  medium: 'Balances speed and reasoning depth for everyday tasks.',
  high: 'Greater reasoning depth for complex problems.',
  xhigh: 'Extra high reasoning depth for complex problems.',
  max: 'Maximum reasoning depth for the hardest problems.',
  ultra: 'Maximum reasoning with automatic task delegation.'
};

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

export function normalizeKnownReasoningEffort(value: unknown): KnownReasoningEffort | undefined {
  const normalized = normalizeReasoningEffort(value);
  return normalized && KNOWN_REASONING_EFFORT_SET.has(normalized)
    ? normalized as KnownReasoningEffort
    : undefined;
}

export function getReasoningEffortLabel(effort: ReasoningEffort): string {
  const knownEffort = normalizeKnownReasoningEffort(effort);
  if (knownEffort) {
    return REASONING_EFFORT_LABELS[knownEffort];
  }

  const words = effort.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) {
    return effort;
  }

  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export function getReasoningEffortDescription(effort: ReasoningEffort): string {
  const knownEffort = normalizeKnownReasoningEffort(effort);
  if (knownEffort) {
    return REASONING_EFFORT_DESCRIPTIONS[knownEffort];
  }

  return `Use the ${getReasoningEffortLabel(effort)} reasoning effort advertised by the selected model.`;
}

export function resolveReasoningEffort(
  selectedReasoningEffort: ReasoningEffort | undefined,
  options: ReasoningEffortInputOptions,
  defaultReasoningEffort: ReasoningEffort | undefined
): ReasoningEffortResolution {
  const modelOptions = options.modelOptions;
  const thinking = modelOptions?.thinking;
  const nestedThinkingEffort = thinking && typeof thinking === 'object' && !Array.isArray(thinking)
    ? (thinking as { effort?: unknown }).effort
    : undefined;
  const explicitCandidates: Array<{ effort: ReasoningEffort | undefined; source: ReasoningEffortSource }> = [
    { effort: normalizeReasoningEffort(modelOptions?.reasoningEffort), source: 'modelOptions.reasoningEffort' },
    { effort: normalizeReasoningEffort(modelOptions?.thinkingEffort), source: 'modelOptions.thinkingEffort' },
    { effort: normalizeReasoningEffort((modelOptions?.reasoning as { effort?: unknown } | undefined)?.effort), source: 'modelOptions.reasoning.effort' },
    { effort: normalizeReasoningEffort(nestedThinkingEffort), source: 'modelOptions.thinking.effort' },
    { effort: normalizeReasoningEffort(modelOptions?.thinking), source: 'modelOptions.thinking' },
    { effort: normalizeReasoningEffort(options.modelConfiguration?.reasoningEffort), source: 'modelConfiguration' },
    { effort: normalizeReasoningEffort(options.configuration?.reasoningEffort), source: 'configuration' }
  ].filter((candidate): candidate is { effort: ReasoningEffort; source: ReasoningEffortSource } => candidate.effort !== undefined);
  const selected = explicitCandidates[0];
  const hasExplicitConflict = new Set(explicitCandidates.map((candidate) => candidate.effort)).size > 1;

  if (selected) {
    return { ...selected, hasExplicitConflict };
  }

  if (defaultReasoningEffort) {
    return { effort: defaultReasoningEffort, source: 'default', hasExplicitConflict };
  }

  if (selectedReasoningEffort) {
    return { effort: selectedReasoningEffort, source: 'model', hasExplicitConflict };
  }

  return { effort: undefined, source: 'none', hasExplicitConflict };
}

export function toResponsesReasoning(effort: ReasoningEffort): Reasoning {
  // Codex model catalogs can advertise efforts before the public SDK schema is regenerated.
  // Keep the forward-compatible wire value at this single typed boundary.
  return { effort } as Reasoning;
}
