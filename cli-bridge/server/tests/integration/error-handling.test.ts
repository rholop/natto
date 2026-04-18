import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

describe('error handling (integration)', () => {
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

  it('CLI exiting non-zero emits CLI_ERROR', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .rawLine('not valid json at all')
      .exit(2, 'boom stderr')
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

    await client.send({ type: 'START_TURN', prompt: 'anything' });

    const err = await client.waitForMatch(
      (e) => e.type === 'CLI_ERROR' && e.reason === 'cli_exit_nonzero',
      8_000,
      'cli_exit_nonzero',
    );
    if (err.type !== 'CLI_ERROR') throw new Error('unreachable');
    expect(err.exitCode).toBe(2);
    expect(err.stderr ?? '').toContain('boom stderr');
  });

  it('malformed client event yields CLI_ERROR(invalid_message) but server stays up', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .assistantText('ok')
      .endTurn()
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

    // @ts-expect-error -- deliberately send a non-conforming message
    await client.send({ type: 'GARBAGE', foo: 'bar' });
    await client.waitForMatch(
      (e) => e.type === 'CLI_ERROR' && e.reason === 'invalid_message',
      3_000,
      'invalid_message',
    );

    // A valid subsequent turn should still run.
    await client.send({ type: 'START_TURN', prompt: 'hi' });
    await client.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.status === 'complete',
      8_000,
      'turn complete',
    );
  });
});
