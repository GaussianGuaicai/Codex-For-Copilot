import * as vscode from 'vscode';
import { convertMessagesToResponsesInput, estimateTokenCount } from './convertMessages';
import { getProviderConfig } from './config';
import { buildFallbackModel, buildProviderModels, fetchAvailableModels, parseModelIdentifier, type ReasoningEffort, type ResolvedProviderModel } from './models';
import { countInputTokens, normalizeBaseURL, streamResponseText } from './responsesClient';
import { getApiCredentials } from './secrets';

export class CodexModelProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  private cachedModels?: {
    key: string;
    expiresAt: number;
    models: ResolvedProviderModel[];
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    this.context.subscriptions.push(
      this.modelInfoChangedEmitter,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codexModelProvider')) {
          this.cachedModels = undefined;
          this.modelInfoChangedEmitter.fire();
        }
      })
    );
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
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

    const models = await this.getAvailableModels(config, credentials, token);
    return models.map((model) => model.info);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context);

    if (!credentials) {
      throw new Error('Codex Model Provider credentials are missing. Run "Codex Model Provider: Set API Key" or configure ~/.codex/auth.json.');
    }

    const selectedModel = parseModelIdentifier(model.id || config.model);
    const reasoningEffort = getReasoningEffort(selectedModel.reasoningEffort, options.modelOptions);

    await streamResponseText({
      baseURL: config.baseURL,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      model: selectedModel.requestModel,
      instructions: config.instructions,
      input: convertMessagesToResponsesInput(messages),
      tools: options.tools,
      toolMode: options.toolMode,
      reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
      maxOutputTokens: config.maxOutputTokens,
      token,
      onTextDelta: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
      onToolCall: (callId, name, input) => progress.report(new vscode.LanguageModelToolCallPart(callId, name, input)),
      onResponseCompleted: (response) => {
        this.outputChannel.appendLine(formatUsageLogLine(selectedModel.requestModel, response.usage));
      },
      onResponseFailed: (message) => {
        this.outputChannel.appendLine(`[Responses error] model=${selectedModel.requestModel} message=${message}`);
      }
    });
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context);

    if (!credentials || !supportsOfficialTokenCounting(config.baseURL)) {
      return estimateTokenCount(text);
    }

    const selectedModel = parseModelIdentifier(model.id || config.model);
    const input = typeof text === 'string' ? text : convertMessagesToResponsesInput([text]);

    try {
      return await countInputTokens({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        model: selectedModel.requestModel,
        input,
        token
      });
    } catch {
      return estimateTokenCount(text);
    }
  }

  private async getAvailableModels(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken
  ): Promise<ResolvedProviderModel[]> {
    const cacheKey = [
      config.baseURL,
      config.clientVersion,
      config.model,
      config.displayName,
      config.maxInputTokens,
      config.maxOutputTokens,
      credentials.source
    ].join('|');

    if (this.cachedModels && this.cachedModels.key === cacheKey && this.cachedModels.expiresAt > Date.now()) {
      return this.cachedModels.models;
    }

    let models: ResolvedProviderModel[];

    try {
      const upstreamModels = await fetchAvailableModels(config, credentials, token);
      models = buildProviderModels(config, upstreamModels);
    } catch {
      models = [buildFallbackModel(config)];
    }

    this.cachedModels = {
      key: cacheKey,
      expiresAt: Date.now() + 60_000,
      models
    };

    return models;
  }
}

function formatUsageLogLine(
  model: string,
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        total_tokens?: number | null;
        input_tokens_details?: { cached_tokens?: number | null } | null;
        output_tokens_details?: { reasoning_tokens?: number | null } | null;
      }
    | null
    | undefined
): string {
  if (!usage) {
    return `[Responses usage] model=${model} usage=unavailable`;
  }

  const inputTokens = usage.input_tokens ?? 'n/a';
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 'n/a';
  const outputTokens = usage.output_tokens ?? 'n/a';
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 'n/a';
  const totalTokens = usage.total_tokens ?? 'n/a';

  return `[Responses usage] model=${model} input=${inputTokens} cached=${cachedTokens} output=${outputTokens} reasoning=${reasoningTokens} total=${totalTokens}`;
}

function getReasoningEffort(
  selectedReasoningEffort: ReasoningEffort | undefined,
  modelOptions: vscode.ProvideLanguageModelChatResponseOptions['modelOptions']
): ReasoningEffort | undefined {
  const directEffort = normalizeReasoningEffort(modelOptions?.reasoningEffort);
  if (directEffort) {
    return directEffort;
  }

  const nestedEffort = normalizeReasoningEffort((modelOptions?.reasoning as { effort?: unknown } | undefined)?.effort);
  return nestedEffort ?? selectedReasoningEffort;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
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

function supportsOfficialTokenCounting(baseURL: string): boolean {
  const normalizedBaseURL = normalizeBaseURL(baseURL).toLowerCase();
  return !normalizedBaseURL.includes('chatgpt.com/backend-api/codex');
}
