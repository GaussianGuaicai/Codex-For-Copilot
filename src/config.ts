import * as vscode from 'vscode';

export interface ProviderConfig {
  baseURL: string;
  clientVersion: string;
  credentialsSource: 'auto' | 'codexAuth' | 'secretStorage';
  model: string;
  instructions: string;
  defaultServiceTier?: 'default' | 'fast';
  defaultReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  maxOutputTokens: number;
}

export function getProviderConfig(): ProviderConfig {
  const config = vscode.workspace.getConfiguration('codexModelProvider');

  return {
    baseURL: config.get('baseURL', 'https://chatgpt.com/backend-api/codex/responses'),
    clientVersion: config.get('clientVersion', '0.0.0'),
    credentialsSource: config.get('credentialsSource', 'auto'),
    model: config.get('model', 'gpt-5.5'),
    instructions: config.get('instructions', 'You are a helpful coding assistant integrated with VS Code.'),
    defaultServiceTier: normalizeDefaultServiceTier(config.get('defaultServiceTier', 'auto')),
    defaultReasoningEffort: normalizeDefaultReasoningEffort(config.get('defaultReasoningEffort', 'auto')),
    maxOutputTokens: config.get('maxOutputTokens', 8192)
  };
}

function normalizeDefaultServiceTier(value: string): ProviderConfig['defaultServiceTier'] {
  switch (value) {
    case 'default':
    case 'fast':
      return value;
    default:
      return undefined;
  }
}

function normalizeDefaultReasoningEffort(value: string): ProviderConfig['defaultReasoningEffort'] {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}
