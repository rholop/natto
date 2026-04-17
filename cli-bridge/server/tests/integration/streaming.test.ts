import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';

describe('streaming turn (integration)', () => {
  let server: StartedServer;
  let client: TestWsClient;

  beforeEach(async () => {
    const scenarioPath = new Scenario('sess_test_stream')
      .turn(null)
      .text('hello ')
      .text('world')
      .endTurn()
      .exit(0)
      .writeToFile();
    process.env.MOCK_CLI_SCENARIO = scenarioPath;

    server = await startServer({
      port: 0,
      adapterFor: () => new MockCliAdapter(),
    });
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.close();
    delete process.env.MOCK_CLI_SCENARIO;
  });

  it('emits TEXT_MESSAGE_START/CONTENT/END then RUN_FINISHED', async () => {
    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');

    await client.send({
      type: 'RUN_STARTED',
      runId: 'run_1',
      sessionId: created.sessionId,
      messages: [{ role: 'user', content: 'say hi' }],
    });

    const finished = await client.waitFor('RUN_FINISHED', 8_000);
    expect(finished.stopReason).toBe('end_turn');

    const events = client.received_copy();
    const types = events.map((e) => e.type);
    expect(types).toContain('TEXT_MESSAGE_START');
    expect(types).toContain('TEXT_MESSAGE_CONTENT');
    expect(types).toContain('TEXT_MESSAGE_END');

    const deltas = events
      .filter((e): e is Extract<typeof e, { type: 'TEXT_MESSAGE_CONTENT' }> => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('');
    expect(deltas).toBe('hello world');
  });
});
