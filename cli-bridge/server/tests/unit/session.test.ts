import { describe, expect, it } from 'vitest';
import { Session } from '../../src/session/session.js';
import { SessionState } from '../../src/session/types.js';
import { CallbackEmitter } from '../../src/protocol/emitter.js';
import type { CliAdapter, SpawnOptions, ToolCallResult } from '../../src/adapters/adapter.js';
import type { CliEvent } from '../../src/protocol/parser.js';
import type { ServerEvent } from '../../src/protocol/events.js';

class BrokenArgvAdapter implements CliAdapter {
  readonly provider = 'claude-code' as const;
  buildArgv(_opts: SpawnOptions): string[] {
    return [];
  }
  parseJsonlLine(_raw: string): CliEvent | null {
    return null;
  }
  buildResumePrompt(_r: ToolCallResult): string {
    return '';
  }
}

describe('Session state machine (unit)', () => {
  const makeSession = (
    adapter: CliAdapter = new BrokenArgvAdapter(),
    sink: (e: ServerEvent) => void = () => {},
  ) =>
    new Session({
      sessionId: 'sess_unit',
      provider: adapter.provider,
      cwd: process.cwd(),
      adapter,
      emitter: new CallbackEmitter(sink),
      approvalTimeoutMs: 1_000,
    });

  it('starts in Idle', () => {
    const s = makeSession();
    expect(s.getState()).toBe(SessionState.Idle);
  });

  it('emits CLI_ERROR and stays Idle when adapter returns empty argv', () => {
    const events: ServerEvent[] = [];
    const s = makeSession(new BrokenArgvAdapter(), (e) => events.push(e));
    s.startTurn('run_1', 'hi');
    // Synchronous error before any child is spawned.
    expect(s.getState()).toBe(SessionState.Idle);
    const err = events.find((e) => e.type === 'CLI_ERROR');
    expect(err).toBeDefined();
    expect(err?.type === 'CLI_ERROR' && err.reason).toBe('adapter_error');
  });

  it('submitToolResult is a no-op when not in AwaitingApproval', () => {
    const events: ServerEvent[] = [];
    const s = makeSession(new BrokenArgvAdapter(), (e) => events.push(e));
    s.submitToolResult('tc_unknown', true, 'result');
    expect(events).toHaveLength(0);
    expect(s.getState()).toBe(SessionState.Idle);
  });

  it('abort on an Idle session is a no-op', () => {
    const s = makeSession();
    s.abort('test');
    expect(s.getState()).toBe(SessionState.Idle);
  });

  it('startTurn on a busy session emits session_busy CLI_ERROR', () => {
    const events: ServerEvent[] = [];
    // Adapter that spawns `node -e 'setInterval(()=>{},1000)'` (stays alive).
    class HangAdapter implements CliAdapter {
      readonly provider = 'claude-code' as const;
      buildArgv(_o: SpawnOptions): string[] {
        return ['node', '-e', 'setInterval(()=>{}, 1000)'];
      }
      parseJsonlLine(_r: string): CliEvent | null {
        return null;
      }
      buildResumePrompt(_r: ToolCallResult): string {
        return '';
      }
    }
    const s = makeSession(new HangAdapter(), (e) => events.push(e));
    s.startTurn('run_1', 'hi');
    // State should be Streaming shortly after spawn.
    s.startTurn('run_2', 'again');
    const busy = events.find(
      (e) => e.type === 'CLI_ERROR' && (e as Extract<ServerEvent, { type: 'CLI_ERROR' }>).reason === 'session_busy',
    );
    expect(busy).toBeDefined();
    s.abort('cleanup');
  });
});
