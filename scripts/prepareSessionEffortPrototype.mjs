import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = join(root, 'work', 'session-effort-extension');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.enabledApiProposals = [...new Set([...(manifest.enabledApiProposals ?? []), 'chatProvider'])];
await mkdir(destination, { recursive: true });
for (const name of ['out', 'assets', 'README.md', 'LICENSE']) {
  await cp(join(root, name), join(destination, name), { recursive: true, force: true });
}
await writeFile(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared experimental extension at ${destination}`);
console.log('Requires the accompanying patched VS Code and Copilot build. Stock VS Code has no immediate picker bridge.');
