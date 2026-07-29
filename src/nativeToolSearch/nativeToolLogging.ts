export interface NativeToolSearchLogEntry {
  event: 'search_call' | 'search_output';
  execution: string | null;
  status: string | null;
  paths?: string[];
  loadedNamespaceCount?: number;
  loadedFunctionCount?: number;
  loadedNamespaces?: Array<{ name: string; functionNames: string[] }>;
}

export function summarizeNativeToolSearchItem(item: unknown): NativeToolSearchLogEntry | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const type = stringValue(item.type);
  if (type === 'tool_search_call') {
    return {
      event: 'search_call',
      execution: stringValue(item.execution),
      status: stringValue(item.status),
      paths: stringValues(isRecord(item.arguments) ? item.arguments.paths : undefined)
    };
  }
  if (type !== 'tool_search_output') {
    return undefined;
  }

  const loadedNamespaces = namespaceSummaries(item.tools);
  return {
    event: 'search_output',
    execution: stringValue(item.execution),
    status: stringValue(item.status),
    loadedNamespaceCount: loadedNamespaces.length,
    loadedFunctionCount: loadedNamespaces.reduce((total, namespace) => total + namespace.functionNames.length, 0),
    loadedNamespaces
  };
}

function namespaceSummaries(value: unknown): Array<{ name: string; functionNames: string[] }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const summaries: Array<{ name: string; functionNames: string[] }> = [];
  for (const tool of value) {
    if (!isRecord(tool)) {
      continue;
    }
    const name = stringValue(tool.name);
    if (!name) {
      continue;
    }
    if (tool.type === 'namespace') {
      summaries.push({ name, functionNames: functionNames(tool.tools) });
      continue;
    }
    if (tool.type === 'function') {
      const standalone = summaries.find((summary) => summary.name === 'standalone');
      if (standalone) {
        standalone.functionNames.push(name);
      } else {
        summaries.push({ name: 'standalone', functionNames: [name] });
      }
    }
  }
  return summaries;
}

function functionNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((tool) => isRecord(tool) ? [stringValue(tool.name)].filter((name): name is string => Boolean(name)) : []);
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => [stringValue(entry)].filter((item): item is string => Boolean(item))) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
