import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';
import type { ServerEvent } from '../../src/protocol/events.js';

describe('multi-client fan-out (integration)', () => {
  let server: StartedServer;
  let stateDir: string;
  const clients: TestWsClient[] = [];

  beforeEach(() => {
    stateDir = makeTempStateDir();
  });

  afterEach(async () => {
    for (const c of clients) await c.disconnect();
    clients.length = 0;
    await server?.close();
    cleanupStateDir(stateDir);
  });

  it('two attached clients see the same ordered MESSAGE/MESSAGE_UPDATE stream', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .assistantText('part1 ')
      .assistantText('part2')
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();

    server = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    const addr = server.address() as AddressInfo;

    const a = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    const b = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    clients.push(a, b);
    await a.connect();
    await b.connect();

    await a.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await a.waitFor('SESSION_CREATED');
    await a.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    await b.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    await a.waitFor('SESSION_ATTACHED');
    await b.waitFor('SESSION_ATTACHED');

    await a.send({
      type: 'START_TURN',
      sessionId: created.sessionId,
      prompt: 'go',
    });

    const endPredicate = (e: ServerEvent) =>
      e.type === 'MESSAGE_UPDATE' && e.update.status === 'complete';
    await a.waitForMatch(endPredicate, 8_000, 'a complete');
    await b.waitForMatch(endPredicate, 8_000, 'b complete');

    const streamA = a.all().filter(
      (e) => e.type === 'MESSAGE' || e.type === 'MESSAGE_UPDATE',
    );
    const streamB = b.all().filter(
      (e) => e.type === 'MESSAGE' || e.type === 'MESSAGE_UPDATE',
    );
    expect(streamA.map((e) => e.seq)).toEqual(streamB.map((e) => e.seq));
    expect(streamA).toEqual(streamB);
  });
});
