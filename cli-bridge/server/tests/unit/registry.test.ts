import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../../src/session/registry.js';
import { CallbackEmitter } from '../../src/protocol/emitter.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { Provider } from '../../src/protocol/events.js';

function makeRegistry(maxSessions = 3) {
  return new SessionRegistry({
    maxSessions,
    approvalTimeoutMs: 1_000,
    adapterFor: (_p: Provider) => new ClaudeCodeAdapter(),
  });
}

describe('SessionRegistry', () => {
  it('creates sessions with unique ids', () => {
    const r = makeRegistry();
    const emitter = new CallbackEmitter(() => {});
    const a = r.create({ provider: 'claude-code', cwd: '/tmp', emitter });
    const b = r.create({ provider: 'claude-code', cwd: '/tmp', emitter });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(r.size()).toBe(2);
  });

  it('get returns the session by id', () => {
    const r = makeRegistry();
    const emitter = new CallbackEmitter(() => {});
    const s = r.create({ provider: 'gemini', cwd: '/w', emitter });
    expect(r.get(s.sessionId)).toBe(s);
    expect(r.get('nope')).toBeUndefined();
  });

  it('list returns all session infos', () => {
    const r = makeRegistry();
    const emitter = new CallbackEmitter(() => {});
    r.create({ provider: 'claude-code', cwd: '/a', emitter });
    r.create({ provider: 'gemini', cwd: '/b', emitter });
    expect(r.list()).toHaveLength(2);
    const providers = r.list().map((s) => s.provider).sort();
    expect(providers).toEqual(['claude-code', 'gemini']);
  });

  it('remove returns true on hit and false on miss', () => {
    const r = makeRegistry();
    const emitter = new CallbackEmitter(() => {});
    const s = r.create({ provider: 'claude-code', cwd: '/a', emitter });
    expect(r.remove(s.sessionId)).toBe(true);
    expect(r.remove(s.sessionId)).toBe(false);
    expect(r.size()).toBe(0);
  });

  it('rejects creation beyond maxSessions', () => {
    const r = makeRegistry(2);
    const emitter = new CallbackEmitter(() => {});
    r.create({ provider: 'claude-code', cwd: '/', emitter });
    r.create({ provider: 'claude-code', cwd: '/', emitter });
    expect(() =>
      r.create({ provider: 'claude-code', cwd: '/', emitter }),
    ).toThrow(/max sessions/);
  });
});
