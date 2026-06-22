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
    private readonly outputChannel: vscode.LogOutputChannel
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

    this.outputChannel.debug('provideLanguageModelChatInformation start', {
      silent: options.silent,
      baseURL: normalizeBaseURL(config.baseURL),
      clientVersion: config.clientVersion,
      hasCredentials: Boolean(credentials)
    });

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
    this.outputChannel.info('provideLanguageModelChatInformation complete', {
      modelCount: models.length,
      models: models.map((model) => ({
        id: model.info.id,
        name: model.info.name,
        maxInputTokens: model.info.maxInputTokens,
        maxOutputTokens: model.info.maxOutputTokens
      }))
    });
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
    const requestStartedAt = Date.now();
    const input = convertMessagesToResponsesInput(messages);

    this.outputChannel.info('provideLanguageModelChatResponse start', {
      modelId: model.id,
      requestModel: selectedModel.requestModel,
      reasoningEffort: reasoningEffort ?? null,
      messageCount: messages.length,
      inputItemCount: input.length,
      toolCount: options.tools?.length ?? 0,
      toolMode: options.toolMode ?? null,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens
    });

    await streamResponseText({
      baseURL: config.baseURL,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      model: selectedModel.requestModel,
      instructions: config.instructions,
      input,
      tools: options.tools,
      toolMode: options.toolMode,
      reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
      maxOutputTokens: config.maxOutputTokens,
      token,
      onTextDelta: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
      onToolCall: (callId, name, input) => {
        this.outputChannel.debug('response tool call', {
          requestModel: selectedModel.requestModel,
          callId,
          name,
          input
        });
        progress.report(new vscode.LanguageModelToolCallPart(callId, name, input));
      },
      onResponseCreated: (response) => {
        this.outputChannel.debug('response created', {
          requestModel: selectedModel.requestModel,
          responseId: response.id,
          status: response.status,
          serviceTier: response.service_tier ?? null
        });
      },
      onResponseCompleted: (response) => {
        this.outputChannel.info('response completed', {
          requestModel: selectedModel.requestModel,
          responseId: response.id,
          durationMs: Date.now() - requestStartedAt,
          usage: response.usage ?? null
        });
      },
      onResponseFailed: (message) => {
        this.outputChannel.error(`response failed model=${selectedModel.requestModel} message=${message}`);
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
      const estimated = estimateTokenCount(text);
      this.outputChannel.debug('provideTokenCount local estimate', {
        modelId: model.id,
        requestModel: parseModelIdentifier(model.id || config.model).requestModel,
        count: estimated,
        reason: credentials ? 'unsupported-backend' : 'missing-credentials'
      });
      return estimated;
    }

    const selectedModel = parseModelIdentifier(model.id || config.model);
    const input = typeof text === 'string' ? text : convertMessagesToResponsesInput([text]);
    const startedAt = Date.now();

    try {
      const count = await countInputTokens({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        model: selectedModel.requestModel,
        input,
        token
      });
      this.outputChannel.debug('provideTokenCount official count', {
        modelId: model.id,
        requestModel: selectedModel.requestModel,
        count,
        durationMs: Date.now() - startedAt
      });
      return count;
    } catch {
      const estimated = estimateTokenCount(text);
      this.outputChannel.warn('provideTokenCount fallback to local estimate', {
        modelId: model.id,
        requestModel: selectedModel.requestModel,
        count: estimated,
        durationMs: Date.now() - startedAt
      });
      return estimated;
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
      this.outputChannel.debug('getAvailableModels cache hit', {
        modelCount: this.cachedModels.models.length,
        expiresAt: this.cachedModels.expiresAt
      });
      return this.cachedModels.models;
    }

    let models: ResolvedProviderModel[];

    try {
      const upstreamModels = await fetchAvailableModels(config, credentials, token);
      models = buildProviderModels(config, upstreamModels);
      this.outputChannel.info('getAvailableModels discovery success', {
        discoveredCount: upstreamModels.length,
        returnedCount: models.length,
        requestModels: models.map((model) => model.requestModel)
      });
    } catch {
      models = [buildFallbackModel(config)];
      this.outputChannel.warn('getAvailableModels discovery failed, using fallback model', {
        fallbackModel: config.model
      });
    }

    this.cachedModels = {
      key: cacheKey,
      expiresAt: Date.now() + 60_000,
      models
    };

    return models;
  }
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
