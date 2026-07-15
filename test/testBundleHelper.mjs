import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

export async function loadBundled(entryPoint, vscodeStub = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-parity-test-'));
  const outfile = join(tempDir, 'bundle.cjs');
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    external: ['vscode']
  });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
  };
  const require = createRequire(import.meta.url);
  try {
    return {
      exports: require(outfile),
      async dispose() {
        Module._load = originalLoad;
        await rm(tempDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    Module._load = originalLoad;
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
