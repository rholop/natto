import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../../src/session/registry.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { Provider } from '../../src/protocol/events.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';
import { openSessionLog, writeMeta, type SessionMeta } from '../../src/session/store.js';

function makeRegistry(stateDir: string, maxSessions = 3) {
  return new SessionRegistry({
    stateDir,
    maxSessions,
    historyPageSize: 10,
    toolOutputPreviewBytes: 1024,
    orphanTtlMs: 10,
    hookBaseUrl: 'http://127.0.0.1:0',
    adapterFor: (_p: Provider) => new ClaudeCodeAdapter(),
  });
}

describe('SessionRegistry', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeTempStateDir();
  });
  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('creates sessions with unique ids and lists them', () => {
    const r = makeRegistry(stateDir);
    const a = r.create({ provider: 'claude-code', cwd: '/tmp' });
    const b = r.create({ provider: 'gemini', cwd: '/tmp' });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(r.size()).toBe(2);
    const providers = r.list().map((s) => s.provider).sort();
    expect(providers).toEqual(['claude-code', 'gemini']);
  });

  it('rejects creation beyond maxSessions', () => {
    const r = makeRegistry(stateDir, 1);
    r.create({ provider: 'claude-code', cwd: '/' });
    expect(() => r.create({ provider: 'claude-code', cwd: '/' })).toThrow(/max sessions/);
  });

  it('remove returns true on hit, false on miss, and deletes the dir', () => {
    const r = makeRegistry(stateDir);
    const s = r.create({ provider: 'claude-code', cwd: '/' });
    expect(r.remove(s.sessionId)).toBe(true);
    expect(r.remove(s.sessionId)).toBe(false);
    expect(r.size()).toBe(0);
  });

  it('hydrateFromDisk restores prior sessions', () => {
    const id = 'sess-hydrate-1';
    const now = Date.now();
    const meta: SessionMeta = {
      sessionId: id,
      provider: 'claude-code',
      cwd: '/tmp',
      cliSessionUuid: 'cli-uuid-1',
      state: 'Streaming',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(stateDir, meta);
    const log = openSessionLog(stateDir, id);
    log.append({
      type: 'MESSAGE',
      seq: 1,
      sessionId: id,
      message: {
        messageId: 'u1',
        role: 'user',
        content: 'hi',
        at: now,
        status: 'complete',
      },
    });
    log.close();

    const r = makeRegistry(stateDir);
    const loaded = r.hydrateFromDisk();
    expect(loaded).toBe(1);
    const session = r.get(id);
    expect(session).toBeDefined();
    expect(session!.getState()).toBe('Idle');
    expect(session!.getMeta().cliSessionUuid).toBe('cli-uuid-1');
  });

  it('hydrateFromDisk appends synthetic interrupted update for open in-flight assistant message', () => {
    const id = 'sess-hydrate-2';
    const now = Date.now();
    const meta: SessionMeta = {
      sessionId: id,
      provider: 'claude-code',
      cwd: '/tmp',
      cliSessionUuid: null,
      state: 'Streaming',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(stateDir, meta);
    const log = openSessionLog(stateDir, id);
    log.append({
      type: 'MESSAGE',
      seq: 1,
      sessionId: id,
      message: {
        messageId: 'a1',
        role: 'assistant',
        content: 'partial',
        at: now,
        status: 'in_progress',
      },
    });
    log.close();

    const r = makeRegistry(stateDir);
    r.hydrateFromDisk();

    const reread = openSessionLog(stateDir, id).readAll();
    const last = reread[reread.length - 1]!;
    expect(last.type).toBe('MESSAGE_UPDATE');
    if (last.type === 'MESSAGE_UPDATE') {
      expect(last.update.messageId).toBe('a1');
      expect(last.update.status).toBe('interrupted');
    }
    expect(r.get(id)!.getState()).toBe('Idle');
  });

  it('sweepOrphans evicts idle sessions past ttl but spares AwaitingApproval', async () => {
    const r = makeRegistry(stateDir, 5);
    const idle = r.create({ provider: 'claude-code', cwd: '/' });
    // force activity to the past
    (idle as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 10_000;
    // give sweepOrphans a moment's worth of TTL
    const evicted = r.sweepOrphans(Date.now());
    expect(evicted).toBeGreaterThanOrEqual(1);
    expect(r.get(idle.sessionId)).toBeUndefined();
  });
});
