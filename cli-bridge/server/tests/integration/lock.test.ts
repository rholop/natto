import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type StartedServer } from '../../src/server.js';
import { Scenario } from '../harness/scenario.js';
import { MockCliAdapter } from '../harness/mock-adapter.js';
import { makeTempStateDir, cleanupStateDir } from '../harness/fs-harness.js';
import { LockHeldError } from '../../src/session/store.js';

describe('bridge.lock contention (integration)', () => {
  let stateDir: string;
  let first: StartedServer;

  beforeEach(() => {
    stateDir = makeTempStateDir();
  });

  afterEach(async () => {
    await first?.close();
    cleanupStateDir(stateDir);
  });

  it('a second bridge against the same stateDir fails with LockHeldError', async () => {
    const scenarioPath = new Scenario().turn(null).endTurn().exit(0).writeToFile();
    first = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });

    await expect(
      startServer({
        port: 0,
        stateDir,
        adapterFor: () => new MockCliAdapter({ scenarioPath }),
      }),
    ).rejects.toBeInstanceOf(LockHeldError);
  });

  it('after the first bridge closes, a second can acquire the lock', async () => {
    const scenarioPath = new Scenario().turn(null).endTurn().exit(0).writeToFile();
    first = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    await first.close();
    first = undefined as unknown as StartedServer;

    const second = await startServer({
      port: 0,
      stateDir,
      adapterFor: () => new MockCliAdapter({ scenarioPath }),
    });
    try {
      expect(second.stateDir).toContain('natto');
    } finally {
      await second.close();
    }
  });
});
