import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const workspaceRoot = resolve(import.meta.dirname, '..');
const userDataDir = await mkdtemp(join(resolveTempDirectory(), 'codex-for-copilot-extension-host-'));
const extensionTestsPath = join(workspaceRoot, 'test', 'extensionHostSmoke.cjs');
const resultPath = join(userDataDir, 'extension-host-smoke-result.json');
const commonArgs = [
  `--extensionDevelopmentPath=${workspaceRoot}`,
  `--extensionTestsPath=${extensionTestsPath}`,
  `--user-data-dir=${userDataDir}`,
  '--new-window',
  '--disable-telemetry',
  '--skip-welcome',
  '--disable-gpu'
];

try {
  const result = await runCode(commonArgs, {
    ...process.env,
    CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH: resultPath
  });
  if (result.code !== 0) {
    throw new Error(`Extension Host smoke exited with ${result.code ?? result.signal ?? 'an unknown status'}.`);
  }
  const resultPayload = JSON.parse(await waitForResult(resultPath));
  if (resultPayload.passed !== true) {
    throw new Error('Extension Host smoke did not report a successful tool loop.');
  }
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}

function runCode(args, env) {
  const invocation = process.platform === 'win32'
    ? {
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `call code.cmd ${args.map(quoteForCmd).join(' ')}`]
      }
    : { command: 'code', args };

  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      env,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

async function waitForResult(path) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error('Extension Host smoke did not write its success result within 45 seconds.');
}

function quoteForCmd(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function resolveTempDirectory() {
  const configured = tmpdir();
  if (configured && !configured.startsWith('undefined')) {
    return configured;
  }

  return join(homedir(), 'AppData', 'Local', 'Temp');
}
