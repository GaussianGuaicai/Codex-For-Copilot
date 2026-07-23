import * as vscode from 'vscode';

export const NATIVE_TOOL_SEARCH_THRESHOLD = 12;
export const MAX_NAMESPACE_FUNCTIONS = 8;
export const MAX_IMMEDIATE_FUNCTIONS = 8;

export function hasVirtualToolPlaceholder(tools: readonly vscode.LanguageModelChatTool[] | undefined): boolean {
  return (tools ?? []).some((tool) => /^activate_group_/i.test(tool.name));
}

export function supportsNativeToolSearchModel(model: string): boolean {
  const match = /(?:^|[^0-9])gpt-5\.(\d+)(?:[^0-9]|$)/i.exec(model);
  return match !== null && Number(match[1]) >= 4;
}

export function chooseImmediateToolNames(tools: readonly vscode.LanguageModelChatTool[]): ReadonlySet<string> {
  const ordered = [...tools].sort((left, right) => score(left.name) - score(right.name) || left.name.localeCompare(right.name));
  return new Set(ordered.slice(0, MAX_IMMEDIATE_FUNCTIONS).map((tool) => tool.name));
}

function score(name: string): number {
  const normalized = name.toLowerCase();
  const priorities = [
    ['read', 0], ['search', 1], ['grep', 2], ['list', 3], ['error', 4], ['todo', 5],
    ['inspect', 6], ['workspace', 7], ['get_', 8]
  ] as const;
  const match = priorities.find(([term]) => normalized.includes(term));
  if (!match) {
    return 100;
  }
  return match[1];
}
