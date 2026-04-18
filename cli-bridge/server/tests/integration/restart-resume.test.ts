import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';
import { openSessionLog } from '../../src/session/store.js';

describe('restart + resume (integration)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempStateDir();
  });

  afterEach(() => {
    cleanupStateDir(stateDir);
  });

  it('restart with same stateDir restores prior session', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .sessionId('uuid-first')
      .assistantText('hi')
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();

    const server1 = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    const addr1 = server1.address() as AddressInfo;
    const c1 = new TestWsClient(`ws://127.0.0.1:${addr1.port}`);
    await c1.connect();
    await c1.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await c1.waitFor('SESSION_CREATED');
    await c1.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    await c1.waitFor('SESSION_ATTACHED');
    await c1.send({ type: 'START_TURN', sessionId: created.sessionId, prompt: 'hi there' });
    await c1.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.status === 'complete',
      8_000,
      'complete',
    );
    await c1.disconnect();
    await server1.close();

    const server2 = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    try {
      const addr2 = server2.address() as AddressInfo;
      const c2 = new TestWsClient(`ws://127.0.0.1:${addr2.port}`);
      await c2.connect();
      await c2.send({ type: 'LIST_SESSIONS' });
      const list = await c2.waitFor('SESSION_LIST', 3_000);
      expect(list.sessions.map((s) => s.sessionId)).toContain(created.sessionId);
      const restored = list.sessions.find((s) => s.sessionId === created.sessionId)!;
      expect(restored.state).toBe('Idle');
      await c2.disconnect();
    } finally {
      await server2.close();
    }
  });

  it('dirty log on restart: open assistant message is closed with interrupted', async () => {
    // Manually seed a session dir with an unfinished assistant MESSAGE.
    const id = 'sess-dirty-1';
    const now = Date.now();
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
    // Write a minimal meta.json so the registry picks it up.
    const { writeMeta } = await import('../../src/session/store.js');
    writeMeta(stateDir, {
      sessionId: id,
      provider: 'claude-code',
      cwd: '/',
      cliSessionUuid: null,
      state: 'Streaming',
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
    });

    const server = await startServer({
      port: 0,
      stateDir,
      adapterFor: () =>
        new MockCliAdapter({
          scenarioPath: new Scenario().turn(null).endTurn().exit(0).writeToFile(),
        }),
    });
    try {
      // Read the log from disk — last entry should be a synthetic interrupt.
      const reread = openSessionLog(stateDir, id).readAll();
      const last = reread[reread.length - 1]!;
      expect(last.type).toBe('MESSAGE_UPDATE');
      if (last.type === 'MESSAGE_UPDATE') {
        expect(last.update.status).toBe('interrupted');
      }
      expect(server.registry.get(id)?.getState()).toBe('Idle');
    } finally {
      await server.close();
    }
  });
});
