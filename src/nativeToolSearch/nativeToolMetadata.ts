import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

export type NativeToolSource =
  | { kind: 'vscode'; category: string; key: string; description: string }
  | { kind: 'extension'; extensionId: string; displayName?: string; key: string; description: string }
  | { kind: 'private'; key: string; description: string };

export interface NativeToolRecord {
  originalName: string;
  description: string;
  inputSchema: object | null;
  signature: string;
  source: NativeToolSource;
}

const BUILT_IN_CATEGORY: readonly [RegExp, string][] = [
  [/\b(read|open|cat|stat)\b/i, 'read'],
  [/(search|grep|find)/i, 'search'],
  [/(edit|write|replace|patch)/i, 'edit'],
  [/(terminal|command|run|execute|shell)/i, 'execute'],
  [/(test|diagnostic|error|problem)/i, 'testing'],
  [/(web|browser|fetch)/i, 'web'],
  [/(todo|agent|plan)/i, 'agent']
];

export function createNativeToolRecords(
  tools: readonly vscode.LanguageModelChatTool[],
  extensions: readonly vscode.Extension<any>[]
): NativeToolRecord[] {
  const extensionTools = new Map<string, { id: string; displayName?: string }>();
  for (const extension of extensions) {
    const contributed = readContributedToolNames(extension.packageJSON);
    for (const name of contributed) {
      extensionTools.set(name, { id: extension.id, displayName: extension.packageJSON?.displayName });
    }
  }

  return [...tools].sort((left, right) => left.name.localeCompare(right.name)).map((tool) => {
    const source = classify(tool.name, extensionTools.get(tool.name));
    const inputSchema = tool.inputSchema ? structuredClone(tool.inputSchema) as object : null;
    return {
      originalName: tool.name,
      description: tool.description ?? '',
      inputSchema,
      signature: stableSerialize({ description: tool.description ?? '', inputSchema }),
      source
    };
  });
}

function classify(name: string, extension: { id: string; displayName?: string } | undefined): NativeToolSource {
  if (extension) {
    return {
      kind: 'extension',
      extensionId: extension.id,
      displayName: extension.displayName,
      key: `ext:${extension.id.toLowerCase()}`,
      description: `Tools provided by the ${extension.displayName ?? extension.id} extension.`
    };
  }
  const category = BUILT_IN_CATEGORY.find(([pattern]) => pattern.test(name))?.[1];
  if (category) {
    return { kind: 'vscode', category, key: `vscode:${category}`, description: `VS Code ${category} tools.` };
  }
  const hash = shortHash(name);
  return { kind: 'private', key: `private:${hash}`, description: 'Private or workspace-provided tools.' };
}

function readContributedToolNames(packageJSON: unknown): string[] {
  const root = packageJSON as { contributes?: { languageModelTools?: unknown } } | undefined;
  const tools = root?.contributes?.languageModelTools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    if (typeof tool === 'string') {
      return [tool];
    }
    if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
      return [(tool as { name: string }).name];
    }
    return [];
  });
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
