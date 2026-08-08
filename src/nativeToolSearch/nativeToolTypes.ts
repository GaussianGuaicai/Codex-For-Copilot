import type { Tool as OpenAIResponseTool } from 'openai/resources/responses/responses';

export type CodexToolPlanMode = 'legacy' | 'native-hosted';

export type NativeToolSearchPlanReason =
  | 'native-enabled'
  | 'compatibility-disabled'
  | 'disabled-by-setting'
  | 'backend-unsupported'
  | 'virtual-tools-active'
  | 'auto-tool-count-below-threshold'
  | 'auto-deferred-schema-small';

export interface CodexToolCallMapping {
  namespace?: string;
  backendName: string;
  vscodeName: string;
}

export interface CodexToolPlan {
  mode: CodexToolPlanMode;
  responseTools: readonly OpenAIResponseTool[];
  toolSignatures: Readonly<Record<string, string>>;
  callMappings: ReadonlyMap<string, CodexToolCallMapping>;
  catalogHash: string;
  originalToolCount: number;
  immediateToolCount: number;
  deferredToolCount: number;
  namespaceCount: number;
  toolSchemaBytes: number;
  deferredToolSchemaBytes: number;
  /** True only when a native catalog was reused from the local bounded cache. */
  nativeToolCatalogCacheHit?: boolean;
  /** True only when legacy function schemas were reused from their local cache. */
  legacyToolSchemaCacheHit?: boolean;
  nativeToolSearchReason: NativeToolSearchPlanReason;
}

export interface CodexFunctionCallEvent {
  itemId: string;
  callId: string;
  name: string;
  namespace?: string;
  input: object;
}

export function createToolCallMappingKey(namespace: string | undefined, name: string): string {
  return JSON.stringify([namespace ?? null, name]);
}
