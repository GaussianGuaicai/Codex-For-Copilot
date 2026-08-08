import { createToolCallMappingKey, type CodexFunctionCallEvent, type CodexToolPlan } from './nativeToolTypes';

export class UnknownNativeToolCallError extends Error {
  constructor(namespace: string | undefined, name: string) {
    super(`Responses returned an unauthorized native Tool Search function call (${JSON.stringify([namespace ?? null, name])}).`);
    this.name = 'UnknownNativeToolCallError';
  }
}

export function mapNativeToolCall(plan: CodexToolPlan, call: CodexFunctionCallEvent): CodexFunctionCallEvent & { vscodeName: string } {
  const mapping = plan.callMappings.get(createToolCallMappingKey(call.namespace, call.name));
  if (!mapping) {
    throw new UnknownNativeToolCallError(call.namespace, call.name);
  }
  return { ...call, vscodeName: mapping.vscodeName };
}
