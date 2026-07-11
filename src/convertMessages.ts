import type {
  ResponseFunctionCallOutputItem,
  ResponseFunctionCallOutputItemList,
  ResponseInputImage,
  ResponseInputImageContent,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseInputTextContent
} from 'openai/resources/responses/responses';
import * as vscode from 'vscode';

export type ResponsesInputMessage = ResponseInputItem;

export interface ResponsesInputHistoryComparison {
  kind: 'initial' | 'append' | 'fork';
  matchedPrefixCount: number;
  appendedInput: ResponsesInputMessage[];
  mismatch?: {
    index: number;
    previousItemSummary: string | null;
    currentItemSummary: string | null;
  };
}

const textDecoder = new TextDecoder();
const USAGE_DATA_PART_MIME = 'usage';
const CACHE_CONTROL_DATA_PART_MIME = 'cache_control';
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;
const HISTORY_IMAGE_URI_PLACEHOLDER_PATTERN = /^\[Image was previously shown to you\. Image URI: ([^\]]+)\]$/;
const HISTORY_IMAGE_URI_ANNOTATION_PATTERN = /^\s*\[Image URI: ([^\]]+)\]\s*$/;
const IGNORED_HISTORY_CONTENT = Symbol('ignored-history-content');

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

export function compareResponsesInputHistory(
  previousInput: readonly ResponsesInputMessage[],
  currentInput: readonly ResponsesInputMessage[]
): ResponsesInputHistoryComparison {
  if (previousInput.length === 0) {
    return {
      kind: 'initial',
      matchedPrefixCount: 0,
      appendedInput: [...currentInput]
    };
  }

  if (currentInput.length < previousInput.length) {
    const prefixResult = findMatchingPrefix(previousInput, currentInput);
    return {
      kind: 'fork',
      matchedPrefixCount: prefixResult.matchedPrefixCount,
      appendedInput: [...currentInput],
      mismatch: prefixResult.mismatch
    };
  }

  const prefixResult = findMatchingPrefix(previousInput, currentInput);
  const matchedPrefixCount = prefixResult.matchedPrefixCount;

  if (matchedPrefixCount !== previousInput.length) {
    return {
      kind: 'fork',
      matchedPrefixCount,
      appendedInput: [...currentInput],
      mismatch: prefixResult.mismatch
    };
  }

  return {
    kind: 'append',
    matchedPrefixCount,
    appendedInput: currentInput.slice(matchedPrefixCount)
  };
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortForStableSerialization(value));
}

export function projectResponsesInputForContinuation(
  input: readonly ResponsesInputMessage[]
): ResponsesInputMessage[] {
  return input.filter((item) => {
    if (item.type === 'function_call_output') {
      return true;
    }

    return item.type === 'message' && item.role === 'user';
  });
}

export function summarizeResponsesInputMessageForLog(item: ResponsesInputMessage | undefined): string | null {
  if (!item) {
    return null;
  }

  return stableSerialize(normalizeHistoryItemForComparison(item, createHistoryComparisonNormalizationState())).slice(0, 400);
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
  let bufferedContent: ResponseInputMessageContentList = [];

  const flushText = () => {
    if (!bufferedText.trim()) {
      bufferedText = '';
      return;
    }

    bufferedContent.push({
      type: 'input_text',
      text: bufferedText
    });

    bufferedText = '';
  };

  const flushMessage = () => {
    flushText();

    if (bufferedContent.length === 0) {
      return;
    }

    items.push({
      role,
      content: bufferedContent.length === 1 && bufferedContent[0].type === 'input_text'
        ? bufferedContent[0].text
        : bufferedContent,
      type: 'message'
    });

    bufferedContent = [];
  };

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const image = tryParseMessageImageDataUrl(part.value);
      if (image) {
        flushText();
        bufferedContent.push(image);
        continue;
      }

      bufferedText += part.value;
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const image = dataPartToMessageImage(part);
      if (image) {
        flushText();
        bufferedContent.push(image);
        continue;
      }

      const serialized = serializeDataPart(part);
      if (serialized.length > 0) {
        bufferedText += serialized;
      }
      continue;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      flushMessage();
      items.push({
        type: 'function_call',
        call_id: part.callId,
        name: part.name,
        arguments: stableJsonStringify(part.input ?? {})
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      flushMessage();
      items.push({
        type: 'function_call_output',
        call_id: part.callId,
        output: serializeToolResultContent(part.content)
      });
    }
  }

  flushMessage();
  return items;
}

function serializeToolResultContent(content: readonly unknown[]): string | ResponseFunctionCallOutputItemList {
  const outputItems: ResponseFunctionCallOutputItemList = [];
  const textSegments: string[] = [];

  const flushTextSegments = () => {
    if (textSegments.length === 0) {
      return;
    }

    outputItems.push({
      type: 'input_text',
      text: textSegments.join('\n\n')
    });
    textSegments.length = 0;
  };

  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const image = tryParseToolOutputImageDataUrl(part.value);
      if (image) {
        flushTextSegments();
        outputItems.push(image);
        continue;
      }

      if (part.value.length > 0) {
        textSegments.push(part.value);
      }
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const image = dataPartToToolOutputImage(part);
      if (image) {
        flushTextSegments();
        outputItems.push(image);
        continue;
      }

      const serialized = serializeDataPart(part);
      if (serialized.length > 0) {
        textSegments.push(serialized);
      }
      continue;
    }

    const serialized = stableJsonStringify(part);
    if (serialized.length > 0) {
      textSegments.push(serialized);
    }
  }

  flushTextSegments();

  if (outputItems.length === 0) {
    return '';
  }

  if (outputItems.every((item) => item.type === 'input_text')) {
    return outputItems
      .map((item) => (item as ResponseInputTextContent).text)
      .join('\n\n');
  }

  return outputItems;
}

function serializeDataPart(part: vscode.LanguageModelDataPart): string {
  const mimeType = part.mimeType.toLowerCase();

  if (mimeType === USAGE_DATA_PART_MIME || mimeType === CACHE_CONTROL_DATA_PART_MIME) {
    return '';
  }

  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('javascript')) {
    return textDecoder.decode(part.data);
  }

  return `[binary data: ${part.mimeType}, ${part.data.byteLength} bytes]`;
}

function dataPartToMessageImage(part: vscode.LanguageModelDataPart): ResponseInputImage | undefined {
  if (!part.mimeType.toLowerCase().startsWith('image/') || part.data.byteLength === 0) {
    return undefined;
  }

  return {
    detail: 'auto',
    type: 'input_image',
    image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`
  };
}

function dataPartToToolOutputImage(part: vscode.LanguageModelDataPart): ResponseInputImageContent | undefined {
  const image = dataPartToMessageImage(part);
  if (!image) {
    return undefined;
  }

  return {
    type: image.type,
    detail: image.detail,
    image_url: image.image_url,
    file_id: image.file_id
  };
}

function tryParseMessageImageDataUrl(value: string): ResponseInputImage | undefined {
  const trimmed = value.trim();
  if (!IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    return undefined;
  }

  return {
    detail: 'auto',
    type: 'input_image',
    image_url: trimmed
  };
}

function tryParseToolOutputImageDataUrl(value: string): ResponseInputImageContent | undefined {
  const image = tryParseMessageImageDataUrl(value);
  if (!image) {
    return undefined;
  }

  return {
    type: image.type,
    detail: image.detail,
    image_url: image.image_url,
    file_id: image.file_id
  };
}

function stableJsonStringify(value: unknown): string {
  try {
    return stableSerialize(value);
  } catch {
    return String(value);
  }
}

function countMatchingPrefix(
  previousInput: readonly ResponsesInputMessage[],
  currentInput: readonly ResponsesInputMessage[]
): number {
  return findMatchingPrefix(previousInput, currentInput).matchedPrefixCount;
}

function findMatchingPrefix(
  previousInput: readonly ResponsesInputMessage[],
  currentInput: readonly ResponsesInputMessage[]
): {
  matchedPrefixCount: number;
  mismatch?: {
    index: number;
    previousItemSummary: string | null;
    currentItemSummary: string | null;
  };
} {
  const maxLength = Math.min(previousInput.length, currentInput.length);
  const previousNormalizationState = createHistoryComparisonNormalizationState();
  const currentNormalizationState = createHistoryComparisonNormalizationState();

  for (let index = 0; index < maxLength; index += 1) {
    const previousItem = normalizeHistoryItemForComparison(previousInput[index], previousNormalizationState);
    const currentItem = normalizeHistoryItemForComparison(currentInput[index], currentNormalizationState);

    if (stableSerialize(previousItem) !== stableSerialize(currentItem)) {
      return {
        matchedPrefixCount: index,
        mismatch: {
          index,
          previousItemSummary: stableSerialize(previousItem).slice(0, 400),
          currentItemSummary: stableSerialize(currentItem).slice(0, 400)
        }
      };
    }
  }

  return {
    matchedPrefixCount: maxLength
  };
}

function createHistoryComparisonNormalizationState(): {
  callIdAliases: Map<string, string>;
  nextCallOrdinal: number;
} {
  return {
    callIdAliases: new Map<string, string>(),
    nextCallOrdinal: 1
  };
}

function normalizeHistoryItemForComparison(
  item: ResponsesInputMessage,
  state: {
    callIdAliases: Map<string, string>;
    nextCallOrdinal: number;
  }
): unknown {
  if (item.type === 'message') {
    return {
      ...item,
      content: normalizeHistoryRichContentForComparison(item.content, 'message')
    };
  }

  if (item.type === 'function_call') {
    return {
      ...item,
      call_id: canonicalizeHistoryCallId(item.call_id, state)
    };
  }

  if (item.type === 'function_call_output') {
    const canonicalCallId = canonicalizeHistoryCallId(item.call_id, state);
    return {
      ...item,
      call_id: canonicalCallId,
      output: normalizeHistoryRichContentForComparison(item.output, `${canonicalCallId}:output`)
    };
  }

  return item;
}

function normalizeHistoryRichContentForComparison(content: unknown, imageRefPrefix: string): unknown {
  const imageOrdinal = { current: 1 };
  if (typeof content === 'string') {
    const normalizedImage = normalizeHistoryImageString(content, imageRefPrefix, imageOrdinal);
    if (normalizedImage) {
      return [normalizedImage];
    }
  }

  const normalized = normalizeHistoryRichContentNode(content, imageRefPrefix, imageOrdinal, true);
  return normalized === IGNORED_HISTORY_CONTENT ? [] : normalized;
}

function normalizeHistoryRichContentNode(
  value: unknown,
  imageRefPrefix: string,
  imageOrdinal: { current: number },
  allowBareStringImage: boolean
): unknown {
  if (typeof value === 'string') {
    if (allowBareStringImage) {
      const normalizedImage = normalizeHistoryImageString(value, imageRefPrefix, imageOrdinal);
      if (normalizedImage) {
        return normalizedImage;
      }
    }

    if (isIgnorableHistoryText(value)) {
      return IGNORED_HISTORY_CONTENT;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeHistoryRichContentNode(entry, imageRefPrefix, imageOrdinal, true))
      .filter((entry) => entry !== IGNORED_HISTORY_CONTENT);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === 'input_image') {
    return createNormalizedHistoryImage(record, imageRefPrefix, imageOrdinal);
  }

  if (record.type === 'input_text' && typeof record.text === 'string') {
    const normalizedImage = normalizeHistoryImageString(record.text, imageRefPrefix, imageOrdinal);
    if (normalizedImage) {
      return normalizedImage;
    }

    if (isIgnorableHistoryText(record.text)) {
      return IGNORED_HISTORY_CONTENT;
    }
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entryValue]) => [
      key,
      normalizeHistoryRichContentNode(entryValue, imageRefPrefix, imageOrdinal, false)
    ])
  );
}

function normalizeHistoryImageString(
  value: string,
  imageRefPrefix: string,
  imageOrdinal: { current: number }
): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!IMAGE_DATA_URL_PATTERN.test(trimmed) && !HISTORY_IMAGE_URI_PLACEHOLDER_PATTERN.test(trimmed)) {
    return undefined;
  }

  return createNormalizedHistoryImage({
    type: 'input_image',
    detail: 'auto',
    image_url: trimmed
  }, imageRefPrefix, imageOrdinal);
}

function isIgnorableHistoryText(value: string): boolean {
  return HISTORY_IMAGE_URI_ANNOTATION_PATTERN.test(value.trim());
}

function createNormalizedHistoryImage(
  image: Record<string, unknown>,
  imageRefPrefix: string,
  imageOrdinal: { current: number }
): Record<string, unknown> {
  const comparisonImageRef = `${imageRefPrefix}:image_${imageOrdinal.current++}`;
  const imageURL = typeof image.image_url === 'string' ? image.image_url.trim() : undefined;

  return {
    type: 'input_image',
    detail: image.detail ?? 'auto',
    comparison_image_ref: comparisonImageRef,
    comparison_media_type: inferComparisonImageMediaType(imageURL)
  };
}

function inferComparisonImageMediaType(imageURL: string | undefined): string | undefined {
  if (!imageURL) {
    return undefined;
  }

  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(imageURL);
  if (dataUrlMatch) {
    return dataUrlMatch[1].toLowerCase();
  }

  const placeholderMatch = HISTORY_IMAGE_URI_PLACEHOLDER_PATTERN.exec(imageURL);
  if (!placeholderMatch) {
    return undefined;
  }

  const extensionMatch = /\.([a-z0-9]+)$/i.exec(placeholderMatch[1]);
  if (!extensionMatch) {
    return undefined;
  }

  switch (extensionMatch[1].toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    default:
      return `image/${extensionMatch[1].toLowerCase()}`;
  }
}

function canonicalizeHistoryCallId(
  callId: string,
  state: {
    callIdAliases: Map<string, string>;
    nextCallOrdinal: number;
  }
): string {
  const existingAlias = state.callIdAliases.get(callId);
  if (existingAlias) {
    return existingAlias;
  }

  const alias = `call_${state.nextCallOrdinal++}`;
  state.callIdAliases.set(callId, alias);
  return alias;
}

function sortForStableSerialization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForStableSerialization(item));
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableSerialization(entryValue)]);

    return Object.fromEntries(entries);
  }

  return value;
}
