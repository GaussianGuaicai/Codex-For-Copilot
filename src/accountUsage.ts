import { normalizeBaseURL } from './responsesClient';
import type { ApiCredentials } from './secrets';
import { codexFetch } from './auth/codexAuthRequest';

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10080;
const STALE_AFTER_MS = 15 * 60 * 1000;

export type RateLimitWindowKind = '5h' | 'weekly' | 'daily' | 'monthly' | 'annual' | 'other';

interface UsageBucketSource {
  limitId?: string;
  limitName?: string;
}

export interface RateLimitSnapshot extends UsageBucketSource {
  windowMinutes: number;
  usedPercent: number;
  remainingPercent: number;
  resetAt?: number;
}

export interface CreditBudgetSnapshot extends UsageBucketSource {
  total: number;
  used: number;
  remaining: number;
  remainingPercent: number;
  resetAt?: number;
}

export interface CodexAccountUsageSnapshot {
  fetchedAt: number;
  planType?: string;
  creditsBalance?: number;
  creditBudgets: CreditBudgetSnapshot[];
  limits: RateLimitSnapshot[];
}

export interface AccountUsageDisplay {
  compactText?: string;
  tooltip: string;
  isStale: boolean;
}

type AccountUsageDisplayMetric =
  | { kind: 'creditBudget'; creditBudget: CreditBudgetSnapshot }
  | { kind: 'rateWindows'; limits: RateLimitSnapshot[] }
  | { kind: 'creditBalance'; creditsBalance: number }
  | { kind: 'none' };

export async function fetchCodexAccountUsage(options: {
  baseURL: string;
  credentials: ApiCredentials;
  selectedModel: string;
  signal?: AbortSignal;
}): Promise<CodexAccountUsageSnapshot> {
  if (options.credentials.kind !== 'codexAccessToken') {
    throw new Error('Codex account usage can only be queried with ~/.codex/auth.json access token credentials.');
  }

  const errors: string[] = [];
  for (const usageURL of getCodexAccountUsageURLs(options.baseURL)) {
    const requestInit = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...options.credentials.headers
      },
      signal: options.signal
    };
    const response = options.credentials.authManager
      ? await codexFetch(options.credentials.authManager, usageURL, requestInit)
      : await fetch(usageURL, {
          ...requestInit,
          headers: {
            Authorization: `Bearer ${options.credentials.apiKey}`,
            ...requestInit.headers
          }
        });

    if (!response.ok) {
      errors.push(`${usageURL}: ${response.status} ${response.statusText}`);
      continue;
    }

    return parseCodexAccountUsage(await response.json(), Date.now(), options.selectedModel);
  }

  throw new Error(`Codex account usage request failed. ${errors.join(' | ')}`);
}

export function getCodexAccountUsageURLs(baseURL: string): string[] {
  const normalizedRoot = normalizeAccountUsageBaseURL(baseURL);

  try {
    const url = new URL(normalizedRoot);
    const path = url.pathname.replace(/\/+$/, '');
    return path.toLowerCase().includes('/backend-api')
      ? [withPath(url, `${path}/wham/usage`)]
      : [withPath(url, `${path}/api/codex/usage`)];
  } catch {
    return unique([
      `${normalizedRoot}/wham/usage`,
      `${normalizedRoot}/api/codex/usage`
    ]);
  }
}

export function parseCodexAccountUsage(payload: unknown, fetchedAt: number, selectedModel: string): CodexAccountUsageSnapshot {
  const root = getUsageRoot(payload);
  const limits: RateLimitSnapshot[] = [];
  const creditBudgets: CreditBudgetSnapshot[] = [];

  const mainLimit = root.rate_limits ?? root.rateLimits ?? root.rate_limit ?? root.rateLimit;
  limits.push(...parseRateLimitSnapshots(mainLimit, fetchedAt, { limitId: 'codex' }));
  creditBudgets.push(...parseCreditBudgetSnapshots(mainLimit, fetchedAt, { limitId: 'codex' }));

  const spendControl = root.spend_control ?? root.spendControl;
  creditBudgets.push(...parseSpendControlCreditBudgetSnapshots(spendControl, fetchedAt));

  const byLimitId = root.rate_limits_by_limit_id ?? root.rateLimitsByLimitId;
  if (isObjectRecord(byLimitId)) {
    for (const [limitId, limit] of Object.entries(byLimitId)) {
      limits.push(...parseRateLimitSnapshots(limit, fetchedAt, { limitId }));
      creditBudgets.push(...parseCreditBudgetSnapshots(limit, fetchedAt, { limitId }));
    }
  }

  for (const additionalLimit of getRateLimitCollection(root.additional_rate_limits ?? root.additionalRateLimits)) {
    limits.push(...parseAdditionalRateLimitSnapshots(additionalLimit, fetchedAt));
    creditBudgets.push(...parseAdditionalCreditBudgetSnapshots(additionalLimit, fetchedAt));
  }

  return {
    fetchedAt,
    planType: parsePlanType(root),
    creditsBalance: parseCreditsBalance(root),
    creditBudgets: sortCreditBudgetsForDisplay(dedupeCreditBudgets(creditBudgets), selectedModel),
    limits: sortLimitsForDisplay(dedupeLimits(limits), selectedModel)
  };
}

export function buildCodexAccountUsageDisplay(
  snapshot: CodexAccountUsageSnapshot,
  selectedModel: string,
  now = Date.now()
): AccountUsageDisplay {
  const metric = selectAccountUsageDisplayMetric(snapshot, selectedModel);

  return {
    compactText: formatCompactText(metric),
    tooltip: buildTooltip(snapshot, metric, now),
    isStale: now - snapshot.fetchedAt > STALE_AFTER_MS
  };
}

export function selectAccountUsageDisplayMetric(
  snapshot: CodexAccountUsageSnapshot,
  selectedModel: string
): AccountUsageDisplayMetric {
  const creditBudget = selectPreferredCreditBudget(snapshot.creditBudgets, selectedModel);
  if (creditBudget) {
    return { kind: 'creditBudget', creditBudget };
  }

  const limits = selectDisplayRateWindows(snapshot.limits, selectedModel);
  if (limits.length > 0) {
    return { kind: 'rateWindows', limits };
  }

  if (snapshot.creditsBalance !== undefined) {
    return { kind: 'creditBalance', creditsBalance: snapshot.creditsBalance };
  }

  return { kind: 'none' };
}

export function classifyWindow(windowMinutes: number): RateLimitWindowKind {
  if (isApproximately(windowMinutes, FIVE_HOUR_WINDOW_MINUTES, 10)) {
    return '5h';
  }

  if (isApproximately(windowMinutes, WEEKLY_WINDOW_MINUTES, 120)) {
    return 'weekly';
  }

  if (isApproximately(windowMinutes, 1440, 60)) {
    return 'daily';
  }

  if (isApproximately(windowMinutes, 43200, 1440)) {
    return 'monthly';
  }

  if (isApproximately(windowMinutes, 525600, 14400)) {
    return 'annual';
  }

  return 'other';
}

function getUsageRoot(payload: unknown): Record<string, unknown> {
  if (!isObjectRecord(payload)) {
    return {};
  }

  if (isObjectRecord(payload.usage)) {
    return payload.usage;
  }

  if (isObjectRecord(payload.data)) {
    return payload.data;
  }

  return payload;
}

function parseRateLimitSnapshots(
  value: unknown,
  fetchedAt: number,
  defaults: { limitId?: string; limitName?: string } = {}
): RateLimitSnapshot[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseRateLimitSnapshots(entry, fetchedAt, defaults));
  }

  if (!isObjectRecord(value)) {
    return [];
  }

  const limitId = parseOptionalString(value.limitId ?? value.limit_id ?? value.id ?? value.key) ?? defaults.limitId;
  const limitName = parseOptionalString(value.limitName ?? value.limit_name ?? value.name ?? value.display_name ?? value.model ?? value.model_slug) ?? defaults.limitName;
  const windowValues = [
    value.primary_window ?? value.primaryWindow ?? value.primary,
    value.secondary_window ?? value.secondaryWindow ?? value.secondary
  ];
  const windowSnapshots = windowValues
    .flatMap((window) => parseRateLimitSnapshots(window, fetchedAt, { limitId, limitName }));

  if (windowSnapshots.length > 0) {
    return windowSnapshots;
  }

  const single = parseRateLimit(value, fetchedAt, { limitId, limitName });
  return single ? [single] : [];
}

function parseAdditionalRateLimitSnapshots(value: unknown, fetchedAt: number): RateLimitSnapshot[] {
  if (!isObjectRecord(value)) {
    return [];
  }

  const limitId = parseOptionalString(value.metered_feature ?? value.meteredFeature ?? value.limitId ?? value.limit_id ?? value.id);
  const limitName = parseOptionalString(value.limit_name ?? value.limitName ?? value.name ?? value.display_name);
  return parseRateLimitSnapshots(value.rate_limit ?? value.rateLimit ?? value, fetchedAt, { limitId, limitName });
}

function parseCreditBudgetSnapshots(
  value: unknown,
  fetchedAt: number,
  defaults: UsageBucketSource = {}
): CreditBudgetSnapshot[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseCreditBudgetSnapshots(entry, fetchedAt, defaults));
  }

  if (!isObjectRecord(value)) {
    return [];
  }

  const limitId = parseOptionalString(value.limitId ?? value.limit_id ?? value.id ?? value.key) ?? defaults.limitId;
  const limitName = parseOptionalString(value.limitName ?? value.limit_name ?? value.name ?? value.display_name ?? value.model ?? value.model_slug) ?? defaults.limitName;
  const creditBudget = parseCreditBudget(value.individual_limit ?? value.individualLimit, fetchedAt, { limitId, limitName });
  return creditBudget ? [creditBudget] : [];
}

function parseAdditionalCreditBudgetSnapshots(value: unknown, fetchedAt: number): CreditBudgetSnapshot[] {
  if (!isObjectRecord(value)) {
    return [];
  }

  const limitId = parseOptionalString(value.metered_feature ?? value.meteredFeature ?? value.limitId ?? value.limit_id ?? value.id);
  const limitName = parseOptionalString(value.limit_name ?? value.limitName ?? value.name ?? value.display_name);
  return parseCreditBudgetSnapshots(value.rate_limit ?? value.rateLimit ?? value, fetchedAt, { limitId, limitName });
}

function parseSpendControlCreditBudgetSnapshots(value: unknown, fetchedAt: number): CreditBudgetSnapshot[] {
  if (!isObjectRecord(value)) {
    return [];
  }

  const individualLimit = value.individual_limit ?? value.individualLimit;
  const limitName = isObjectRecord(individualLimit)
    ? parseOptionalString(individualLimit.source)
    : undefined;
  const creditBudget = parseCreditBudget(individualLimit, fetchedAt, {
    limitId: 'workspace-spend-control',
    limitName
  });
  return creditBudget ? [creditBudget] : [];
}

function parseRateLimit(
  value: unknown,
  fetchedAt: number,
  defaults: { limitId?: string; limitName?: string } = {}
): RateLimitSnapshot | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const windowMinutes = parseWindowMinutes(value);
  const usedPercent = parseUsedPercent(value);

  if (windowMinutes === undefined || usedPercent === undefined) {
    return undefined;
  }

  return {
    limitId: parseOptionalString(value.limitId ?? value.limit_id ?? value.id ?? value.key) ?? defaults.limitId,
    limitName: parseOptionalString(value.limitName ?? value.limit_name ?? value.name ?? value.display_name ?? value.model ?? value.model_slug) ?? defaults.limitName,
    windowMinutes,
    usedPercent,
    remainingPercent: clamp(100 - usedPercent, 0, 100),
    resetAt: parseResetAt(value, fetchedAt)
  };
}

function parseCreditBudget(
  value: unknown,
  fetchedAt: number,
  defaults: UsageBucketSource = {}
): CreditBudgetSnapshot | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const total = parseFiniteNumber(value.limit ?? value.total ?? value.quota ?? value.max);
  if (total === undefined || total <= 0) {
    return undefined;
  }

  const reportedUsed = parseFiniteNumber(value.used ?? value.usage ?? value.consumed);
  const reportedRemainingPercent = parsePercentNumber(value.remainingPercent ?? value.remaining_percent);
  let used: number;
  let remainingPercent: number;

  if (reportedUsed !== undefined) {
    if (reportedUsed < 0 || reportedUsed > total) {
      return undefined;
    }

    used = reportedUsed;
    const calculatedRemainingPercent = (total - used) / total * 100;
    if (reportedRemainingPercent !== undefined && Math.abs(reportedRemainingPercent - calculatedRemainingPercent) > 1) {
      return undefined;
    }

    remainingPercent = reportedRemainingPercent ?? calculatedRemainingPercent;
  } else if (reportedRemainingPercent !== undefined) {
    remainingPercent = reportedRemainingPercent;
    used = total * (1 - remainingPercent / 100);
  } else {
    return undefined;
  }

  return {
    limitId: defaults.limitId,
    limitName: defaults.limitName,
    total,
    used,
    remaining: total - used,
    remainingPercent,
    resetAt: parseResetAt(value, fetchedAt)
  };
}

function parseWindowMinutes(value: Record<string, unknown>): number | undefined {
  const direct = parseFiniteNumber(
    value.windowMinutes ?? value.window_minutes ?? value.windowDurationMins ?? value.window_duration_mins ?? value.durationMinutes ?? value.duration_minutes ?? value.period_minutes
  );
  if (direct !== undefined && direct > 0) {
    return direct;
  }

  const seconds = parseFiniteNumber(
    value.windowSeconds ?? value.window_seconds ?? value.limitWindowSeconds ?? value.limit_window_seconds ?? value.durationSeconds ?? value.duration_seconds ?? value.period_seconds
  );
  if (seconds !== undefined && seconds > 0) {
    return seconds / 60;
  }

  const label = parseOptionalString(value.window ?? value.period ?? value.interval);
  return label ? parseWindowLabelMinutes(label) : undefined;
}

function parseUsedPercent(value: Record<string, unknown>): number | undefined {
  const direct = parsePercentNumber(
    value.usedPercent ?? value.used_percent ?? value.usagePercent ?? value.usage_percent ?? value.percentUsed ?? value.percent_used
  );
  if (direct !== undefined) {
    return direct;
  }

  const remainingPercent = parsePercentNumber(value.remainingPercent ?? value.remaining_percent);
  if (remainingPercent !== undefined) {
    return clamp(100 - remainingPercent, 0, 100);
  }

  const used = parseFiniteNumber(value.used ?? value.usage ?? value.consumed);
  const limit = parseFiniteNumber(value.limit ?? value.quota ?? value.total ?? value.max);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return clamp(used / limit * 100, 0, 100);
  }

  const remaining = parseFiniteNumber(value.remaining ?? value.available);
  if (remaining !== undefined && limit !== undefined && limit > 0) {
    return clamp((limit - remaining) / limit * 100, 0, 100);
  }

  return undefined;
}

function parseResetAt(value: Record<string, unknown>, fetchedAt: number): number | undefined {
  const resetAt = value.resetAt ?? value.reset_at ?? value.resetsAt ?? value.resets_at ?? value.reset;
  if (typeof resetAt === 'string' && resetAt.trim()) {
    const parsed = Date.parse(resetAt.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const numericResetAt = parseFiniteNumber(resetAt);
  if (numericResetAt !== undefined) {
    return numericResetAt < 10_000_000_000 ? numericResetAt * 1000 : numericResetAt;
  }

  const resetAfterSeconds = parseFiniteNumber(
    value.resetAfterSeconds ?? value.reset_after_seconds ?? value.secondsUntilReset ?? value.seconds_until_reset
  );
  if (resetAfterSeconds !== undefined && resetAfterSeconds >= 0) {
    return fetchedAt + resetAfterSeconds * 1000;
  }

  return undefined;
}

function parsePlanType(root: Record<string, unknown>): string | undefined {
  const direct = parseOptionalString(root.planType ?? root.plan_type ?? root.plan);
  if (direct) {
    return direct;
  }

  const plan = root.plan;
  if (isObjectRecord(plan)) {
    return parseOptionalString(plan.type ?? plan.name ?? plan.display_name);
  }

  const subscription = root.subscription;
  if (isObjectRecord(subscription)) {
    return parseOptionalString(subscription.planType ?? subscription.plan_type ?? subscription.plan ?? subscription.tier);
  }

  return undefined;
}

function parseCreditsBalance(root: Record<string, unknown>): number | undefined {
  const direct = parseFiniteNumber(root.creditsBalance ?? root.credits_balance ?? root.creditBalance ?? root.credit_balance ?? root.balance);
  if (direct !== undefined && direct >= 0) {
    return direct;
  }

  const credits = root.credits ?? root.credit;
  if (typeof credits === 'number') {
    return Number.isFinite(credits) && credits >= 0 ? credits : undefined;
  }

  if (isObjectRecord(credits)) {
    const nested = parseFiniteNumber(credits.balance ?? credits.remaining ?? credits.available ?? credits.amount);
    return nested !== undefined && nested >= 0 ? nested : undefined;
  }

  return undefined;
}

function getRateLimitCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (isObjectRecord(value)) {
    return Object.values(value);
  }

  return [];
}

function dedupeLimits(limits: RateLimitSnapshot[]): RateLimitSnapshot[] {
  const seen = new Set<string>();
  const deduped: RateLimitSnapshot[] = [];

  for (const limit of limits) {
    const key = [limit.limitId ?? '', limit.limitName ?? '', limit.windowMinutes, limit.usedPercent, limit.resetAt ?? ''].join('|');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(limit);
  }

  return deduped;
}

function dedupeCreditBudgets(creditBudgets: CreditBudgetSnapshot[]): CreditBudgetSnapshot[] {
  const seen = new Set<string>();
  const deduped: CreditBudgetSnapshot[] = [];

  for (const creditBudget of creditBudgets) {
    const key = [
      creditBudget.limitId ?? '',
      creditBudget.limitName ?? '',
      creditBudget.total,
      creditBudget.used,
      creditBudget.remainingPercent,
      creditBudget.resetAt ?? ''
    ].join('|');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(creditBudget);
  }

  return deduped;
}

function selectPreferredCreditBudget(
  creditBudgets: readonly CreditBudgetSnapshot[],
  selectedModel: string
): CreditBudgetSnapshot | undefined {
  return [...creditBudgets].sort((left, right) => compareCreditBudgetPreference(left, right, selectedModel))[0];
}

function selectDisplayRateWindows(
  limits: readonly RateLimitSnapshot[],
  selectedModel: string
): RateLimitSnapshot[] {
  const seenWindowMinutes = new Set<number>();
  const selected: RateLimitSnapshot[] = [];
  const rankedLimits = [...limits].sort((left, right) => {
    return compareUsageBucketPreference(left, right, selectedModel)
      || left.windowMinutes - right.windowMinutes
      || right.usedPercent - left.usedPercent;
  });

  for (const limit of rankedLimits) {
    const windowMinutes = Math.round(limit.windowMinutes);
    if (seenWindowMinutes.has(windowMinutes)) {
      continue;
    }

    seenWindowMinutes.add(windowMinutes);
    selected.push(limit);
    if (selected.length === 2) {
      break;
    }
  }

  return selected;
}

function compareLimitPreference(left: RateLimitSnapshot, right: RateLimitSnapshot, selectedModel: string): number {
  return compareUsageBucketPreference(left, right, selectedModel)
    || right.usedPercent - left.usedPercent;
}

function compareCreditBudgetPreference(
  left: CreditBudgetSnapshot,
  right: CreditBudgetSnapshot,
  selectedModel: string
): number {
  return compareUsageBucketPreference(left, right, selectedModel)
    || Number(Boolean(right.resetAt)) - Number(Boolean(left.resetAt));
}

function compareUsageBucketPreference(left: UsageBucketSource, right: UsageBucketSource, selectedModel: string): number {
  return scoreUsageBucket(right, selectedModel) - scoreUsageBucket(left, selectedModel);
}

function scoreUsageBucket(limit: UsageBucketSource, selectedModel: string): number {
  let score = 0;
  if (normalizeComparable(limit.limitId) === 'workspace-spend-control') {
    score += 8;
  } else if (normalizeComparable(limit.limitId) === 'codex') {
    score += 4;
  }

  if (isLimitRelatedToModel(limit, selectedModel)) {
    score += 2;
  }

  return score;
}

function isLimitRelatedToModel(limit: UsageBucketSource, selectedModel: string): boolean {
  const normalizedModel = normalizeComparable(selectedModel);
  const normalizedName = normalizeComparable(limit.limitName);
  return Boolean(normalizedModel && normalizedName && (normalizedName.includes(normalizedModel) || normalizedModel.includes(normalizedName)));
}

function sortCreditBudgetsForDisplay(creditBudgets: CreditBudgetSnapshot[], selectedModel: string): CreditBudgetSnapshot[] {
  return [...creditBudgets].sort((left, right) => compareCreditBudgetPreference(left, right, selectedModel));
}

function sortLimitsForDisplay(limits: RateLimitSnapshot[], selectedModel: string): RateLimitSnapshot[] {
  return [...limits].sort((left, right) => {
    const leftKindOrder = getWindowKindOrder(classifyWindow(left.windowMinutes));
    const rightKindOrder = getWindowKindOrder(classifyWindow(right.windowMinutes));
    return leftKindOrder - rightKindOrder || compareLimitPreference(left, right, selectedModel);
  });
}

function formatCompactText(metric: AccountUsageDisplayMetric): string | undefined {
  switch (metric.kind) {
    case 'creditBudget':
      return `Codex: Credits ${formatPercent(metric.creditBudget.remainingPercent)} · ${formatCreditAmount(metric.creditBudget.remaining)}/${formatCreditAmount(metric.creditBudget.total)}`;
    case 'rateWindows':
      return `Codex: ${metric.limits.map((limit) => `${formatWindowLabel(limit.windowMinutes)} ${formatPercent(limit.remainingPercent)}`).join(' · ')}`;
    case 'creditBalance':
      return `Codex: ${formatCredits(metric.creditsBalance)}`;
    case 'none':
      return undefined;
  }
}

function buildTooltip(
  snapshot: CodexAccountUsageSnapshot,
  metric: AccountUsageDisplayMetric,
  now: number
): string {
  const lines = ['Codex account limits'];

  lines.push(`Plan: ${snapshot.planType ?? 'Unknown'}`);
  lines.push(`Fetched: ${new Date(snapshot.fetchedAt).toLocaleString()}`);

  if (now - snapshot.fetchedAt > STALE_AFTER_MS) {
    lines.push('Warning: usage data is older than 15 minutes.');
  }

  if (metric.kind === 'creditBudget') {
    lines.push(`Credit budget: ${formatCreditBudgetDetail(metric.creditBudget)}`);
  } else if (metric.kind === 'rateWindows') {
    for (const limit of metric.limits) {
      lines.push(`${formatWindowLabel(limit.windowMinutes)}: ${formatLimitDetail(limit)}`);
    }
  } else if (metric.kind === 'creditBalance') {
    lines.push(`Credits balance: ${formatCredits(metric.creditsBalance)}`);
  }

  if (snapshot.creditsBalance !== undefined && metric.kind !== 'creditBalance') {
    lines.push(`Credits balance: ${formatCredits(snapshot.creditsBalance)}`);
  }

  const selectedCreditBudgets = metric.kind === 'creditBudget'
    ? new Set([metric.creditBudget])
    : new Set<CreditBudgetSnapshot>();
  const otherCreditBudgets = snapshot.creditBudgets.filter((creditBudget) => !selectedCreditBudgets.has(creditBudget));
  if (otherCreditBudgets.length > 0) {
    lines.push('Other credit budgets:');
    for (const creditBudget of otherCreditBudgets) {
      lines.push(`- ${formatCreditBudgetDetail(creditBudget)}`);
    }
  }

  const selectedLimits = metric.kind === 'rateWindows'
    ? new Set(metric.limits)
    : new Set<RateLimitSnapshot>();
  const otherLimits = snapshot.limits.filter((limit) => !selectedLimits.has(limit));
  if (otherLimits.length > 0) {
    lines.push('Other rate limits:');
    for (const limit of otherLimits) {
      lines.push(`- ${formatWindowLabel(limit.windowMinutes)}: ${formatLimitDetail(limit)}`);
    }
  }

  lines.push('Click to refresh account limits.');
  return lines.join('\n');
}

function formatLimitDetail(limit: RateLimitSnapshot): string {
  const parts = [
    `${formatPercent(limit.remainingPercent)} remaining`,
    `${formatPercent(limit.usedPercent)} used`
  ];

  if (limit.resetAt) {
    parts.push(`resets ${new Date(limit.resetAt).toLocaleString()}`);
  }

  if (limit.limitName) {
    parts.push(limit.limitName);
  }

  return parts.join(' · ');
}

function formatCreditBudgetDetail(creditBudget: CreditBudgetSnapshot): string {
  const parts = [
    `${formatCreditAmount(creditBudget.remaining)} / ${formatCreditAmount(creditBudget.total)} credits remaining`,
    `${formatCreditAmount(creditBudget.used)} credits used`,
    `${formatPercent(creditBudget.remainingPercent)} remaining`
  ];

  if (creditBudget.resetAt) {
    parts.push(`resets ${new Date(creditBudget.resetAt).toLocaleString()}`);
  }

  if (creditBudget.limitName) {
    parts.push(creditBudget.limitName);
  }

  return parts.join(' · ');
}

function formatWindowLabel(windowMinutes: number): string {
  switch (classifyWindow(windowMinutes)) {
    case '5h':
      return '5h';
    case 'weekly':
      return 'Weekly';
    case 'daily':
      return 'Daily';
    case 'annual':
      return 'Annual';
    default:
      return formatDuration(windowMinutes);
  }
}

function formatPercent(value: number): string {
  return `${Math.round(clamp(value, 0, 100))}%`;
}

function formatCredits(value: number): string {
  return `${formatCreditAmount(value)} credits`;
}

function formatCreditAmount(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

function formatDuration(windowMinutes: number): string {
  const roundedMinutes = Math.round(windowMinutes);
  if (roundedMinutes >= 1440 && roundedMinutes % 1440 === 0) {
    return `${roundedMinutes / 1440}d`;
  }

  if (roundedMinutes >= 60 && roundedMinutes % 60 === 0) {
    return `${roundedMinutes / 60}h`;
  }

  return `${roundedMinutes}m`;
}

function parsePercentNumber(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value);
  if (parsed === undefined) {
    return undefined;
  }

  return clamp(parsed > 0 && parsed < 1 ? parsed * 100 : parsed, 0, 100);
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseWindowLabelMinutes(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|yr|year|years)$/.exec(normalized);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  switch (match[2]) {
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      return amount;
    case 'h':
    case 'hr':
    case 'hour':
    case 'hours':
      return amount * 60;
    case 'd':
    case 'day':
    case 'days':
      return amount * 1440;
    case 'w':
    case 'week':
    case 'weeks':
      return amount * WEEKLY_WINDOW_MINUTES;
    case 'mo':
    case 'month':
    case 'months':
      return amount * 43200;
    default:
      return amount * 525600;
  }
}

function getWindowKindOrder(kind: RateLimitWindowKind): number {
  switch (kind) {
    case '5h':
      return 0;
    case 'weekly':
      return 1;
    case 'daily':
      return 2;
    case 'monthly':
      return 3;
    case 'annual':
      return 4;
    default:
      return 5;
  }
}

function isApproximately(value: number, expected: number, tolerance: number): boolean {
  return Math.abs(value - expected) <= tolerance;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeComparable(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function normalizeAccountUsageBaseURL(baseURL: string): string {
  try {
    const url = new URL(normalizeBaseURL(baseURL));
    let path = url.pathname.replace(/\/+$/, '');

    if ((url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') && !path.toLowerCase().includes('/backend-api')) {
      path = `${path}/backend-api`;
    }

    path = path
      .replace(/\/backend-api\/codex$/i, '/backend-api')
      .replace(/\/api\/codex$/i, '');

    url.pathname = path || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return normalizeBaseURL(baseURL)
      .replace(/\/backend-api\/codex$/i, '/backend-api')
      .replace(/\/api\/codex$/i, '')
      .replace(/\/+$/, '');
  }
}

function withPath(url: URL, pathname: string): string {
  const next = new URL(url.toString());
  next.pathname = pathname;
  next.search = '';
  next.hash = '';
  return next.toString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}