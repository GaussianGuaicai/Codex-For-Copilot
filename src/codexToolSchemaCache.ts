import type { FunctionTool } from 'openai/resources/responses/responses';
import * as vscode from 'vscode';
import { stableSerialize } from './convertMessages';

export interface CodexToolSchemaResolution {
  responseTools: readonly FunctionTool[];
  toolSignatures: Readonly<Record<string, string>>;
  toolSchemaBytes: number;
  cacheHit: boolean;
}

interface CachedToolDefinition {
  cacheKey: string;
  responseTool: FunctionTool;
  signature: string;
}

interface CachedToolSchemaSet {
  responseTools: readonly FunctionTool[];
  toolSignatures: Readonly<Record<string, string>>;
  toolSchemaBytes: number;
  lastUsedAt: number;
}

const MAX_TOOL_SCHEMA_CACHE_ENTRIES = 64;
const EMPTY_RESOLUTION: CodexToolSchemaResolution = {
  responseTools: Object.freeze([]),
  toolSignatures: Object.freeze({}),
  toolSchemaBytes: 0,
  cacheHit: false
};

let definitionsByTool = new WeakMap<vscode.LanguageModelChatTool, CachedToolDefinition>();
const schemasByKey = new Map<string, CachedToolSchemaSet>();

export function resolveCodexToolSchemas(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): CodexToolSchemaResolution {
  if (!tools || tools.length === 0) {
    return EMPTY_RESOLUTION;
  }

  const definitions = tools.map(getCachedToolDefinition);
  const cacheKey = JSON.stringify(definitions.map((definition) => definition.cacheKey));
  const cached = schemasByKey.get(cacheKey);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return {
      responseTools: cached.responseTools,
      toolSignatures: cached.toolSignatures,
      toolSchemaBytes: cached.toolSchemaBytes,
      cacheHit: true
    };
  }

  const responseTools = Object.freeze(definitions.map((definition) => definition.responseTool));
  const toolSignatures = Object.freeze(Object.fromEntries(definitions.map((definition, index) => [
    tools[index].name,
    definition.signature
  ])));
  const entry: CachedToolSchemaSet = {
    responseTools,
    toolSignatures,
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(responseTools)),
    lastUsedAt: Date.now()
  };
  schemasByKey.set(cacheKey, entry);
  evictOverflow();
  return {
    responseTools: entry.responseTools,
    toolSignatures: entry.toolSignatures,
    toolSchemaBytes: entry.toolSchemaBytes,
    cacheHit: false
  };
}

export function resetCodexToolSchemaCache(): void {
  definitionsByTool = new WeakMap<vscode.LanguageModelChatTool, CachedToolDefinition>();
  schemasByKey.clear();
}

function getCachedToolDefinition(tool: vscode.LanguageModelChatTool): CachedToolDefinition {
  const signature = stableSerialize({
    description: tool.description,
    inputSchema: tool.inputSchema ?? null
  });
  const cacheKey = JSON.stringify([tool.name, signature]);
  const cached = definitionsByTool.get(tool);
  if (cached?.cacheKey === cacheKey) {
    return cached;
  }

  const definition: CachedToolDefinition = {
    cacheKey,
    responseTool: Object.freeze({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ? freezeValue(structuredClone(tool.inputSchema) as Record<string, unknown>) : null,
      strict: false
    }),
    signature
  };
  definitionsByTool.set(tool, definition);
  return definition;
}

function evictOverflow(): void {
  if (schemasByKey.size <= MAX_TOOL_SCHEMA_CACHE_ENTRIES) {
    return;
  }

  const oldest = [...schemasByKey.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    .slice(0, schemasByKey.size - MAX_TOOL_SCHEMA_CACHE_ENTRIES);
  for (const [key] of oldest) {
    schemasByKey.delete(key);
  }
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeValue(nested, seen);
  }
  return Object.freeze(value);
}