import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

describe('streaming turn (integration)', () => {
  let server: StartedServer;
  let client: TestWsClient;
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempStateDir();
  });

  afterEach(async () => {
    await client?.disconnect();
    await server?.close();
    cleanupStateDir(stateDir);
  });

  it('emits user MESSAGE, assistant MESSAGE with content deltas, then complete status', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .sessionId('cli-uuid-1')
      .assistantText('hello ')
      .assistantText('world')
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();

    server = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();
    await client.waitFor('SNAPSHOT');

    await client.send({ type: 'START_TURN', prompt: 'say hi' });

    await client.waitForMatch(
      (e) =>
        e.type === 'MESSAGE_UPDATE' &&
        e.update.status === 'complete',
      8_000,
      'assistant complete',
    );

    const events = client.all();
    const userMessages = events.filter(
      (e) => e.type === 'MESSAGE' && e.message.role === 'user',
    );
    expect(userMessages).toHaveLength(1);

    const assistantMessage = events.find(
      (e) => e.type === 'MESSAGE' && e.message.role === 'assistant',
    );
    expect(assistantMessage).toBeDefined();

    const deltas = events
      .filter(
        (e): e is Extract<typeof e, { type: 'MESSAGE_UPDATE' }> =>
          e.type === 'MESSAGE_UPDATE' && typeof e.update.contentDelta === 'string',
      )
      .map((e) => e.update.contentDelta!)
      .join('');
    expect(deltas).toBe('hello world');
  });
});
