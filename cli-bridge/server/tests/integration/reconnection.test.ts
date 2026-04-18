import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type StartedServer } from '../../src/server.js';
import { TestWsClient } from '../harness/ws-client.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';

describe('reconnection + resume (integration)', () => {
  let server: StartedServer;
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempStateDir();
  });

  afterEach(async () => {
    await server?.close();
    cleanupStateDir(stateDir);
  });

  it('client can disconnect while AwaitingApproval, reconnect, and finish the turn', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .toolCall('Read', { file: 'a.ts' }, {
        toolCallId: 'tc-resume',
        onApprove: { result: 'contents' },
      })
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();

    server = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    const addr = server.address() as AddressInfo;

    const c1 = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await c1.connect();
    await c1.waitFor('SNAPSHOT');
    await c1.send({ type: 'START_TURN', prompt: 'read it' });

    await c1.waitForMatch(
      (e) => e.type === 'MESSAGE' && e.message.role === 'tool_call',
      5_000,
      'tool_call message',
    );
    await c1.disconnect();

    const c2 = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await c2.connect();
    const snapshot = await c2.waitFor('SNAPSHOT', 3_000);
    expect(snapshot.state).toBe('AwaitingApproval');
    expect(snapshot.pendingToolCall).not.toBeNull();

    await c2.send({
      type: 'TOOL_CALL_RESULT',
      toolCallId: snapshot.pendingToolCall!.toolCallId,
      approved: true,
    });

    await c2.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.approval === 'approved',
      5_000,
      'approval',
    );
    await c2.disconnect();
  });

  it('FETCH_HISTORY returns earlier page when history exceeds page size', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .assistantText('one ')
      .assistantText('two ')
      .assistantText('three ')
      .assistantText('four ')
      .assistantText('five')
      .endTurn('end_turn')
      .exit(0)
      .writeToFile();
    server = await startServer({
      port: 0,
      stateDir,
      historyPageSize: 2,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    const addr = server.address() as AddressInfo;

    const client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();
    await client.waitFor('SNAPSHOT');
    await client.send({ type: 'START_TURN', prompt: 'go' });
    await client.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.status === 'complete',
      8_000,
      'complete',
    );

    await client.disconnect();
    const c2 = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await c2.connect();
    const snap = await c2.waitFor('SNAPSHOT', 3_000);
    expect(snap.hasMore).toBe(true);
    expect(snap.recent.length).toBeLessThanOrEqual(2);

    const earliestSeq = snap.recent[0]?.seq ?? snap.lastSeq;
    await c2.send({
      type: 'FETCH_HISTORY',
      beforeSeq: earliestSeq,
      limit: 10,
      requestId: 'r1',
    });
    const page = await c2.waitFor('HISTORY_PAGE', 3_000);
    expect(page.requestId).toBe('r1');
    expect(page.entries.length).toBeGreaterThan(0);
    await c2.disconnect();
  });
});
