import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  ensureStateDir,
  LockHeldError,
  openSessionLog,
  readMeta,
  writeMeta,
  writeToolResultSidecar,
  readToolResultSidecar,
  type SessionMeta,
} from '../../src/session/store.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

describe('session/store', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempStateDir();
    ensureStateDir(dir);
  });
  afterEach(() => {
    cleanupStateDir(dir);
  });

  function meta(): SessionMeta {
    const now = Date.now();
    return {
      provider: 'claude-code',
      cwd: '/',
      cliSessionUuid: null,
      state: 'Idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  it('writeMeta + readMeta round-trip', () => {
    const m = meta();
    writeMeta(dir, m);
    const read = readMeta(dir);
    expect(read).toEqual(m);
  });

  it('openSessionLog append + readAll + tail + readBefore', () => {
    const log = openSessionLog(dir);
    for (let i = 1; i <= 5; i++) {
      log.append({
        type: 'MESSAGE',
        seq: i,
        message: {
          messageId: `m${i}`,
          role: 'user',
          content: `p${i}`,
          at: i,
          status: 'complete',
        },
      });
    }
    log.close();

    const reopened = openSessionLog(dir);
    expect(reopened.readAll()).toHaveLength(5);
    const tail = reopened.tail(2);
    expect(tail.entries).toHaveLength(2);
    expect(tail.hasMore).toBe(true);
    expect(tail.entries[0]!.seq).toBe(4);

    const page = reopened.readBefore(4, 2);
    expect(page.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(page.hasMore).toBe(true);
    reopened.close();
  });

  it('writeToolResultSidecar + readToolResultSidecar round-trip', async () => {
    writeMeta(dir, meta());
    writeToolResultSidecar(dir, 'tc-1', 'hello world');
    const got = await readToolResultSidecar(dir, 'tc-1');
    expect(got).toBe('hello world');
    const missing = await readToolResultSidecar(dir, 'missing');
    expect(missing).toBeNull();
  });

  it('acquireLock succeeds once and refuses while held by a live pid', () => {
    const handle = acquireLock(dir);
    expect(existsSync(handle.path)).toBe(true);
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
    handle.release();
    expect(existsSync(handle.path)).toBe(false);
  });

  it('acquireLock replaces a stale pidfile (non-existent pid)', () => {
    const stalePath = join(dir, 'bridge.lock');
    ensureStateDir(dir);
    writeFileSync(stalePath, '999999999', 'utf8');
    const handle = acquireLock(dir);
    expect(readFileSync(stalePath, 'utf8').trim()).toBe(String(process.pid));
    handle.release();
  });
});
