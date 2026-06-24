import type { ResponseUsage } from 'openai/resources/responses/responses';
import * as vscode from 'vscode';
import { getProviderConfig, type ModelPricing } from './config';

const OFFICIAL_MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 }
};

type PricingSource = 'configured' | 'official';

interface UsageRecordEvent {
  model: string;
  usage: ResponseUsage;
  completedAt: number;
}

interface UsageSummary {
  model: string;
  completedAt: number;
  input: number;
  cachedInput: number;
  billableInput: number;
  output: number;
  reasoning: number;
  total: number;
  estimatedCostUsd?: number;
  pricing?: ModelPricing;
  pricingSource?: PricingSource;
}

export class UsageStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[];
  private lastUsage?: UsageRecordEvent;

  constructor(_context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.name = 'Codex Last Usage';
    this.statusBarItem.command = 'codexModelProvider.showLastUsage';
    this.statusBarItem.hide();

    this.disposables = [
      this.statusBarItem,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('codexModelProvider.showUsageInStatusBar') ||
          event.affectsConfiguration('codexModelProvider.modelPricingUsdPerMTok')
        ) {
          this.render();
        }
      })
    ];
  }

  record(event: UsageRecordEvent): void {
    this.lastUsage = event;
    this.render();
  }

  async showLastUsage(): Promise<void> {
    const summary = this.getLastSummary();

    if (!summary) {
      vscode.window.showInformationMessage('No completed Codex response usage is available yet.');
      return;
    }

    const detailLines = [
      `Model: ${summary.model}`,
      `Completed: ${new Date(summary.completedAt).toLocaleString()}`,
      `Total: ${formatTokenCount(summary.total)}`,
      `Input: ${formatTokenCount(summary.input)}`,
      `Cached input: ${formatTokenCount(summary.cachedInput)}`,
      `Billable input: ${formatTokenCount(summary.billableInput)}`,
      `Output: ${formatTokenCount(summary.output)}`,
      `Reasoning: ${formatTokenCount(summary.reasoning)}`
    ];

    if (summary.estimatedCostUsd !== undefined) {
      detailLines.splice(2, 0, `Estimated cost: ${formatUsd(summary.estimatedCostUsd, 6)}`);
    }

    await vscode.window.showInformationMessage(detailLines.join(' | '));
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private render(): void {
    const config = getProviderConfig();
    const summary = this.getLastSummary(config.modelPricingUsdPerMTok);

    if (!config.showUsageInStatusBar || !summary) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = buildStatusBarText(summary);
    this.statusBarItem.tooltip = buildTooltip(summary);
    this.statusBarItem.show();
  }

  private getLastSummary(modelPricing = getProviderConfig().modelPricingUsdPerMTok): UsageSummary | undefined {
    if (!this.lastUsage) {
      return undefined;
    }

    return summarizeUsage(this.lastUsage, resolvePricing(this.lastUsage.model, modelPricing));
  }
}

function summarizeUsage(
  event: UsageRecordEvent,
  pricingResolution: { pricing?: ModelPricing; source?: PricingSource }
): UsageSummary {
  const input = event.usage.input_tokens ?? 0;
  const cachedInput = event.usage.input_tokens_details?.cached_tokens ?? 0;
  const billableInput = Math.max(input - cachedInput, 0);
  const output = event.usage.output_tokens ?? 0;
  const reasoning = event.usage.output_tokens_details?.reasoning_tokens ?? 0;
  const total = event.usage.total_tokens ?? input + output;
  const estimatedCostUsd = calculateEstimatedCostUsd({ billableInput, cachedInput, output }, pricingResolution.pricing);

  return {
    model: event.model,
    completedAt: event.completedAt,
    input,
    cachedInput,
    billableInput,
    output,
    reasoning,
    total,
    estimatedCostUsd,
    pricing: pricingResolution.pricing,
    pricingSource: pricingResolution.source
  };
}

function resolvePricing(
  model: string,
  configuredPricing: Record<string, ModelPricing>
): { pricing?: ModelPricing; source?: PricingSource } {
  const normalizedModel = normalizeModelKey(model);
  const configured = Object.entries(configuredPricing).find(([configuredModel]) => normalizeModelKey(configuredModel) === normalizedModel)?.[1];

  if (configured) {
    return { pricing: configured, source: 'configured' };
  }

  const official = OFFICIAL_MODEL_PRICING[normalizedModel];
  if (official) {
    return { pricing: official, source: 'official' };
  }

  return {};
}

function calculateEstimatedCostUsd(
  usage: { billableInput: number; cachedInput: number; output: number },
  pricing: ModelPricing | undefined
): number | undefined {
  if (!pricing) {
    return undefined;
  }

  if (pricing.input === undefined && pricing.cachedInput === undefined && pricing.output === undefined) {
    return undefined;
  }

  return usage.billableInput / 1_000_000 * (pricing.input ?? 0)
    + usage.cachedInput / 1_000_000 * (pricing.cachedInput ?? 0)
    + usage.output / 1_000_000 * (pricing.output ?? 0);
}

function buildStatusBarText(summary: UsageSummary): string {
  const usageText = `I ${formatCompactTokenCount(summary.input)} C ${formatCompactTokenCount(summary.cachedInput)} O ${formatCompactTokenCount(summary.output)}`;

  if (summary.estimatedCostUsd === undefined) {
    return `Codex: ${usageText}`;
  }

  return `Codex: ${usageText} · ${formatUsd(summary.estimatedCostUsd, 3)}`;
}

function buildTooltip(summary: UsageSummary): string {
  const lines = [
    `Codex last usage`,
    `Model: ${summary.model}`,
    `Completed: ${new Date(summary.completedAt).toLocaleString()}`,
    `Input: ${formatTokenCount(summary.input)}`,
    `Cached input: ${formatTokenCount(summary.cachedInput)}`,
    `Billable input: ${formatTokenCount(summary.billableInput)}`,
    `Output: ${formatTokenCount(summary.output)}`,
    `Reasoning: ${formatTokenCount(summary.reasoning)}`,
    `Total: ${formatTokenCount(summary.total)}`
  ];

  if (summary.estimatedCostUsd !== undefined) {
    lines.splice(3, 0, `Estimated cost: ${formatUsd(summary.estimatedCostUsd, 6)}`);
  }

  if (summary.pricing) {
    lines.splice(
      summary.estimatedCostUsd !== undefined ? 4 : 3,
      0,
      `Pricing: ${summary.pricingSource === 'configured' ? 'Settings override' : 'Official API pricing'}`,
      `Rates per 1M: input ${formatUsd(summary.pricing.input ?? 0, 3)}, cached ${formatUsd(summary.pricing.cachedInput ?? 0, 3)}, output ${formatUsd(summary.pricing.output ?? 0, 3)}`
    );
  }

  lines.push('Click to view detailed usage.');

  return lines.join('\n');
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return formatCompactNumber(value / 1_000_000, 'M');
  }

  if (value >= 1_000) {
    return formatCompactNumber(value / 1_000, 'k');
  }

  return Math.round(value).toString();
}

function formatCompactNumber(value: number, suffix: string): string {
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${trimTrailingZeros(rounded)}${suffix}`;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatUsd(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Math.min(3, maximumFractionDigits),
    maximumFractionDigits
  }).format(value);
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0$/, '');
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase().replace(/[\s_]+/g, '-');
}