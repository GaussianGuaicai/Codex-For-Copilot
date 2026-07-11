import * as vscode from 'vscode';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import { compareResponsesInputHistory, convertMessagesToResponsesInput, estimateTokenCount, stableSerialize, type ResponsesInputMessage } from './convertMessages';
import { getProviderConfig, type ProviderConfig } from './config';
import { buildFallbackModel, buildProviderModels, fetchAvailableModels, parseModelIdentifier, type ParsedModelIdentifier, type ReasoningEffort, type ResolvedProviderModel } from './models';
import { countInputTokens, disposeReusableResponsesWebSockets, isResponsesContinuationMissError, normalizeBaseURL, streamResponseText } from './responsesClient';
import { ResponseBranchStore, type ResponseBranchReuseEnvelope, type ResponseBranchToolSignatures } from './responseBranchStore';
import { getApiCredentials } from './secrets';
import type { CodexAuthManager } from './auth/codexAuthManager';

type RuntimeProvideLanguageModelChatResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string, metadata?: { readonly [key: string]: any }) => unknown;
};

const USAGE_DATA_PART_MIME = 'usage';

export interface UsageSink {
  record(event: {
    model: string;
    usage: ResponseUsage;
    completedAt: number;
  }): void;
}

export interface SelectedModelSink {
  setSelectedModel(model: string): void;
}

export interface AccountUsageRefreshSink {
  refresh(): Promise<void>;
}

export class CodexModelProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  private readonly responseBranchStore = new ResponseBranchStore();
  private readonly unavailableModels = new Map<string, number>();
  private cachedModels?: {
    key: string;
    expiresAt: number;
    models: ResolvedProviderModel[];
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly usageSink?: UsageSink,
    private readonly accountUsageRefreshSink?: AccountUsageRefreshSink,
    private readonly selectedModelSink?: SelectedModelSink,
    private readonly authManager?: CodexAuthManager
  ) {
    this.onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    this.context.subscriptions.push(
      this.modelInfoChangedEmitter,
      new vscode.Disposable(() => disposeReusableResponsesWebSockets()),
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
    const credentials = await getApiCredentials(this.context, this.authManager);

    this.outputChannel.debug('provideLanguageModelChatInformation start', {
      silent: options.silent,
      baseURL: normalizeBaseURL(config.baseURL),
      clientVersion: config.clientVersion,
      hasCredentials: Boolean(credentials)
    });

    if (!credentials) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          'Codex credentials are required.',
          { modal: true },
          'Import auth.json',
          'Sign in with Device Code',
          'Cancel'
        );

        if (action === 'Import auth.json') {
          await vscode.commands.executeCommand('codexForCopilot.auth.importAuthJson');
        } else if (action === 'Sign in with Device Code') {
          await vscode.commands.executeCommand('codexForCopilot.auth.signInWithDeviceCode');
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
    const credentials = await getApiCredentials(this.context, this.authManager);

    if (!credentials) {
      throw new Error('Codex credentials are missing. Run "Codex for Copilot: Import Codex auth.json".');
    }

    const authIdentity = getCredentialIdentity(credentials);
    const availableModels = await this.getAvailableModels(config, credentials, token);
    let selectedModel = this.resolveRequestModel(model.id, config, availableModels);
    this.selectedModelSink?.setSelectedModel(selectedModel.requestModel);
    const reasoningEffort = getReasoningEffort(
      selectedModel.reasoningEffort,
      options as RuntimeProvideLanguageModelChatResponseOptions,
      config.defaultReasoningEffort
    );
    const requestStartedAt = Date.now();
    const input = convertMessagesToResponsesInput(messages);
    const createReuseEnvelope = (requestModel: string) => buildResponseBranchReuseEnvelope({
      baseURL: normalizeBaseURL(config.baseURL),
      authIdentity,
      model: requestModel,
      instructions: config.instructions,
      reasoningEffort,
      toolMode: options.toolMode,
      tools: options.tools
    });
    let reuseEnvelope = createReuseEnvelope(selectedModel.requestModel);
    const reusableBranch = this.responseBranchStore.findReusableBranch(reuseEnvelope, input);
    const reuseMissDiagnostic = reusableBranch
      ? undefined
      : this.responseBranchStore.explainReuseMiss(reuseEnvelope, input);
    const initialRequestInput = reusableBranch?.comparison.appendedInput.length ? reusableBranch.comparison.appendedInput : input;
    const initialPreviousResponseId = reusableBranch?.comparison.appendedInput.length ? reusableBranch.responseId : undefined;
    let activeBranchId = initialPreviousResponseId ? reusableBranch?.branchId : undefined;
    let createdResponseId: string | undefined;
    let completedResponseId: string | undefined;

    this.outputChannel.info('provideLanguageModelChatResponse start', {
      modelId: model.id,
      requestModel: selectedModel.requestModel,
      transport: config.transport,
      reuse: initialPreviousResponseId
        ? {
            branchId: reusableBranch?.branchId,
            matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
            appendedInputCount: reusableBranch?.comparison.appendedInput.length
          }
        : null,
      serviceTier: config.defaultServiceTier ?? 'auto',
      reasoningEffort: reasoningEffort ?? null,
      messageCount: messages.length,
      inputItemCount: input.length,
      toolCount: options.tools?.length ?? 0,
      toolMode: options.toolMode ?? null,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens
    });

    if (reuseMissDiagnostic) {
      this.outputChannel.info('response reuse miss', {
        requestModel: selectedModel.requestModel,
        branchId: reuseMissDiagnostic.branchId,
        previousResponseId: reuseMissDiagnostic.responseId,
        comparisonKind: reuseMissDiagnostic.comparison.kind,
        matchedPrefixCount: reuseMissDiagnostic.comparison.matchedPrefixCount,
        previousInputCount: reuseMissDiagnostic.previousInputCount,
        currentInputCount: reuseMissDiagnostic.currentInputCount,
        appendedInputCount: reuseMissDiagnostic.comparison.appendedInput.length,
        mismatchIndex: reuseMissDiagnostic.comparison.mismatch?.index ?? null,
        mismatchPreviousItem: reuseMissDiagnostic.comparison.mismatch?.previousItemSummary ?? reuseMissDiagnostic.previousNextItemSummary,
        mismatchCurrentItem: reuseMissDiagnostic.comparison.mismatch?.currentItemSummary ?? reuseMissDiagnostic.currentNextItemSummary,
        toolCompatibility: reuseMissDiagnostic.toolCompatibility ?? null
      });
    }

    const streamRequest = async (requestInput: ResponsesInputMessage[], previousResponseId?: string) => {
      const streamStartedAt = Date.now();
      let actualTransport: 'http' | 'http-fallback' | 'websocket-fresh' | 'websocket-reused' = config.transport === 'http'
        ? 'http'
        : 'http-fallback';
      let firstVisibleOutput:
        | {
            kind: 'text' | 'reasoning' | 'tool_call';
            latencyMs: number;
          }
        | undefined;

      const recordFirstVisibleOutput = (kind: 'text' | 'reasoning' | 'tool_call') => {
        if (firstVisibleOutput) {
          return;
        }

        firstVisibleOutput = {
          kind,
          latencyMs: Date.now() - streamStartedAt
        };
      };

      await streamResponseText({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        transport: config.transport,
        previousResponseId,
        omitMaxOutputTokens: credentials.omitMaxOutputTokens,
        model: selectedModel.requestModel,
        instructions: config.instructions,
        serviceTier: getRequestServiceTier(config.defaultServiceTier),
        input: requestInput,
        tools: options.tools,
        toolMode: options.toolMode,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        maxOutputTokens: config.maxOutputTokens,
        token,
        onTextDelta: (text) => {
          recordFirstVisibleOutput('text');
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onReasoningTextDelta: (text) => {
          recordFirstVisibleOutput('reasoning');
          const thinkingPart = createThinkingPart(text);
          if (thinkingPart) {
            progress.report(thinkingPart);
          }
        },
        onToolCall: (callId, name, toolInput) => {
          recordFirstVisibleOutput('tool_call');
          this.outputChannel.debug('response tool call', {
            requestModel: selectedModel.requestModel,
            callId,
            name,
            input: toolInput
          });
          progress.report(new vscode.LanguageModelToolCallPart(callId, name, toolInput));
        },
        onResponseCreated: (response) => {
          createdResponseId = response.id ?? createdResponseId;
          this.outputChannel.debug('response created', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            status: response.status,
            serviceTier: response.service_tier ?? null,
            previousResponseId: previousResponseId ?? null
          });
        },
        onResponseCompleted: (response) => {
          completedResponseId = response.id ?? completedResponseId;
          this.outputChannel.info('response completed', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            durationMs: Date.now() - requestStartedAt,
            streamDurationMs: Date.now() - streamStartedAt,
            actualTransport,
            firstVisibleOutputLatencyMs: firstVisibleOutput?.latencyMs ?? null,
            firstVisibleOutputKind: firstVisibleOutput?.kind ?? null,
            usage: response.usage ?? null,
            previousResponseId: previousResponseId ?? null
          });

          const usagePart = createUsageDataPart(response.usage);
          if (usagePart) {
            progress.report(usagePart);
          }

          if (response.usage) {
            this.usageSink?.record({
              model: selectedModel.requestModel,
              usage: response.usage,
              completedAt: Date.now()
            });
          }

            void this.accountUsageRefreshSink?.refresh();
        },
        onResponseFailed: (message) => {
          this.outputChannel.error(`response failed model=${selectedModel.requestModel} previousResponseId=${previousResponseId ?? 'none'} message=${message}`);
        },
        onTransportFallback: ({ from, to, reason }) => {
          actualTransport = 'http-fallback';
          this.outputChannel.warn('response transport fallback', {
            requestModel: selectedModel.requestModel,
            from,
            to,
            reason,
            previousResponseId: previousResponseId ?? null
          });
        },
        onWebSocketSession: ({ reused }) => {
          actualTransport = reused ? 'websocket-reused' : 'websocket-fresh';
          this.outputChannel.debug('response websocket session', {
            requestModel: selectedModel.requestModel,
            reused,
            previousResponseId: previousResponseId ?? null
          });
        }
      });
    };

    try {
      await streamRequest(initialRequestInput, initialPreviousResponseId);
    } catch (error) {
      if (!initialPreviousResponseId || !isResponsesContinuationMissError(error)) {
        const unavailableModel = getExactModelNotFoundName(error, selectedModel.requestModel);
        if (!unavailableModel) {
          throw error;
        }

        this.markModelUnavailable(unavailableModel, config, authIdentity);

        this.outputChannel.warn('response model unavailable', {
          rejectedModel: unavailableModel,
          previousResponseId: initialPreviousResponseId ?? null
        });

        throw createTemporarilyUnavailableModelError(unavailableModel, error);
      }

      this.outputChannel.warn('response continuation reset', {
        requestModel: selectedModel.requestModel,
        branchId: reusableBranch?.branchId ?? null,
        previousResponseId: initialPreviousResponseId,
        reason: error.message
      });

      this.outputChannel.warn('response reuse temporarily disabled until next full-input success', {
        requestModel: selectedModel.requestModel,
        previousResponseId: initialPreviousResponseId,
        branchId: reusableBranch?.branchId ?? null
      });

      this.responseBranchStore.disableReuse(reuseEnvelope);
      this.responseBranchStore.invalidateResponseId(initialPreviousResponseId);

      if (reusableBranch) {
        this.responseBranchStore.invalidate(reusableBranch.branchId);
      }

      createdResponseId = undefined;
      completedResponseId = undefined;
      activeBranchId = undefined;
      await streamRequest(input);
    }

    const finalResponseId = completedResponseId ?? createdResponseId;
    if (finalResponseId) {
      activeBranchId = this.responseBranchStore.recordSuccess(reuseEnvelope, input, finalResponseId, activeBranchId);
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);

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

    const availableModels = await this.getAvailableModels(config, credentials, token);
    const selectedModel = this.resolveRequestModel(model.id, config, availableModels);
    const input = typeof text === 'string' ? text : convertMessagesToResponsesInput([text]);
    const startedAt = Date.now();

    try {
      const count = await countInputTokens({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        authManager: credentials.authManager,
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
      config.credentialsSource,
      config.transport,
      config.model,
      config.disabledModels.join(','),
      stableSerialize(config.modelAliases),
      config.defaultServiceTier ?? 'auto',
      config.defaultReasoningEffort ?? 'auto',
      config.maxOutputTokens,
      credentials.source,
      getCredentialIdentity(credentials)
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
      models = this.applyModelDiscoveryPolicy(models, config, getCredentialIdentity(credentials));
      this.outputChannel.info('getAvailableModels discovery success', {
        discoveredCount: upstreamModels.length,
        returnedCount: models.length,
        requestModels: models.map((model) => model.requestModel)
      });
    } catch {
      models = [buildFallbackModel(config)];
      models = this.applyModelDiscoveryPolicy(models, config, getCredentialIdentity(credentials));
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

  private markModelUnavailable(model: string, config: ProviderConfig, authIdentity: string): void {
    this.evictExpiredUnavailableModels();
    this.unavailableModels.set(this.getUnavailableModelScopeKey(model, config, authIdentity), Date.now() + 10 * 60 * 1000);
    this.cachedModels = undefined;
    this.modelInfoChangedEmitter.fire();
    this.outputChannel.warn('model marked unavailable after responses rejection', {
      model,
      transport: config.transport,
      authIdentity,
      baseURL: normalizeBaseURL(config.baseURL)
    });
  }

  private evictExpiredUnavailableModels(): void {
    const now = Date.now();
    for (const [modelKey, expiresAt] of this.unavailableModels.entries()) {
      if (expiresAt <= now) {
        this.unavailableModels.delete(modelKey);
      }
    }
  }

  private resolveRequestModel(
    modelId: string | undefined,
    config: ProviderConfig,
    availableModels: readonly ResolvedProviderModel[]
  ): ParsedModelIdentifier {
    const requestedModel = parseModelIdentifier(modelId || config.model);
    const availableModelNames = new Set(availableModels.map((candidate) => candidate.requestModel));

    const aliasedModel = this.resolveModelAlias(requestedModel.requestModel, config.modelAliases, availableModels);
    if (aliasedModel) {
      this.outputChannel.warn('request model remapped from configured model alias', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: aliasedModel.requestModel
      });
      return {
        requestModel: aliasedModel.requestModel,
        reasoningEffort: requestedModel.reasoningEffort
      };
    }

    if (availableModelNames.has(requestedModel.requestModel)) {
      return requestedModel;
    }

    const prefixMatch = availableModels
      .map((candidate) => candidate.requestModel)
      .filter((candidate) => requestedModel.requestModel.startsWith(`${candidate}-`))
      .sort((left, right) => right.length - left.length)[0];

    if (prefixMatch) {
      this.outputChannel.warn('request model remapped from stale model identifier', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: prefixMatch
      });
      return {
        requestModel: prefixMatch,
        reasoningEffort: requestedModel.reasoningEffort
      };
    }

    if (availableModelNames.has(config.model)) {
      this.outputChannel.warn('request model fell back to configured model', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: config.model
      });
      return {
        requestModel: config.model,
        reasoningEffort: requestedModel.reasoningEffort
      };
    }

    const fallbackModel = availableModels[0]?.requestModel ?? config.model;
    this.outputChannel.warn('request model fell back to first available model', {
      requestedModelId: modelId ?? null,
      requestedModel: requestedModel.requestModel,
      resolvedModel: fallbackModel
    });
    return {
      requestModel: fallbackModel,
      reasoningEffort: requestedModel.reasoningEffort
    };
  }

  private applyModelDiscoveryPolicy(models: ResolvedProviderModel[], config: ProviderConfig, authIdentity: string): ResolvedProviderModel[] {
    this.evictExpiredUnavailableModels();
    const disabledModels = new Set([
      ...config.disabledModels,
      ...this.getUnavailableModelsForScope(config, authIdentity)
    ]);
    const availableModelNames = new Set(models.map((model) => model.requestModel));
    const aliasedSources = new Set(
      Object.entries(config.modelAliases)
        .filter(([, target]) => availableModelNames.has(target))
        .map(([source]) => source)
    );
    const filteredModels = models.filter((model) => !disabledModels.has(model.requestModel) && !aliasedSources.has(model.requestModel));

    if (filteredModels.length === 0) {
      this.outputChannel.warn('model discovery policy kept original models because every discovered model was filtered', {
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
      return models;
    }

    if (filteredModels.length !== models.length) {
      this.outputChannel.info('model discovery policy filtered models', {
        before: models.map((model) => model.requestModel),
        after: filteredModels.map((model) => model.requestModel),
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
    }

    return filteredModels;
  }

  private getUnavailableModelsForScope(config: ProviderConfig, authIdentity: string): string[] {
    const scopePrefix = this.getUnavailableModelScopePrefix(config, authIdentity);
    return [...this.unavailableModels.keys()]
      .filter((entry) => entry.startsWith(scopePrefix))
      .map((entry) => entry.slice(scopePrefix.length));
  }

  private getUnavailableModelScopeKey(model: string, config: ProviderConfig, authIdentity: string): string {
    return `${this.getUnavailableModelScopePrefix(config, authIdentity)}${model}`;
  }

  private getUnavailableModelScopePrefix(config: ProviderConfig, authIdentity: string): string {
    return `${normalizeBaseURL(config.baseURL)}|${authIdentity}|${config.transport}|`;
  }

  private resolveModelAlias(
    model: string,
    modelAliases: Record<string, string>,
    availableModels: readonly ResolvedProviderModel[]
  ): ResolvedProviderModel | undefined {
    const targetModel = modelAliases[model];
    if (!targetModel) {
      return undefined;
    }

    return availableModels.find((candidate) => candidate.requestModel === targetModel);
  }
}

function getExactModelNotFoundName(error: unknown, expectedModel: string): string | undefined {
  const message = getModelNotFoundMessage(error);
  if (message !== expectedModel) {
    return undefined;
  }

  return message;
}

function getModelNotFoundMessage(error: unknown): string | undefined {
  for (const message of collectErrorMessages(error)) {
    const match = /Model not found\s+([^"\s:}]+)/i.exec(message);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      messages.push(value);
      return;
    }

    if (value instanceof Error) {
      messages.push(value.message);
      visit((value as Error & { cause?: unknown }).cause);
      return;
    }

    if (typeof value === 'object') {
      const record = value as { message?: unknown; cause?: unknown; error?: unknown };
      if (typeof record.message === 'string') {
        messages.push(record.message);
      }
      visit(record.cause);
      visit(record.error);
    }
  };

  visit(error);
  return messages;
}

function getRequestServiceTier(serviceTier: ProviderConfig['defaultServiceTier']): 'default' | 'priority' | undefined {
  switch (serviceTier) {
    case 'default':
      return 'default';
    case 'fast':
      return 'priority';
    default:
      return undefined;
  }
}

function getReasoningEffort(
  selectedReasoningEffort: ReasoningEffort | undefined,
  options: RuntimeProvideLanguageModelChatResponseOptions,
  defaultReasoningEffort: ReasoningEffort | undefined
): ReasoningEffort | undefined {
  const configuredEffort = normalizeReasoningEffort(options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort);
  if (configuredEffort) {
    return configuredEffort;
  }

  const modelOptions = options.modelOptions;
  const directEffort = normalizeReasoningEffort(modelOptions?.reasoningEffort);
  if (directEffort) {
    return directEffort;
  }

  const nestedEffort = normalizeReasoningEffort((modelOptions?.reasoning as { effort?: unknown } | undefined)?.effort);
  return nestedEffort ?? defaultReasoningEffort ?? selectedReasoningEffort;
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

function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
  const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
  if (typeof ThinkingPart !== 'function') {
    return undefined;
  }

  return new ThinkingPart(text) as vscode.LanguageModelResponsePart;
}

function createUsageDataPart(usage: ResponseUsage | null | undefined): vscode.LanguageModelResponsePart | undefined {
  if (!usage) {
    return undefined;
  }

  return vscode.LanguageModelDataPart.json(
    {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0
      },
      completion_tokens_details: {
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0
      }
    },
    USAGE_DATA_PART_MIME
  ) as vscode.LanguageModelResponsePart;
}

function createTemporarilyUnavailableModelError(model: string, cause: unknown): Error {
  const error = new Error(`Model ${model} is listed by discovery but is not currently callable through the configured Codex Responses backend. It has been hidden temporarily from the model picker. Choose another model and retry.`);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export function buildResponseBranchReuseEnvelope(options: {
  baseURL: string;
  authIdentity: string;
  model: string;
  instructions: string;
  reasoningEffort: ReasoningEffort | undefined;
  toolMode: vscode.LanguageModelChatToolMode | undefined;
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
}): ResponseBranchReuseEnvelope {
  return {
    identityKey: stableSerialize({
      baseURL: options.baseURL,
      authIdentity: options.authIdentity,
      model: options.model,
      instructions: options.instructions,
      reasoningEffort: options.reasoningEffort ?? null,
      toolMode: options.toolMode ?? null
    }),
    toolSignatures: buildResponseBranchToolSignatures(options.tools)
  };
}

export function buildResponseBranchToolSignatures(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ResponseBranchToolSignatures {
  return Object.fromEntries(
    (tools ?? [])
      .map((tool) => [
        tool.name,
        stableSerialize({
          description: tool.description,
          inputSchema: tool.inputSchema ?? null
        })
      ])
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
  );
}

function getCredentialIdentity(credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>): string {
  const accountId = credentials.headers['ChatGPT-Account-ID'];
  if (typeof accountId === 'string' && accountId.length > 0) {
    return `${credentials.source}:${accountId}`;
  }

  return `${credentials.source}:${credentials.apiKey.slice(0, 16)}`;
}
