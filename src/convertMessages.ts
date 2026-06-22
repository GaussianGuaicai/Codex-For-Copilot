import type { ResponseInputItem } from 'openai/resources/responses/responses';
import * as vscode from 'vscode';

export type ResponsesInputMessage = ResponseInputItem;

const textDecoder = new TextDecoder();

export function convertMessagesToResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesInputMessage[] {
  return messages.flatMap((message) => convertMessageToResponsesInput(message));
}

export function estimateTokenCount(value: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof value === 'string') {
    return Math.ceil(value.length / 4);
  }

  const serialized = JSON.stringify(convertMessagesToResponsesInput([value]));
  return serialized === '[]' ? 0 : Math.max(1, Math.ceil(serialized.length / 4));
}

export function getTextFromMessage(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        return serializeDataPart(part);
      }

      return '';
    })
    .join('');
}

function convertMessageToResponsesInput(message: vscode.LanguageModelChatRequestMessage): ResponsesInputMessage[] {
  const items: ResponsesInputMessage[] = [];
  const role = message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
  let bufferedText = '';

  const flushText = () => {
    if (!bufferedText.trim()) {
      bufferedText = '';
      return;
    }

    items.push({
      role,
      content: bufferedText,
      type: 'message'
    });

    bufferedText = '';
  };

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      bufferedText += part.value;
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      bufferedText += serializeDataPart(part);
      continue;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      flushText();
      items.push({
        type: 'function_call',
        call_id: part.callId,
        name: part.name,
        arguments: safeJsonStringify(part.input ?? {})
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      flushText();
      items.push({
        type: 'function_call_output',
        call_id: part.callId,
        output: serializeToolResultContent(part.content)
      });
    }
  }

  flushText();
  return items;
}

function serializeToolResultContent(content: readonly unknown[]): string {
  return content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        return serializeDataPart(part);
      }

      return safeJsonStringify(part);
    })
    .filter((value) => value.length > 0)
    .join('\n\n');
}

function serializeDataPart(part: vscode.LanguageModelDataPart): string {
  const mimeType = part.mimeType.toLowerCase();

  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('javascript')) {
    return textDecoder.decode(part.data);
  }

  return `[binary data: ${part.mimeType}, ${part.data.byteLength} bytes]`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
