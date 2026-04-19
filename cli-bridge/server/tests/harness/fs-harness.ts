import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempStateDir(prefix = 'natto-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupStateDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
