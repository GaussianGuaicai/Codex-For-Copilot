import type { CodexToolPlan } from './nativeToolTypes';

export interface NativeToolSearchRuntimeStatus {
  recordedAt: number;
  model: string;
  setting: 'auto' | 'enabled' | 'disabled';
  mode: CodexToolPlan['mode'];
  reason: CodexToolPlan['nativeToolSearchReason'] | 'backend-rejected';
  selectedToolCount: number;
  immediateToolCount: number;
  deferredToolCount: number;
  namespaceCount: number;
  deferredToolSchemaBytes: number;
  virtualToolPlaceholderCount: number;
}

let lastNativeToolSearchRuntimeStatus: NativeToolSearchRuntimeStatus | undefined;

export function recordNativeToolSearchRuntimeStatus(options: {
  model: string;
  setting: 'auto' | 'enabled' | 'disabled';
  plan: CodexToolPlan;
  virtualToolPlaceholderCount: number;
  reason?: NativeToolSearchRuntimeStatus['reason'];
}): void {
  lastNativeToolSearchRuntimeStatus = {
    recordedAt: Date.now(),
    model: options.model,
    setting: options.setting,
    mode: options.plan.mode,
    reason: options.reason ?? options.plan.nativeToolSearchReason,
    selectedToolCount: options.plan.originalToolCount,
    immediateToolCount: options.plan.immediateToolCount,
    deferredToolCount: options.plan.deferredToolCount,
    namespaceCount: options.plan.namespaceCount,
    deferredToolSchemaBytes: options.plan.deferredToolSchemaBytes,
    virtualToolPlaceholderCount: options.virtualToolPlaceholderCount
  };
}

export function getNativeToolSearchRuntimeStatus(): NativeToolSearchRuntimeStatus | undefined {
  return lastNativeToolSearchRuntimeStatus;
}
