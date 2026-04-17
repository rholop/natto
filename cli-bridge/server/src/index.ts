#!/usr/bin/env node
import { startServer } from './server.js';
import { configFromEnv } from './config.js';

async function main(): Promise<void> {
  const config = configFromEnv();
  const logger = (msg: string) => console.error(`[agui-bridge] ${msg}`);
  const server = await startServer({ ...config, logger });
  const addr = server.address();
  console.log(`[agui-bridge] listening on ws://${addr.address}:${addr.port}`);

  const shutdown = async (signal: string) => {
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
