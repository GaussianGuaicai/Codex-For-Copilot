import type {
  ResponseFunctionWebSearch,
  ResponseOutputText,
  ResponsesServerEvent
} from 'openai/resources/responses/responses';
import type { WebSearchConfig } from '../config';

export interface HostedToolLifecycleEvent {
  tool: 'web_search';
  phase: 'in_progress' | 'searching' | 'completed';
  itemId: string;
  outputIndex: number;
  sequenceNumber: number;
}

export interface WebSearchSource {
  url: string;
  title?: string;
}

export interface WebSearchActivity {
  itemId: string;
  action: ResponseFunctionWebSearch['action'];
  sources: WebSearchSource[];
}

export interface WebSearchStatusPresentation {
  value: string;
  itemId: string;
  actionType?: ResponseFunctionWebSearch['action']['type'];
}

export class WebSearchStatusPresenter {
  private readonly reportedItemIds = new Set<string>();
  private readonly completedLifecycleItemIds = new Set<string>();

  constructor(
    private readonly settings: Pick<WebSearchConfig, 'statusDetail' | 'statusMaxSources'>
  ) {}

  present(item: unknown): WebSearchStatusPresentation | undefined {
    const activity = projectWebSearchActivity(item);
    if (!activity || this.reportedItemIds.has(activity.itemId)) {
      return undefined;
    }
    this.completedLifecycleItemIds.delete(activity.itemId);
    this.reportedItemIds.add(activity.itemId);
    return {
      value: formatWebSearchActivity(activity, this.settings),
      itemId: activity.itemId,
      actionType: activity.action.type
    };
  }

  noteCompletedLifecycle(event: HostedToolLifecycleEvent): boolean {
    if (event.phase !== 'completed'
      || this.reportedItemIds.has(event.itemId)
      || this.completedLifecycleItemIds.has(event.itemId)) {
      return false;
    }
    this.completedLifecycleItemIds.add(event.itemId);
    return true;
  }

  presentLifecycleFallback(itemId: string): WebSearchStatusPresentation | undefined {
    if (!this.completedLifecycleItemIds.delete(itemId) || this.reportedItemIds.has(itemId)) {
      return undefined;
    }
    this.reportedItemIds.add(itemId);
    return {
      value: '**Searched the web**',
      itemId
    };
  }

  reset(): void {
    this.reportedItemIds.clear();
    this.completedLifecycleItemIds.clear();
  }
}

export function projectWebSearchActivity(item: unknown): WebSearchActivity | undefined {
  if (!isRecord(item)
    || item.type !== 'web_search_call'
    || item.status !== 'completed'
    || !isNonEmptyString(item.id)
    || !isWebSearchAction(item.action)) {
    return undefined;
  }
  return {
    itemId: item.id,
    action: structuredClone(item.action),
    sources: extractWebSearchSources(item)
  };
}

export function formatWebSearchActivity(
  activity: WebSearchActivity,
  settings: Pick<WebSearchConfig, 'statusDetail' | 'statusMaxSources'>
): string {
  if (settings.statusDetail === 'compact') {
    return '**Searched the web**';
  }

  const { action } = activity;
  if (action.type === 'open_page') {
    return action.url && isHttpURL(action.url)
      ? `**Opened a web page** · ${formatURLLink(action.url)}`
      : '**Opened a web page**';
  }
  if (action.type === 'find_in_page') {
    return `**Searched within a web page** · “${escapeMarkdownText(truncateInline(action.pattern, 160))}” · ${formatURLLink(action.url)}`;
  }

  const queries = [...new Set([
    ...(action.queries ?? []),
    ...(action.query ? [action.query] : [])
  ].map((query) => query.trim()).filter(Boolean))];
  const shownQueries = queries.slice(0, 3).map((query) => `“${escapeMarkdownText(truncateInline(query, 160))}”`);
  const querySuffix = shownQueries.length > 0
    ? ` · ${shownQueries.join(' · ')}${queries.length > shownQueries.length ? ` · +${queries.length - shownQueries.length} queries` : ''}`
    : '';
  const sourceSuffix = settings.statusDetail === 'actionsAndSources'
    ? formatInlineSources(activity.sources, settings.statusMaxSources)
    : '';
  return `**Searched the web**${querySuffix}${sourceSuffix}`;
}

export function projectHostedToolLifecycleEvent(
  event: ResponsesServerEvent
): HostedToolLifecycleEvent | undefined {
  switch (event.type) {
    case 'response.web_search_call.in_progress':
      return toWebSearchLifecycleEvent(event, 'in_progress');
    case 'response.web_search_call.searching':
      return toWebSearchLifecycleEvent(event, 'searching');
    case 'response.web_search_call.completed':
      return toWebSearchLifecycleEvent(event, 'completed');
    default:
      return undefined;
  }
}

export function extractWebSearchSources(item: unknown): WebSearchSource[] {
  if (!isRecord(item)) {
    return [];
  }

  if (item.type === 'web_search_call') {
    const action = isRecord(item.action) ? item.action : undefined;
    if (action?.type !== 'search' || !Array.isArray(action.sources)) {
      return [];
    }
    return action.sources.flatMap((source) => {
      if (!isRecord(source) || source.type !== 'url' || !isHttpURL(source.url)) {
        return [];
      }
      return [{ url: source.url }];
    });
  }

  if (item.type !== 'message' || !Array.isArray(item.content)) {
    return [];
  }
  return item.content.flatMap((content) => extractOutputTextSources(content));
}

export function projectWebSearchReplayItem(item: unknown): ResponseFunctionWebSearch | undefined {
  if (!isRecord(item)
    || item.type !== 'web_search_call'
    || !isNonEmptyString(item.id)
    || item.status !== 'completed'
    || !isWebSearchAction(item.action)) {
    return undefined;
  }
  return {
    type: 'web_search_call',
    id: item.id,
    status: 'completed',
    action: structuredClone(item.action)
  } as ResponseFunctionWebSearch;
}

function toWebSearchLifecycleEvent(
  event: Extract<ResponsesServerEvent, { item_id: string; output_index: number; sequence_number: number }>,
  phase: HostedToolLifecycleEvent['phase']
): HostedToolLifecycleEvent {
  return {
    tool: 'web_search',
    phase,
    itemId: event.item_id,
    outputIndex: event.output_index,
    sequenceNumber: event.sequence_number
  };
}

function extractOutputTextSources(content: unknown): WebSearchSource[] {
  if (!isRecord(content) || content.type !== 'output_text' || !Array.isArray(content.annotations)) {
    return [];
  }
  return content.annotations.flatMap((annotation) => {
    if (!isRecord(annotation)
      || annotation.type !== 'url_citation'
      || !isHttpURL(annotation.url)) {
      return [];
    }
    const citation = annotation as unknown as ResponseOutputText.URLCitation;
    return [{
      url: citation.url,
      ...(isNonEmptyString(citation.title) ? { title: citation.title } : {})
    }];
  });
}

function isWebSearchAction(value: unknown): value is ResponseFunctionWebSearch['action'] {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'search') {
    return (value.query === undefined || typeof value.query === 'string')
      && (value.queries === undefined || (Array.isArray(value.queries) && value.queries.every((query) => typeof query === 'string')))
      && (value.sources === undefined || (Array.isArray(value.sources) && value.sources.every((source) => (
        isRecord(source) && source.type === 'url' && isHttpURL(source.url)
      ))));
  }
  if (value.type === 'open_page') {
    return value.url === undefined || value.url === null || isHttpURL(value.url);
  }
  return value.type === 'find_in_page'
    && typeof value.pattern === 'string'
    && isHttpURL(value.url);
}

function isHttpURL(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatInlineSources(sources: readonly WebSearchSource[], maxSources: number): string {
  if (maxSources <= 0) {
    return '';
  }
  const urls = [...new Set(sources.map((source) => source.url).filter(isHttpURL))];
  if (urls.length === 0) {
    return '';
  }
  const shown = urls.slice(0, maxSources).map(formatURLLink);
  return ` · ${shown.join(' · ')}${urls.length > shown.length ? ` · +${urls.length - shown.length} sources` : ''}`;
}

function formatURLLink(value: string): string {
  const url = new URL(value);
  const path = url.pathname === '/' ? '' : truncateInline(url.pathname, 48);
  return `[${escapeMarkdownText(`${url.hostname}${path}`)}](<${url.href}>)`;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
