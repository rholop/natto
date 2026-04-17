import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';

async function startWithScenario(scenarioPath: string): Promise<StartedServer> {
  process.env.MOCK_CLI_SCENARIO = scenarioPath;
  return startServer({
    port: 0,
    adapterFor: () => new MockCliAdapter(),
    approvalTimeoutMs: 60_000,
  });
}

describe('tool approval flow (integration)', () => {
  let server: StartedServer;
  let client: TestWsClient;

  afterEach(async () => {
    await client.disconnect();
    await server.close();
    delete process.env.MOCK_CLI_SCENARIO;
  });

  it('emits TOOL_CALL events, resumes after approval, finishes', async () => {
    const scenarioPath = new Scenario('sess_approval')
      .turn(null)
      .text('I will read the file.')
      .toolCall('Read', { file_path: 'src/auth.ts' }, { id: 'tc_read_1' })
      .exit(0)
      .turn('sess_approval')
      .text('Done. Here is the result.')
      .endTurn()
      .exit(0)
      .writeToFile();

    server = await startWithScenario(scenarioPath);
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();

    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');

    await client.send({
      type: 'RUN_STARTED',
      runId: 'run_1',
      sessionId: created.sessionId,
      messages: [{ role: 'user', content: 'refactor auth.ts' }],
    });

    const toolEnd = await client.waitFor('TOOL_CALL_END', 8_000);
    const events = client.received_copy();
    const types = events.map((e) => e.type);
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_ARGS');
    expect(types).toContain('TOOL_CALL_END');

    const startEv = events.find(
      (e): e is Extract<typeof e, { type: 'TOOL_CALL_START' }> => e.type === 'TOOL_CALL_START',
    );
    expect(startEv?.toolCallName).toBe('Read');
    expect(startEv?.toolCallId).toBe(toolEnd.toolCallId);

    await client.send({
      type: 'TOOL_CALL_RESULT',
      toolCallId: toolEnd.toolCallId,
      approved: true,
      content: 'file contents here',
    });

    const finished = await client.waitFor('RUN_FINISHED', 8_000);
    expect(finished.stopReason).toBe('end_turn');
  });

  it('rejection path also proceeds to RUN_FINISHED', async () => {
    const scenarioPath = new Scenario('sess_reject')
      .turn(null)
      .toolCall('Write', { file_path: '/etc/passwd' }, { id: 'tc_write_bad' })
      .exit(0)
      .turn('sess_reject')
      .text('OK, skipping that.')
      .endTurn()
      .exit(0)
      .writeToFile();

    server = await startWithScenario(scenarioPath);
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();

    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');

    await client.send({
      type: 'RUN_STARTED',
      runId: 'run_reject',
      sessionId: created.sessionId,
      messages: [{ role: 'user', content: 'do the thing' }],
    });

    const toolEnd = await client.waitFor('TOOL_CALL_END', 8_000);
    await client.send({
      type: 'TOOL_CALL_RESULT',
      toolCallId: toolEnd.toolCallId,
      approved: false,
    });

    const finished = await client.waitFor('RUN_FINISHED', 8_000);
    expect(finished.stopReason).toBe('end_turn');
  });
});
