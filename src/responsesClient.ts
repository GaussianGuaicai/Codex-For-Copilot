import OpenAI from 'openai';
import type { FunctionTool, ToolChoiceOptions } from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
import * as vscode from 'vscode';
import type { ResponsesInputMessage } from './convertMessages';

export interface StreamResponseTextOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  omitMaxOutputTokens?: boolean;
  model: string;
  instructions: string;
  input: ResponsesInputMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
  toolMode?: vscode.LanguageModelChatToolMode;
  reasoning?: Reasoning;
  maxOutputTokens: number;
  token: vscode.CancellationToken;
  onTextDelta: (text: string) => void;
  onToolCall?: (callId: string, name: string, input: object) => void;
}

export async function streamResponseText(options: StreamResponseTextOptions): Promise<void> {
  const abortController = new AbortController();
  const cancellation = options.token.onCancellationRequested(() => abortController.abort());

  try {
    if (!options.instructions.trim()) {
      throw new Error('Codex Model Provider requires a non-empty top-level instructions setting.');
    }

    const client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: normalizeBaseURL(options.baseURL),
      defaultHeaders: options.headers,
      maxRetries: 0
    });

    const tools = options.tools?.map(convertToolToResponseTool) ?? [];
    const request = {
      model: options.model,
      instructions: options.instructions,
      input: options.input,
      stream: true,
      store: false,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(tools.length > 0
        ? {
            tools,
            tool_choice: mapToolChoice(options.toolMode)
          }
        : {}),
      ...(options.omitMaxOutputTokens ? {} : { max_output_tokens: options.maxOutputTokens })
    } as const;

    const stream = await client.responses.create(
      request,
      {
        signal: abortController.signal
      }
    );

    for await (const event of stream) {
      if (options.token.isCancellationRequested) {
        abortController.abort();
        return;
      }

      if (event.type === 'response.output_text.delta') {
        options.onTextDelta(event.delta);
        continue;
      }

      if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
        options.onToolCall?.(event.item.call_id, event.item.name, parseToolCallInput(event.item.arguments));
        continue;
      }

      if (event.type === 'response.failed') {
        const error = event.response.error;
        throw new Error(error?.message ?? 'Responses API request failed.');
      }
    }
  } catch (error) {
    if (options.token.isCancellationRequested || abortController.signal.aborted) {
      return;
    }

    throw normalizeResponsesError(error, options.baseURL);
  } finally {
    cancellation.dispose();
  }
}

function convertToolToResponseTool(tool: vscode.LanguageModelChatTool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParameters(tool.inputSchema),
    strict: false
  };
}

function normalizeToolParameters(inputSchema: object | undefined): { [key: string]: unknown } | null {
  return inputSchema ? (inputSchema as { [key: string]: unknown }) : null;
}

function mapToolChoice(toolMode: vscode.LanguageModelChatToolMode | undefined): ToolChoiceOptions {
  return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

function parseToolCallInput(argumentsJson: string): object {
  if (!argumentsJson.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsJson);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }

    return { value: parsed };
  } catch {
    return { _raw: argumentsJson };
  }
}

function normalizeResponsesError(error: unknown, baseURL: string): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
    return new Error(`Connection failure while contacting ChatGPT Codex Responses endpoint at ${baseURL}. Check codexModelProvider.baseURL. ${message}`);
  }

  if (message.includes('401') || /unauthorized|invalid api key/i.test(message)) {
    return new Error(`Responses API authentication failed. Check the stored API key or ~/.codex/auth.json credentials. ${message}`);
  }

  return error instanceof Error ? error : new Error(message);
}

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+(responses|chat\/completions|completions)\/?$/i, '').replace(/\/+$/, '');
}
