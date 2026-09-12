import * as vscode from 'vscode';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { getProviderConfig, type ProviderConfig } from '../config';
import { getApiCredentials, type ApiCredentials } from '../secrets';
import type { CodexAuthManager } from '../auth/codexAuthManager';
import { getCodexCompatibilityProfile, type CodexRequestIdentity } from '../codexProtocol';
import { resolveRequestIdentity } from '../codexRequestIdentity';
import { buildProviderModels, fetchAvailableModels } from '../models';
import {
  buildDynamicHeaders,
  createResponsesClient,
  normalizeResponsesError
} from '../responsesClient';
import { extractWebSearchSources, type WebSearchSource } from './hostedToolEvents';
import { buildWebSearchTool } from './hostedToolPlan';

const WEB_SEARCH_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const WEB_SEARCH_MAX_SOURCES = 10;

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
 * request-identity, and Responses client plumbing, and never participates in
 * conversation continuation or Native Tool Search.
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
  const clientIdentity = resolveRequestIdentity({
    ...config.requestIdentity,
    extensionVersion: getExtensionVersion(dependencies.context),
    extensionUserAgent: buildCodexUserAgent(getExtensionVersion(dependencies.context))
  });
  const model = await resolveWebSearchModel(config, credentials, token, clientIdentity);
  const identity = compatibilityProfile.enabled
    ? await dependencies.createIdentity?.()
    : undefined;

  const abortController = new AbortController();
  const cancellation = token.onCancellationRequested(() => abortController.abort());
  try {
    const client = createResponsesClient({
      apiKey: credentials.apiKey,
      baseURL: config.baseURL,
      headers: credentials.headers,
      authManager: credentials.authManager,
      accountKey: credentials.accountKey,
      compatibilityProfile,
      requestCompression: config.requestCompression
    });
    const headers = buildDynamicHeaders({
      compatibilityProfile,
      identity,
      headers: credentials.headers,
      protocolSettings: config.protocol,
      clientIdentity
    }, 'http');

    const response = await client.responses.create({
      model,
      input: [{ role: 'user', content: query }] satisfies ResponseInputItem[],
      tools: [buildWebSearchTool(config.webSearch)],
      // The hosted web_search tool is the only tool in this request, so
      // `required` forces the model to search instead of answering from memory.
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      store: false
    }, {
      headers,
      signal: abortController.signal,
      maxRetries: 0,
      timeout: WEB_SEARCH_REQUEST_TIMEOUT_MS
    });

    return {
      answer: typeof response.output_text === 'string' ? response.output_text : '',
      sources: dedupeWebSearchSources(response.output)
    };
  } catch (error) {
    if (token.isCancellationRequested || abortController.signal.aborted) {
      throw new vscode.CancellationError();
    }
    throw normalizeResponsesError(error, config.baseURL);
  } finally {
    cancellation.dispose();
  }
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

function dedupeWebSearchSources(output: readonly unknown[] | undefined): WebSearchSource[] {
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  for (const item of output ?? []) {
    for (const source of extractWebSearchSources(item)) {
      if (seen.has(source.url)) {
        continue;
      }
      seen.add(source.url);
      sources.push(source);
      if (sources.length >= WEB_SEARCH_MAX_SOURCES) {
        return sources;
      }
    }
  }
  return sources;
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
