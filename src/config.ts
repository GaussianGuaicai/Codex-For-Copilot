import * as vscode from 'vscode';

export interface ProviderConfig {
  baseURL: string;
  model: string;
  displayName: string;
  instructions: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export function getProviderConfig(): ProviderConfig {
  const config = vscode.workspace.getConfiguration('codexModelProvider');

  return {
    baseURL: config.get('baseURL', 'https://chatgpt.com/backend-api/codex/responses'),
    model: config.get('model', 'gpt-5.5'),
    displayName: config.get('displayName', 'GPT-5.5-Codex'),
    instructions: config.get('instructions', 'You are a helpful coding assistant integrated with VS Code.'),
    maxInputTokens: config.get('maxInputTokens', 120000),
    maxOutputTokens: config.get('maxOutputTokens', 8192)
  };
}
