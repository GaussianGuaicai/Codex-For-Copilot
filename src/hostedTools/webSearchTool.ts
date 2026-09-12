import * as vscode from 'vscode';
import { CODEX_WEB_SEARCH_TOOL_NAME } from './hostedToolPlan';
import { executeWebSearch, type WebSearchExecutorDependencies } from './webSearchExecutor';

export interface WebSearchToolInput {
  query: string;
}

/**
 * Registers the single user-visible `#webSearch` tool.
 *
 * For Codex For Copilot models the provider intercepts this tool name and
 * swaps in OpenAI's hosted `web_search` tool, so `invoke` is never reached.
 * For every other tool-capable VS Code model, `invoke` runs one isolated
 * Responses request through {@link executeWebSearch}.
 */
export function registerWebSearchTool(dependencies: WebSearchExecutorDependencies): vscode.Disposable {
  return vscode.lm.registerTool<WebSearchToolInput>(CODEX_WEB_SEARCH_TOOL_NAME, {
    async invoke(options, token) {
      const query = normalizeWebSearchQuery(options.input?.query);
      if (!query) {
        throw new Error('Web Search requires a non-empty "query" string.');
      }
      const result = await executeWebSearch(query, token, dependencies);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(result))
      ]);
    }
  });
}

function normalizeWebSearchQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
