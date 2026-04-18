import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SessionHolder, ProviderMismatchError } from '../../src/session/holder.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { Provider } from '../../src/protocol/events.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';
import { openSessionLog, writeMeta, type SessionMeta } from '../../src/session/store.js';

function makeHolder(stateDir: string, provider: Provider = 'claude-code', resumeUuid: string | null = null) {
  return new SessionHolder({
    stateDir,
    provider,
    cwd: '/tmp',
    historyPageSize: 10,
    toolOutputPreviewBytes: 1024,
    hookBaseUrl: 'http://127.0.0.1:0',
    adapterFor: (_p: Provider) => new ClaudeCodeAdapter(),
    resumeUuid,
  });
}

describe('SessionHolder', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = makeTempStateDir();
  });
  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('creates a fresh session when no meta.json exists', () => {
    const h = makeHolder(stateDir);
    const s = h.load();
    expect(s.provider).toBe('claude-code');
    expect(s.getState()).toBe('Idle');
  });

  it('load() is idempotent via get()', () => {
    const h = makeHolder(stateDir);
    const s = h.load();
    expect(h.get()).toBe(s);
  });

  it('hydrates existing session from disk', () => {
    const now = Date.now();
    const meta: SessionMeta = {
      provider: 'claude-code',
      cwd: '/tmp',
      cliSessionUuid: 'cli-uuid-1',
      state: 'Streaming',
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(stateDir, meta);
    const log = openSessionLog(stateDir);
    log.append({
      type: 'MESSAGE',
      seq: 1,
      message: {
        messageId: 'u1',
        role: 'user',
        content: 'hi',
        at: now,
        status: 'complete',
      },
    });
    log.close();

    const h = makeHolder(stateDir);
    const s = h.load();
    expect(s.getState()).toBe('Idle');
    expect(s.getMeta().cliSessionUuid).toBe('cli-uuid-1');
  });

  it('appends synthetic interrupted update for open in-flight assistant message', () => {
    const now = Date.now();
    const meta: SessionMeta = {
      provider: 'claude-code',
      cwd: '/tmp',
      cliSessionUuid: null,
      state: 'Streaming',
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(stateDir, meta);
    const log = openSessionLog(stateDir);
    log.append({
      type: 'MESSAGE',
      seq: 1,
      message: {
        messageId: 'a1',
        role: 'assistant',
        content: 'partial',
        at: now,
        status: 'in_progress',
      },
    });
    log.close();

    const h = makeHolder(stateDir);
    h.load();

    const reread = openSessionLog(stateDir).readAll();
    const last = reread[reread.length - 1]!;
    expect(last.type).toBe('MESSAGE_UPDATE');
    if (last.type === 'MESSAGE_UPDATE') {
      expect(last.update.messageId).toBe('a1');
      expect(last.update.status).toBe('interrupted');
    }
    expect(h.get().getState()).toBe('Idle');
  });

  it('throws ProviderMismatchError when provider differs from on-disk meta', () => {
    const now = Date.now();
    writeMeta(stateDir, {
      provider: 'gemini',
      cwd: '/tmp',
      cliSessionUuid: null,
      state: 'Idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    const h = makeHolder(stateDir, 'claude-code');
    expect(() => h.load()).toThrow(ProviderMismatchError);
  });

  it('resumeUuid option overrides on-disk cliSessionUuid', () => {
    const now = Date.now();
    writeMeta(stateDir, {
      provider: 'claude-code',
      cwd: '/tmp',
      cliSessionUuid: 'on-disk-uuid',
      state: 'Idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    const h = makeHolder(stateDir, 'claude-code', 'forced-uuid');
    const s = h.load();
    expect(s.getMeta().cliSessionUuid).toBe('forced-uuid');
  });

  it('resolveHookToken returns the session for the right token only', () => {
    const h = makeHolder(stateDir);
    const s = h.load();
    const token = s.getHookToken();
    expect(h.resolveHookToken(token)).toBe(s);
    expect(h.resolveHookToken('wrong')).toBeUndefined();
  });
});
