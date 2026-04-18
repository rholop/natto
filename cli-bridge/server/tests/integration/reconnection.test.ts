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
    await c1.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await c1.waitFor('SESSION_CREATED');
    await c1.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    await c1.waitFor('SESSION_ATTACHED');
    await c1.send({ type: 'START_TURN', sessionId: created.sessionId, prompt: 'read it' });

    // Wait until the session is AwaitingApproval: the tool_call MESSAGE must have arrived.
    await c1.waitForMatch(
      (e) => e.type === 'MESSAGE' && e.message.role === 'tool_call',
      5_000,
      'tool_call message',
    );
    await c1.disconnect();

    // Fresh client attaches — snapshot should show pending tool call.
    const c2 = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await c2.connect();
    await c2.send({ type: 'LIST_SESSIONS' });
    const list = await c2.waitFor('SESSION_LIST', 3_000);
    expect(list.sessions.map((s) => s.sessionId)).toContain(created.sessionId);

    await c2.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    const snapshot = await c2.waitFor('SESSION_SNAPSHOT', 3_000);
    expect(snapshot.state).toBe('AwaitingApproval');
    expect(snapshot.pendingToolCall).not.toBeNull();

    await c2.send({
      type: 'TOOL_CALL_RESULT',
      sessionId: created.sessionId,
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
    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');
    await client.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    await client.waitFor('SESSION_ATTACHED');
    await client.send({ type: 'START_TURN', sessionId: created.sessionId, prompt: 'go' });
    await client.waitForMatch(
      (e) => e.type === 'MESSAGE_UPDATE' && e.update.status === 'complete',
      8_000,
      'complete',
    );

    // Re-attach with a fresh socket to get a snapshot based on history.
    await client.disconnect();
    const c2 = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await c2.connect();
    await c2.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    const snap = await c2.waitFor('SESSION_SNAPSHOT', 3_000);
    expect(snap.hasMore).toBe(true);
    expect(snap.recent.length).toBeLessThanOrEqual(2);

    const earliestSeq = snap.recent[0]?.seq ?? snap.lastSeq;
    await c2.send({
      type: 'FETCH_HISTORY',
      sessionId: created.sessionId,
      beforeSeq: earliestSeq,
      limit: 10,
      requestId: 'r1',
    });
    const page = await c2.waitFor('HISTORY_PAGE', 3_000);
    expect(page.requestId).toBe('r1');
    expect(page.entries.length).toBeGreaterThan(0);
    await c2.disconnect();
  });

  it('orphan sweep leaves AwaitingApproval sessions alone even after ttl elapses', async () => {
    const scenarioPath = new Scenario()
      .turn(null)
      .toolCall('Read', { file: 'a.ts' }, { toolCallId: 'tc-exempt' })
      .exit(0)
      .writeToFile();

    server = await startServer({
      port: 0,
      stateDir,
      orphanTtlMs: 10,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    const addr = server.address() as AddressInfo;
    const client = new TestWsClient(`ws://127.0.0.1:${addr.port}`);
    await client.connect();
    await client.send({ type: 'CREATE_SESSION', provider: 'claude-code', cwd: process.cwd() });
    const created = await client.waitFor('SESSION_CREATED');
    await client.send({ type: 'ATTACH_SESSION', sessionId: created.sessionId });
    await client.waitFor('SESSION_ATTACHED');
    await client.send({ type: 'START_TURN', sessionId: created.sessionId, prompt: 'go' });
    await client.waitForMatch(
      (e) => e.type === 'MESSAGE' && e.message.role === 'tool_call',
      5_000,
      'tool_call',
    );
    await client.disconnect();

    // Let TTL fire.
    await new Promise((r) => setTimeout(r, 50));
    server.registry.sweepOrphans();
    expect(server.registry.get(created.sessionId)).toBeDefined();
  });
});
