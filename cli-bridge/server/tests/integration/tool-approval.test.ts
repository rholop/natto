import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

async function startWith(
  scenarioPath: string,
  stateDir: string,
): Promise<StartedServer> {
  return startServer({
    port: 0,
    stateDir,
    adapterFor: () => new MockCliAdapter({ scenarioPath }),
  });
}

describe('tool approval flow (integration)', () => {
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

  it('approved path: tool_call MESSAGE, approval update, result update, end', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .assistantText('I will read the file. ')
      .toolCall('Read', { file_path: 'src/auth.ts' }, {
        toolCallId: 'tc_read_1',
        onApprove: { result: 'file contents here' },
      })
      .assistantText('Done.')
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();

    server = await startWith(scenarioPath, stateDir);
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();
    await client.waitFor('SNAPSHOT');

    await client.send({ type: 'START_TURN', prompt: 'refactor' });

    const toolCallMsg = await client.waitForMatch(
      (e) => e.type === 'MESSAGE' && e.message.role === 'tool_call',
      8_000,
      'tool_call message',
    );
    if (toolCallMsg.type !== 'MESSAGE' || toolCallMsg.message.role !== 'tool_call') {
      throw new Error('unreachable');
    }
    expect(toolCallMsg.message.name).toBe('Read');
    expect(toolCallMsg.message.approval).toBe('pending');

    await client.send({
      type: 'TOOL_CALL_RESULT',
      toolCallId: toolCallMsg.message.toolCallId,
      approved: true,
    });

    await client.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.approval === 'approved',
      5_000,
      'approval update',
    );

    await client.waitForMatch(
      (e) =>
        e.type === 'MESSAGE_UPDATE' &&
        e.update.messageId === toolCallMsg.message.messageId &&
        e.update.result !== undefined,
      8_000,
      'tool result',
    );
  });

  it('denied path: approval=denied, turn still completes', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .toolCall('Write', { file_path: '/etc/passwd' }, {
        toolCallId: 'tc_bad',
        onDeny: { skipText: '(skipped Write)' },
      })
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();

    server = await startWith(scenarioPath, stateDir);
    const addr = server.address() as AddressInfo;
    client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();
    await client.waitFor('SNAPSHOT');

    await client.send({ type: 'START_TURN', prompt: 'do' });

    const toolCallMsg = await client.waitForMatch(
      (e) => e.type === 'MESSAGE' && e.message.role === 'tool_call',
      8_000,
      'tool_call message',
    );
    if (toolCallMsg.type !== 'MESSAGE' || toolCallMsg.message.role !== 'tool_call') {
      throw new Error('unreachable');
    }

    await client.send({
      type: 'TOOL_CALL_RESULT',
      toolCallId: toolCallMsg.message.toolCallId,
      approved: false,
      reason: 'unsafe',
    });

    await client.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.approval === 'denied',
      5_000,
      'denial update',
    );
  });
});
