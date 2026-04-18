import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

describe('two bridges in different state dirs (integration)', () => {
  let dirA: string;
  let dirB: string;
  let serverA: StartedServer;
  let serverB: StartedServer;

  beforeEach(() => {
    dirA = makeTempStateDir();
    dirB = makeTempStateDir();
  });

  afterEach(async () => {
    await serverA?.close();
    await serverB?.close();
    cleanupStateDir(dirA);
    cleanupStateDir(dirB);
  });

  it('sessions created on one do not leak to the other', async () => {
    const scenarioPath = new Scenario().turn(null).endTurn().exit(0).writeToFile();
    serverA = await startServer({
      port: 0,
      stateDir: dirA,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    serverB = await startServer({
      port: 0,
      stateDir: dirB,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });

    const a = new TestWsClient(`ws://127.0.0.1:${(serverA.address() as AddressInfo).port}`);
    const b = new TestWsClient(`ws://127.0.0.1:${(serverB.address() as AddressInfo).port}`);
    await a.connect();
    await b.connect();

    await a.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await a.waitFor('SESSION_CREATED');

    await b.send({ type: 'LIST_SESSIONS' });
    const list = await b.waitFor('SESSION_LIST');
    expect(list.sessions.some((s) => s.sessionId === created.sessionId)).toBe(false);

    await a.disconnect();
    await b.disconnect();
  });
});
