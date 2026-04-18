#!/usr/bin/env node
import { startServer } from './server.js';
import { configFromEnv, parseCliFlags, resolveStateDir } from './config.js';
import { LockHeldError } from './session/store.js';

async function main(): Promise<void> {
  const fromEnv = configFromEnv();
  const fromFlags = parseCliFlags(process.argv.slice(2));
  const config = { ...fromEnv, ...fromFlags };
  const logger = (msg: string) => console.error(`[agui-bridge] ${msg}`);

  let server;
  try {
    server = await startServer({ ...config, logger });
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(`[agui-bridge] cannot start: ${err.message}`);
      console.error('[agui-bridge] another bridge is using this state directory.');
      process.exit(2);
    }
    throw err;
  }

  const addr = server.address();
  console.log(
    `[agui-bridge] listening on ws://${addr.address}:${addr.port} (state: ${resolveStateDir(config.stateDir)})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[agui-bridge] received ${signal}, shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[agui-bridge] fatal:', err);
  process.exit(1);
});
