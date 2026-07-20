import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const workspaceRoot = resolve(import.meta.dirname, '..');
const userDataDir = await mkdtemp(join(resolveTempDirectory(), 'codex-for-copilot-extension-host-'));
const testHome = join(userDataDir, 'home');
const extensionTestsPath = join(workspaceRoot, 'test', 'extensionHostSmoke.cjs');
const resultPath = join(userDataDir, 'extension-host-smoke-result.json');
const launchArgs = [
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${join(userDataDir, 'extensions')}`,
  '--new-window',
  '--disable-extensions',
  '--disable-updates',
  '--disable-telemetry',
  '--skip-welcome',
  '--disable-gpu'
];

try {
  await mkdir(join(testHome, '.codex'), { recursive: true });
  await writeFile(
    join(testHome, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'extension-host-smoke-token' } })
  );
  await mkdir(join(userDataDir, 'User'), { recursive: true });
  await writeFile(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ 'codexModelProvider.includeHiddenModels': true })
  );

  const vscodeExecutablePath = resolveLocalCodeExecutable();
  await runTests({
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath,
    extensionTestsEnv: {
      CODEX_EXTENSION_HOST_SMOKE_RESULT_PATH: resultPath,
      HOME: testHome,
      USERPROFILE: testHome
    },
    launchArgs,
    ...(vscodeExecutablePath
      ? { vscodeExecutablePath }
      : { version: process.env.VSCODE_TEST_VERSION ?? '1.104.3' })
  });
  const resultPayload = JSON.parse(await readFile(resultPath, 'utf8'));
  if (resultPayload.passed !== true) {
    throw new Error('Extension Host smoke did not report successful profile transitions and a complete tool loop.');
  }
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}

function resolveLocalCodeExecutable() {
  const configuredExecutable = process.env.VSCODE_EXECUTABLE_PATH?.trim();
  if (configuredExecutable) {
    return configuredExecutable;
  }

  if (process.env.CI === 'true') {
    return undefined;
  }

  const macOSExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  if (process.platform === 'darwin' && existsSync(macOSExecutable)) {
    return macOSExecutable;
  }

  return undefined;
}

function resolveTempDirectory() {
  if (process.platform === 'darwin') {
    return '/tmp';
  }

  const configured = tmpdir();
  if (configured && !configured.startsWith('undefined')) {
    return configured;
  }

  return join(homedir(), 'AppData', 'Local', 'Temp');
}
