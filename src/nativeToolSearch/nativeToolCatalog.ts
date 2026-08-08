import type { FunctionTool, NamespaceTool, Tool as OpenAIResponseTool, ToolSearchTool } from 'openai/resources/responses/responses';
import * as vscode from 'vscode';
import { resolveCodexToolSchemas } from '../codexToolSchemaCache';
import {
  chooseImmediateToolNames,
  hasVirtualToolPlaceholder,
  MAX_NAMESPACE_FUNCTIONS,
  NATIVE_TOOL_SEARCH_THRESHOLD,
  shouldAutoEnableNativeToolSearch
} from './nativeToolPolicy';
import { createNativeToolRecords, shortHash, stableSerialize, type NativeToolRecord } from './nativeToolMetadata';
import { createToolCallMappingKey, type CodexToolPlan, type NativeToolSearchPlanReason } from './nativeToolTypes';

export interface ResolveCodexToolPlanOptions {
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
  model: string;
  compatibilityEnabled: boolean;
  nativeToolSearch: 'auto' | 'enabled' | 'disabled';
  maxToolsPerNamespace?: number;
  extensions: readonly vscode.Extension<any>[];
  nativeToolSearchSupported?: boolean;
}

interface CachedNativeToolCatalog {
  plan: CodexToolPlan;
  lastUsedAt: number;
}

const MAX_NATIVE_TOOL_CATALOG_CACHE_ENTRIES = 32;
const nativeToolCatalogsByKey = new Map<string, CachedNativeToolCatalog>();

export function resolveCodexToolPlan(options: ResolveCodexToolPlanOptions): CodexToolPlan {
  const legacy = resolveCodexToolSchemas(options.tools);
  const tools = options.tools ?? [];
  const shouldEstimateDeferredSchemas = options.compatibilityEnabled
    && options.nativeToolSearch === 'auto'
    && options.nativeToolSearchSupported !== false
    && !hasVirtualToolPlaceholder(tools)
    && tools.length >= NATIVE_TOOL_SEARCH_THRESHOLD;
  let immediateNames = shouldEstimateDeferredSchemas ? chooseImmediateToolNames(tools) : undefined;
  let deferredToolSchemaBytes = immediateNames ? estimateDeferredToolSchemaBytes(tools, immediateNames) : 0;
  const nativeToolSearchReason = getNativeToolSearchPlanReason(options, deferredToolSchemaBytes);
  const canUseNative = nativeToolSearchReason === 'native-enabled';
  if (!canUseNative) {
    return {
      mode: 'legacy', responseTools: legacy.responseTools, toolSignatures: legacy.toolSignatures,
      callMappings: new Map(legacy.responseTools.map((tool) => [createToolCallMappingKey(undefined, tool.name), {
        backendName: tool.name, vscodeName: tool.name
      }])), catalogHash: shortHash(stableSerialize(legacy.responseTools)), originalToolCount: tools.length,
      immediateToolCount: tools.length, deferredToolCount: 0, namespaceCount: 0, toolSchemaBytes: legacy.toolSchemaBytes,
      deferredToolSchemaBytes, legacyToolSchemaCacheHit: legacy.cacheHit, nativeToolSearchReason
    };
  }

  const cacheKey = createNativeToolCatalogCacheKey(options, tools);
  const cached = nativeToolCatalogsByKey.get(cacheKey);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return { ...cached.plan, nativeToolCatalogCacheHit: true };
  }

  const records = createNativeToolRecords(tools, options.extensions);
  immediateNames ??= chooseImmediateToolNames(tools);
  if (deferredToolSchemaBytes === 0) {
    deferredToolSchemaBytes = estimateDeferredToolSchemaBytes(tools, immediateNames);
  }
  const immediate = records.filter((record) => immediateNames.has(record.originalName));
  const deferred = records.filter((record) => !immediateNames.has(record.originalName));
  const groups = groupDeferredRecords(deferred, normalizeMaxToolsPerNamespace(options.maxToolsPerNamespace));
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
  const plan: CodexToolPlan = {
    mode: 'native-hosted', responseTools: frozen, toolSignatures, callMappings: mappings,
    catalogHash: shortHash(stableSerialize(frozen)), originalToolCount: records.length,
    immediateToolCount: immediate.length, deferredToolCount: deferred.length,
    namespaceCount: groups.length, toolSchemaBytes: Buffer.byteLength(JSON.stringify(frozen)),
    deferredToolSchemaBytes, nativeToolCatalogCacheHit: false, nativeToolSearchReason
  };
  nativeToolCatalogsByKey.set(cacheKey, { plan, lastUsedAt: Date.now() });
  evictNativeToolCatalogCacheOverflow();
  return plan;
}

export function resetNativeToolCatalogCache(): void {
  nativeToolCatalogsByKey.clear();
}

function getNativeToolSearchPlanReason(
  options: ResolveCodexToolPlanOptions,
  deferredToolSchemaBytes: number
): NativeToolSearchPlanReason {
  const tools = options.tools ?? [];
  if (!options.compatibilityEnabled) {
    return 'compatibility-disabled';
  }
  if (options.nativeToolSearch === 'disabled') {
    return 'disabled-by-setting';
  }
  if (options.nativeToolSearchSupported === false) {
    return 'backend-unsupported';
  }
  if (hasVirtualToolPlaceholder(tools)) {
    return 'virtual-tools-active';
  }
  if (options.nativeToolSearch === 'enabled') {
    return 'native-enabled';
  }
  if (tools.length < NATIVE_TOOL_SEARCH_THRESHOLD) {
    return 'auto-tool-count-below-threshold';
  }
  return shouldAutoEnableNativeToolSearch(tools.length, deferredToolSchemaBytes)
    ? 'native-enabled'
    : 'auto-deferred-schema-small';
}

function estimateDeferredToolSchemaBytes(
  tools: readonly vscode.LanguageModelChatTool[],
  immediateNames: ReadonlySet<string>
): number {
  const deferred = tools
    .filter((tool) => !immediateNames.has(tool.name))
    .map((tool) => ({ description: tool.description ?? '', inputSchema: tool.inputSchema ?? null }));
  return Buffer.byteLength(stableSerialize(deferred));
}

interface NamespaceGroup { namespace: string; description: string; records: NativeToolRecord[] }

function groupDeferredRecords(records: readonly NativeToolRecord[], maxToolsPerNamespace: number): NamespaceGroup[] {
  const byKey = new Map<string, NativeToolRecord[]>();
  for (const record of records) {
    const list = byKey.get(record.source.key) ?? [];
    list.push(record);
    byKey.set(record.source.key, list);
  }
  const groups: NamespaceGroup[] = [];
  for (const [key, sourceRecords] of [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...sourceRecords].sort((left, right) => left.originalName.localeCompare(right.originalName));
    for (let index = 0; index < sorted.length; index += maxToolsPerNamespace) {
      const part = sorted.slice(index, index + maxToolsPerNamespace);
      groups.push({
        namespace: createNamespaceName(part[0], index / maxToolsPerNamespace + 1),
        description: part[0].source.description,
        records: part
      });
    }
  }
  return groups.sort((left, right) => left.namespace.localeCompare(right.namespace));
}

function normalizeMaxToolsPerNamespace(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_NAMESPACE_FUNCTIONS;
  }
  return Math.min(MAX_NAMESPACE_FUNCTIONS, Math.max(1, Math.floor(value)));
}

function createNativeToolCatalogCacheKey(
  options: ResolveCodexToolPlanOptions,
  tools: readonly vscode.LanguageModelChatTool[]
): string {
  return stableSerialize({
    maxToolsPerNamespace: normalizeMaxToolsPerNamespace(options.maxToolsPerNamespace),
    tools: [...tools].sort((left, right) => left.name.localeCompare(right.name)).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? null
    })),
    extensions: options.extensions.map((extension) => ({
      id: extension.id,
      displayName: extension.packageJSON?.displayName,
      languageModelTools: (extension.packageJSON as { contributes?: { languageModelTools?: unknown } } | undefined)
        ?.contributes?.languageModelTools ?? null
    })).sort((left, right) => left.id.localeCompare(right.id))
  });
}

function evictNativeToolCatalogCacheOverflow(): void {
  if (nativeToolCatalogsByKey.size <= MAX_NATIVE_TOOL_CATALOG_CACHE_ENTRIES) {
    return;
  }
  const oldest = [...nativeToolCatalogsByKey.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
    .slice(0, nativeToolCatalogsByKey.size - MAX_NATIVE_TOOL_CATALOG_CACHE_ENTRIES);
  for (const [key] of oldest) {
    nativeToolCatalogsByKey.delete(key);
  }
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
