import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';

describe('error handling (integration)', () => {
  let server: StartedServer;
  let client: TestWsClient;

  beforeEach(async () => {
    // Each test writes its own scenario.
  });

  afterEach(async () => {
    await client?.disconnect();
    await server?.close();
    delete process.env.MOCK_CLI_SCENARIO;
  });

  it('CLI exiting non-zero emits CLI_ERROR', async () => {
    const scenarioPath = new Scenario('sess_err')
      .turn(null)
      .rawLine('not valid json at all')
      .exit(2, 'boom stderr')
      .writeToFile();
    process.env.MOCK_CLI_SCENARIO = scenarioPath;

    server = await startServer({
      port: 0,
      adapterFor: () => new MockCliAdapter(),
    });
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();

    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');
    await client.send({
      type: 'RUN_STARTED',
      runId: 'run_e',
      sessionId: created.sessionId,
      messages: [{ role: 'user', content: 'anything' }],
    });

    const err = await client.waitFor('CLI_ERROR', 8_000);
    expect(err.reason).toBe('cli_exit_nonzero');
    expect(err.exitCode).toBe(2);
    expect(err.stderr ?? '').toContain('boom stderr');
  });

  it('RUN_STARTED with unknown sessionId emits unknown_session error', async () => {
    const scenarioPath = new Scenario(null).turn(null).text('never runs').endTurn().exit(0).writeToFile();
    process.env.MOCK_CLI_SCENARIO = scenarioPath;

    server = await startServer({
      port: 0,
      adapterFor: () => new MockCliAdapter(),
    });
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();

    await client.send({
      type: 'RUN_STARTED',
      runId: 'run_x',
      sessionId: 'no_such_session',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const err = await client.waitFor('CLI_ERROR', 3_000);
    expect(err.reason).toBe('unknown_session');
  });

  it('approval timeout fires CLI_ERROR with reason approval_timeout', async () => {
    const scenarioPath = new Scenario('sess_timeout')
      .turn(null)
      .toolCall('Read', { file: 'a.ts' }, { id: 'tc_to' })
      .exit(0)
      .writeToFile();
    process.env.MOCK_CLI_SCENARIO = scenarioPath;

    server = await startServer({
      port: 0,
      adapterFor: () => new MockCliAdapter(),
      approvalTimeoutMs: 100,
    });
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();

    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');
    await client.send({
      type: 'RUN_STARTED',
      runId: 'run_t',
      sessionId: created.sessionId,
      messages: [{ role: 'user', content: 'do it' }],
    });

    await client.waitFor('TOOL_CALL_END', 8_000);
    const err = await client.waitFor('CLI_ERROR', 3_000);
    expect(err.reason).toBe('approval_timeout');
  });

  it('malformed client event is logged and ignored (server stays up)', async () => {
    const scenarioPath = new Scenario(null).turn(null).text('ok').endTurn().exit(0).writeToFile();
    process.env.MOCK_CLI_SCENARIO = scenarioPath;

    server = await startServer({
      port: 0,
      adapterFor: () => new MockCliAdapter(),
    });
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();

    // Send garbage directly
    // @ts-expect-error -- deliberately send a non-conforming message
    await client.send({ type: 'GARBAGE', foo: 'bar' });

    // Server should still accept a valid subsequent message.
    await client.send({ type: 'LIST_SESSIONS' });
    const list = await client.waitFor('SESSION_LIST', 3_000);
    expect(list.sessions).toEqual([]);
  });
});
