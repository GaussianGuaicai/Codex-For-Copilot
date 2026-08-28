import type {
  ResponseFunctionWebSearch,
  ResponseOutputText,
  ResponsesServerEvent
} from 'openai/resources/responses/responses';

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

export function formatWebSearchSources(sources: readonly WebSearchSource[]): string | undefined {
  const uniqueSources = new Map<string, WebSearchSource>();
  for (const source of sources) {
    if (!isHttpURL(source.url)) {
      continue;
    }
    const existing = uniqueSources.get(source.url);
    if (!existing || (!existing.title && source.title)) {
      uniqueSources.set(source.url, source);
    }
  }
  if (uniqueSources.size === 0) {
    return undefined;
  }

  const lines = [...uniqueSources.values()].slice(0, 20).map((source) => {
    const normalizedURL = new URL(source.url).href;
    const label = escapeMarkdownLabel(source.title?.trim() || new URL(normalizedURL).hostname);
    return `- [${label}](<${normalizedURL}>)`;
  });
  return `\n\nSources:\n${lines.join('\n')}`;
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

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
