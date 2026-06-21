import OpenAI from 'openai';
import type * as vscode from 'vscode';
import type { ResponsesInputMessage } from './convertMessages';

export interface StreamResponseTextOptions {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  omitMaxOutputTokens?: boolean;
  model: string;
  instructions: string;
  input: ResponsesInputMessage[];
  maxOutputTokens: number;
  token: vscode.CancellationToken;
  onTextDelta: (text: string) => void;
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

    const request = {
      model: options.model,
      instructions: options.instructions,
      input: options.input,
      stream: true,
      store: false,
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

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+(responses|chat\/completions|completions)\/?$/i, '').replace(/\/+$/, '');
}
