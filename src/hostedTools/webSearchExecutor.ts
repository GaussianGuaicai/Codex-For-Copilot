import * as vscode from 'vscode';
import type { ResponsesInputMessage } from '../convertMessages';
import { getProviderConfig, type ProviderConfig } from '../config';
import { getApiCredentials, type ApiCredentials } from '../secrets';
import type { CodexAuthManager } from '../auth/codexAuthManager';
import { getCodexCompatibilityProfile, type CodexRequestIdentity } from '../codexProtocol';
import { resolveRequestIdentity } from '../codexRequestIdentity';
import { buildProviderModels, fetchAvailableModels } from '../models';
import { streamResponseText } from '../responsesClient';
import { type WebSearchSource } from './hostedToolEvents';
import { buildWebSearchTool } from './hostedToolPlan';

const WEB_SEARCH_MAX_SOURCES = 10;
const WEB_SEARCH_INSTRUCTIONS = 'Search the web to answer the user query, then answer using the search results.';

export interface WebSearchResult {
  answer: string;
  sources: WebSearchSource[];
}

export interface WebSearchExecutorDependencies {
  context: vscode.ExtensionContext;
  authManager?: CodexAuthManager;
  /**
   * Supplies a Codex request identity for compatibility-enabled endpoints.
   * The helper request is intentionally isolated from conversation
   * continuation state, so it always starts a fresh thread.
   */
  createIdentity?: () => Promise<CodexRequestIdentity>;
}

/**
 * Runs one isolated Responses request that forces OpenAI's hosted `web_search`
 * tool, then returns the synthesized answer plus deduplicated sources.
 *
 * This is deliberately a thin adapter: it reuses the shared credential,
 * request-identity, and streaming transport plumbing, and never participates in
 * conversation continuation, branch reuse, or Native Tool Search. The Codex
 * backend requires a streamed request, so this goes through
 * {@link streamResponseText} over HTTP rather than a one-shot non-streaming
 * call.
 */
export async function executeWebSearch(
  query: string,
  token: vscode.CancellationToken,
  dependencies: WebSearchExecutorDependencies
): Promise<WebSearchResult> {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }

  const config = getProviderConfig();
  const credentials = await getApiCredentials(dependencies.context, dependencies.authManager);
  if (!credentials) {
    throw new Error('Codex credentials are missing. Run "Codex for Copilot: Import Codex auth.json".');
  }

  const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials, config.protocol.profile);
  const extensionVersion = getExtensionVersion(dependencies.context);
  const userAgent = buildCodexUserAgent(extensionVersion);
  const clientIdentity = resolveRequestIdentity({
    ...config.requestIdentity,
    extensionVersion,
    extensionUserAgent: userAgent
  });
  const model = await resolveWebSearchModel(config, credentials, token, clientIdentity);
  const identity = compatibilityProfile.enabled
    ? await dependencies.createIdentity?.()
    : undefined;

  let answer = '';
  const sources: WebSearchSource[] = [];
  const seenSourceUrls = new Set<string>();

  await streamResponseText({
    baseURL: config.baseURL,
    apiKey: credentials.apiKey,
    headers: credentials.headers,
    authManager: credentials.authManager,
    accountKey: credentials.accountKey,
    // A plain HTTP stream keeps this helper request independent from the
    // conversation's managed WebSocket sessions and continuation state.
    transport: 'http',
    compatibilityProfile,
    identity,
    extensionVersion,
    userAgent,
    protocolSettings: config.protocol,
    clientIdentity,
    requestCompression: config.requestCompression,
    store: false,
    omitMaxOutputTokens: credentials.omitMaxOutputTokens,
    model,
    instructions: WEB_SEARCH_INSTRUCTIONS,
    input: [{ role: 'user', content: query }] satisfies ResponsesInputMessage[],
    hostedTools: [buildWebSearchTool(config.webSearch)],
    // The hosted web_search tool is the only tool in this request, so
    // "required" forces the model to search instead of answering from memory.
    toolMode: vscode.LanguageModelChatToolMode.Required,
    serviceTier: toRequestServiceTier(config.defaultServiceTier),
    maxOutputTokens: config.maxOutputTokens,
    token,
    onTextDelta: (text) => {
      answer += text;
    },
    onWebSearchSources: (incoming) => {
      for (const source of incoming) {
        if (seenSourceUrls.size >= WEB_SEARCH_MAX_SOURCES) {
          return;
        }
        if (seenSourceUrls.has(source.url)) {
          continue;
        }
        seenSourceUrls.add(source.url);
        sources.push(source);
      }
    }
  });

  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }

  return { answer, sources };
}

/**
 * Prefers the configured model, then the first discovered model, and finally
 * the configured model again when discovery is unavailable. Discovery is
 * best-effort so a Web Search call never fails because `/models` is down.
 */
async function resolveWebSearchModel(
  config: ProviderConfig,
  credentials: ApiCredentials,
  token: vscode.CancellationToken,
  clientIdentity: ReturnType<typeof resolveRequestIdentity>
): Promise<string> {
  try {
    const upstreamModels = await fetchAvailableModels(config, credentials, token, clientIdentity);
    const models = buildProviderModels(config, upstreamModels, credentials.kind);
    if (models.some((model) => model.requestModel === config.model)) {
      return config.model;
    }
    return models[0]?.requestModel ?? config.model;
  } catch (error) {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    return config.model;
  }
}

function toRequestServiceTier(
  serviceTier: ProviderConfig['defaultServiceTier']
): 'default' | 'priority' | undefined {
  switch (serviceTier) {
    case 'default':
      return 'default';
    case 'fast':
      return 'priority';
    default:
      return undefined;
  }
}

function buildCodexUserAgent(extensionVersion: string): string {
  return `codex-for-copilot/${extensionVersion} (${process.platform}; ${process.arch}; vscode/${vscode.version})`;
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const extension = (context as vscode.ExtensionContext & {
    extension?: { packageJSON?: { version?: unknown } };
  }).extension;
  return typeof extension?.packageJSON?.version === 'string' ? extension.packageJSON.version : '0.0.0';
}
