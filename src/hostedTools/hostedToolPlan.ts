import type { Tool, WebSearchTool } from 'openai/resources/responses/responses';
import type * as vscode from 'vscode';

export const CODEX_WEB_SEARCH_TOOL_NAME = 'codexForCopilot_searchWeb';

export interface HostedToolPlan {
  clientTools: readonly vscode.LanguageModelChatTool[];
  responseTools: readonly Tool[];
  webSearchEnabled: boolean;
}

const WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search',
  external_web_access: true
} satisfies WebSearchTool);

/**
 * Separates VS Code-executed tools from selection markers for OpenAI-hosted
 * tools. Hosted tools never enter the function schema or Native Tool Search.
 */
export function resolveHostedToolPlan(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
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
    responseTools: webSearchEnabled ? Object.freeze([WEB_SEARCH_TOOL]) : Object.freeze([]),
    webSearchEnabled
  };
}

export function hasHostedWebSearch(tools: readonly Tool[] | undefined): boolean {
  return tools?.some((tool) => tool.type === 'web_search' || tool.type === 'web_search_2025_08_26') ?? false;
}
