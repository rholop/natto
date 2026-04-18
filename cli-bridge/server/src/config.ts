import { resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  maxSessions: number;
  stateDir: string;
  orphanTtlMs: number;
  historyPageSize: number;
  toolOutputPreviewBytes: number;
  claudeBinary: string;
  geminiBinary: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 7878,
  host: '127.0.0.1',
  maxSessions: 10,
  stateDir: '.natto',
  orphanTtlMs: 86_400_000,
  historyPageSize: 50,
  toolOutputPreviewBytes: 4096,
  claudeBinary: 'claude',
  geminiBinary: 'gemini',
};

export function resolveStateDir(dir: string, cwd: string = process.cwd()): string {
  return resolve(cwd, dir);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: env.AGUI_BRIDGE_PORT ? Number(env.AGUI_BRIDGE_PORT) : DEFAULT_CONFIG.port,
    host: env.AGUI_BRIDGE_HOST ?? DEFAULT_CONFIG.host,
    maxSessions: env.AGUI_BRIDGE_MAX_SESSIONS
      ? Number(env.AGUI_BRIDGE_MAX_SESSIONS)
      : DEFAULT_CONFIG.maxSessions,
    stateDir: env.AGUI_BRIDGE_STATE_DIR ?? DEFAULT_CONFIG.stateDir,
    orphanTtlMs: env.AGUI_BRIDGE_ORPHAN_TTL_MS
      ? Number(env.AGUI_BRIDGE_ORPHAN_TTL_MS)
      : DEFAULT_CONFIG.orphanTtlMs,
    historyPageSize: env.AGUI_BRIDGE_HISTORY_PAGE_SIZE
      ? Number(env.AGUI_BRIDGE_HISTORY_PAGE_SIZE)
      : DEFAULT_CONFIG.historyPageSize,
    toolOutputPreviewBytes: env.AGUI_BRIDGE_TOOL_OUTPUT_PREVIEW_BYTES
      ? Number(env.AGUI_BRIDGE_TOOL_OUTPUT_PREVIEW_BYTES)
      : DEFAULT_CONFIG.toolOutputPreviewBytes,
    claudeBinary: env.AGUI_BRIDGE_CLAUDE_BINARY ?? DEFAULT_CONFIG.claudeBinary,
    geminiBinary: env.AGUI_BRIDGE_GEMINI_BINARY ?? DEFAULT_CONFIG.geminiBinary,
  };
}

export function parseCliFlags(argv: string[]): Partial<ServerConfig> {
  const out: Partial<ServerConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port':
        out.port = Number(argv[++i]);
        break;
      case '--host':
        out.host = argv[++i] ?? DEFAULT_CONFIG.host;
        break;
      case '--state-dir':
        out.stateDir = argv[++i] ?? DEFAULT_CONFIG.stateDir;
        break;
      case '--max-sessions':
        out.maxSessions = Number(argv[++i]);
        break;
      case '--orphan-ttl-ms':
        out.orphanTtlMs = Number(argv[++i]);
        break;
    }
  }
  return out;
}
