import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Session } from '../../src/session/session.js';
import type { CliAdapter, SpawnParams, SpawnSpec } from '../../src/adapters/adapter.js';
import type { CliEvent } from '../../src/protocol/parser.js';
import type { EventSink } from '../../src/protocol/emitter.js';
import type { ServerEvent } from '../../src/protocol/events.js';
import { openSessionLog, writeMeta, type SessionMeta } from '../../src/session/store.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

class EmptyArgvAdapter implements CliAdapter {
  readonly provider = 'claude-code' as const;
  buildSpawn(_p: SpawnParams): SpawnSpec {
    return { argv: [], env: {} };
  }
  parseJsonlLine(_raw: string): CliEvent | null {
    return null;
  }
}

function makeSessionOnDisk(
  stateDir: string,
  adapter: CliAdapter,
  sink?: EventSink,
): Session {
  const now = Date.now();
  const meta: SessionMeta = {
    sessionId: 'sess-unit',
    provider: adapter.provider,
    cwd: process.cwd(),
    cliSessionUuid: null,
    state: 'Idle',
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(stateDir, meta);
  const log = openSessionLog(stateDir, meta.sessionId);
  const session = new Session({
    meta,
    stateDir,
    adapter,
    log,
    historyPageSize: 10,
    toolOutputPreviewBytes: 1024,
    hookBaseUrl: 'http://127.0.0.1:0',
    hookToken: 'test-token',
  });
  if (sink) session.attach(sink);
  return session;
}

describe('Session (unit)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempStateDir();
  });
  afterEach(() => {
    cleanupStateDir(dir);
  });

  it('starts in Idle', () => {
    const s = makeSessionOnDisk(dir, new EmptyArgvAdapter());
    expect(s.getState()).toBe('Idle');
  });

  it('emits user MESSAGE and transitions to Idle when adapter returns empty argv', () => {
    const events: ServerEvent[] = [];
    const sink: EventSink = { send: (e) => events.push(e) };
    const s = makeSessionOnDisk(dir, new EmptyArgvAdapter(), sink);
    s.startTurn('hello');
    expect(s.getState()).toBe('Idle');
    const userMsg = events.find(
      (e) => e.type === 'MESSAGE' && e.message.role === 'user',
    );
    expect(userMsg).toBeDefined();
    const errEvent = events.find((e) => e.type === 'CLI_ERROR');
    expect(errEvent).toBeDefined();
    expect(errEvent?.type === 'CLI_ERROR' && errEvent.reason).toBe('adapter_error');
  });

  it('submitToolResult is a no-op when not AwaitingApproval', () => {
    const events: ServerEvent[] = [];
    const sink: EventSink = { send: (e) => events.push(e) };
    const s = makeSessionOnDisk(dir, new EmptyArgvAdapter(), sink);
    const before = events.length;
    s.submitToolResult({ toolCallId: 'nope', approved: true });
    expect(events.length).toBe(before);
    expect(s.getState()).toBe('Idle');
  });

  it('startTurn while not Idle emits session_busy', () => {
    const events: ServerEvent[] = [];
    const sink: EventSink = { send: (e) => events.push(e) };
    const s = makeSessionOnDisk(dir, new EmptyArgvAdapter(), sink);
    // Force state to simulate a busy session
    (s as unknown as { meta: SessionMeta }).meta = {
      ...(s as unknown as { meta: SessionMeta }).meta,
      state: 'Streaming',
    };
    s.startTurn('second prompt');
    const busy = events.find(
      (e) => e.type === 'CLI_ERROR' && e.reason === 'session_busy',
    );
    expect(busy).toBeDefined();
  });

  it('seq values are monotonic across emits', () => {
    const events: ServerEvent[] = [];
    const sink: EventSink = { send: (e) => events.push(e) };
    const s = makeSessionOnDisk(dir, new EmptyArgvAdapter(), sink);
    s.startTurn('a');
    const seqs = events
      .filter((e) => e.type === 'MESSAGE' || e.type === 'MESSAGE_UPDATE')
      .map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});
