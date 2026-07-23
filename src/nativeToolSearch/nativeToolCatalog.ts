import type { FunctionTool, NamespaceTool, Tool as OpenAIResponseTool, ToolSearchTool } from 'openai/resources/responses/responses';
import * as vscode from 'vscode';
import { resolveCodexToolSchemas } from '../codexToolSchemaCache';
import { chooseImmediateToolNames, hasVirtualToolPlaceholder, MAX_NAMESPACE_FUNCTIONS } from './nativeToolPolicy';
import { createNativeToolRecords, shortHash, stableSerialize, type NativeToolRecord } from './nativeToolMetadata';
import { createToolCallMappingKey, type CodexToolPlan } from './nativeToolTypes';

export interface ResolveCodexToolPlanOptions {
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
  model: string;
  compatibilityEnabled: boolean;
  nativeToolSearch: 'auto' | 'enabled' | 'disabled';
  extensions: readonly vscode.Extension<any>[];
  nativeToolSearchSupported?: boolean;
}

export function resolveCodexToolPlan(options: ResolveCodexToolPlanOptions): CodexToolPlan {
  const legacy = resolveCodexToolSchemas(options.tools);
  const tools = options.tools ?? [];
  const canUseNative = options.compatibilityEnabled
    && options.nativeToolSearch !== 'disabled'
    && options.nativeToolSearchSupported !== false
    && !hasVirtualToolPlaceholder(tools)
    && (options.nativeToolSearch === 'enabled' || tools.length >= 12);
  if (!canUseNative) {
    return {
      mode: 'legacy', responseTools: legacy.responseTools, toolSignatures: legacy.toolSignatures,
      callMappings: new Map(legacy.responseTools.map((tool) => [createToolCallMappingKey(undefined, tool.name), {
        backendName: tool.name, vscodeName: tool.name
      }])), catalogHash: shortHash(stableSerialize(legacy.responseTools)), originalToolCount: tools.length,
      immediateToolCount: tools.length, deferredToolCount: 0, namespaceCount: 0, toolSchemaBytes: legacy.toolSchemaBytes
    };
  }

  const records = createNativeToolRecords(tools, options.extensions);
  const immediateNames = chooseImmediateToolNames(tools);
  const immediate = records.filter((record) => immediateNames.has(record.originalName));
  const deferred = records.filter((record) => !immediateNames.has(record.originalName));
  const groups = groupDeferredRecords(deferred);
  const mappings = new Map<string, { namespace?: string; backendName: string; vscodeName: string }>();
  const responseTools: OpenAIResponseTool[] = immediate.map((record) => {
    mappings.set(createToolCallMappingKey(undefined, record.originalName), {
      backendName: record.originalName, vscodeName: record.originalName
    });
    return toImmediateTool(record);
  });
  for (const group of groups) {
    responseTools.push({
      type: 'namespace', name: group.namespace, description: group.description,
      tools: group.records.map((record) => {
        mappings.set(createToolCallMappingKey(group.namespace, record.originalName), {
          namespace: group.namespace, backendName: record.originalName, vscodeName: record.originalName
        });
        return toDeferredTool(record);
      })
    } satisfies NamespaceTool);
  }
  responseTools.push({ type: 'tool_search' } satisfies ToolSearchTool);
  const toolSignatures = Object.freeze(Object.fromEntries(records.map((record) => [record.originalName, record.signature])));
  const frozen = Object.freeze(responseTools);
  return {
    mode: 'native-hosted', responseTools: frozen, toolSignatures, callMappings: mappings,
    catalogHash: shortHash(stableSerialize(frozen)), originalToolCount: records.length,
    immediateToolCount: immediate.length, deferredToolCount: deferred.length,
    namespaceCount: groups.length, toolSchemaBytes: Buffer.byteLength(JSON.stringify(frozen))
  };
}

interface NamespaceGroup { namespace: string; description: string; records: NativeToolRecord[] }

function groupDeferredRecords(records: readonly NativeToolRecord[]): NamespaceGroup[] {
  const byKey = new Map<string, NativeToolRecord[]>();
  for (const record of records) {
    const list = byKey.get(record.source.key) ?? [];
    list.push(record);
    byKey.set(record.source.key, list);
  }
  const groups: NamespaceGroup[] = [];
  for (const [key, sourceRecords] of [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...sourceRecords].sort((left, right) => left.originalName.localeCompare(right.originalName));
    for (let index = 0; index < sorted.length; index += MAX_NAMESPACE_FUNCTIONS) {
      const part = sorted.slice(index, index + MAX_NAMESPACE_FUNCTIONS);
      groups.push({
        namespace: createNamespaceName(part[0], index / MAX_NAMESPACE_FUNCTIONS + 1),
        description: part[0].source.description,
        records: part
      });
    }
  }
  return groups.sort((left, right) => left.namespace.localeCompare(right.namespace));
}

function createNamespaceName(record: NativeToolRecord, part: number): string {
  const source = record.source;
  let prefix: string;
  if (source.kind === 'vscode') {
    prefix = `vscode_${source.category}`;
  } else if (source.kind === 'extension') {
    prefix = `ext_${slug(source.extensionId)}`;
  } else {
    prefix = 'private_tools';
  }
  const hash = shortHash(source.key);
  return `${prefix}_${hash}_${String(part).padStart(2, '0')}`.slice(0, 64);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 42) || 'tools';
}

function toImmediateTool(record: NativeToolRecord): FunctionTool {
  return { type: 'function', name: record.originalName, description: record.description,
    parameters: record.inputSchema as Record<string, unknown> | null, strict: false };
}

function toDeferredTool(record: NativeToolRecord): NamespaceTool.Function {
  return { type: 'function', name: record.originalName, description: record.description,
    parameters: record.inputSchema as Record<string, unknown> | null, strict: false, defer_loading: true };
}
