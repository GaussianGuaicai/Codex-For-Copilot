import type { Tool as OpenAIResponseTool } from 'openai/resources/responses/responses';

export type CodexToolPlanMode = 'legacy' | 'native-hosted';

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
