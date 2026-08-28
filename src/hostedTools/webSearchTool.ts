import * as vscode from 'vscode';
import { CODEX_WEB_SEARCH_TOOL_NAME } from './hostedToolPlan';

export function registerWebSearchMarkerTool(): vscode.Disposable {
  return vscode.lm.registerTool(CODEX_WEB_SEARCH_TOOL_NAME, {
    invoke: () => new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        'Web Search is executed by the Codex hosted Responses tool. Select a Codex For Copilot model to use it.'
      )
    ])
  });
}
