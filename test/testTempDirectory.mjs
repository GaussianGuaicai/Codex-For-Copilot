import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveTestTempDirectory() {
  const configured = tmpdir();
  if (configured && !configured.startsWith('undefined')) {
    return configured;
  }

  return join(homedir(), 'AppData', 'Local', 'Temp');
}
