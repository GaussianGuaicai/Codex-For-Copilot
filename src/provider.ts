import * as vscode from 'vscode';
import { convertMessagesToResponsesInput, getTextFromMessage } from './convertMessages';
import { getProviderConfig } from './config';
import { streamResponseText } from './responsesClient';
import { getApiCredentials } from './secrets';

export class CodexModelProvider implements vscode.LanguageModelChatProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context);

    if (!credentials) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          'Codex Model Provider needs Codex credentials. Set an API key in SecretStorage or add credentials to ~/.codex/auth.json.',
          'Set API Key',
          'Open Settings'
        );

        if (action === 'Set API Key') {
          await vscode.commands.executeCommand('codexModelProvider.setApiKey');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('codexModelProvider.openSettings');
        }
      }

      return [];
    }

    const modelName = getModelDisplayName(config.model, config.displayName);

    return [
      {
        id: config.model,
        name: modelName,
        family: 'codex-model-provider',
        version: '1.0.0',
        maxInputTokens: config.maxInputTokens,
        maxOutputTokens: config.maxOutputTokens,
        tooltip: 'ChatGPT Codex Responses model provider',
        detail: config.baseURL,
        capabilities: {
          imageInput: false,
          toolCalling: true
        }
      }
    ];
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context);

    if (!credentials) {
      throw new Error('Codex Model Provider credentials are missing. Run "Codex Model Provider: Set API Key" or configure ~/.codex/auth.json.');
    }

    await streamResponseText({
      baseURL: config.baseURL,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      model: model.id || config.model,
      instructions: config.instructions,
      input: convertMessagesToResponsesInput(messages),
      maxOutputTokens: config.maxOutputTokens,
      token,
      onTextDelta: (text) => progress.report(new vscode.LanguageModelTextPart(text))
    });
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const value = typeof text === 'string' ? text : getTextFromMessage(text);
    return Math.ceil(value.length / 4);
  }
}

function getModelDisplayName(model: string, configuredDisplayName: string): string {
  const displayName = configuredDisplayName.trim();
  if (displayName && displayName.toLowerCase() !== 'codex model provider') {
    return displayName;
  }

  return formatCodexModelName(model);
}

function formatCodexModelName(model: string): string {
  const normalized = model.trim() || 'gpt-5.5';
  const cased = normalized
    .replace(/^gpt/i, 'GPT')
    .replace(/codex/gi, 'Codex');

  return /codex/i.test(cased) ? cased : `${cased}-Codex`;
}
