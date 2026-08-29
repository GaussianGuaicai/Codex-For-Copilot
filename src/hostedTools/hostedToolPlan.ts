import type { Tool, WebSearchTool } from 'openai/resources/responses/responses';
import type * as vscode from 'vscode';
import type { WebSearchConfig } from '../config';

export const CODEX_WEB_SEARCH_TOOL_NAME = 'codexForCopilot_searchWeb';

export interface HostedToolPlan {
  clientTools: readonly vscode.LanguageModelChatTool[];
  responseTools: readonly Tool[];
  webSearchEnabled: boolean;
}

/**
 * Separates VS Code-executed tools from selection markers for OpenAI-hosted
 * tools. Hosted tools never enter the function schema or Native Tool Search.
 */
export function resolveHostedToolPlan(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  settings?: Pick<WebSearchConfig, 'externalWebAccess' | 'contextSize' | 'allowedDomains'>
): HostedToolPlan {
  if (!tools || tools.length === 0) {
    return {
      clientTools: Object.freeze([]),
      responseTools: Object.freeze([]),
      webSearchEnabled: false
    };
  }

  const clientTools: vscode.LanguageModelChatTool[] = [];
  let webSearchEnabled = false;
  for (const tool of tools) {
    if (tool.name === CODEX_WEB_SEARCH_TOOL_NAME) {
      webSearchEnabled = true;
      continue;
    }
    clientTools.push(tool);
  }

  return {
    clientTools: Object.freeze(clientTools),
    responseTools: webSearchEnabled ? Object.freeze([buildWebSearchTool(settings)]) : Object.freeze([]),
    webSearchEnabled
  };
}

export function buildWebSearchTool(
  settings?: Pick<WebSearchConfig, 'externalWebAccess' | 'contextSize' | 'allowedDomains'>
): Readonly<WebSearchTool> {
  return Object.freeze({
    type: 'web_search',
    external_web_access: settings?.externalWebAccess ?? true,
    ...(settings?.contextSize ? { search_context_size: settings.contextSize } : {}),
    ...(settings && settings.allowedDomains.length > 0
      ? { filters: { allowed_domains: [...settings.allowedDomains] } }
      : {})
  } satisfies WebSearchTool);
}

export function hasHostedWebSearch(tools: readonly Tool[] | undefined): boolean {
  return tools?.some((tool) => tool.type === 'web_search' || tool.type === 'web_search_2025_08_26') ?? false;
}
