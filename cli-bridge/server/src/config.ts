import { resolve } from 'node:path';
import { PROVIDERS, type Provider } from './protocol/events.js';

export interface ServerConfig {
  port: number;
  host: string;
  provider: Provider;
  cwd: string;
  stateDir: string;
  historyPageSize: number;
  toolOutputPreviewBytes: number;
  claudeBinary: string;
  geminiBinary: string;
  resumeUuid: string | null;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 7878,
  host: '127.0.0.1',
  provider: 'claude-code',
  cwd: process.cwd(),
  stateDir: '.natto',
  historyPageSize: 50,
  toolOutputPreviewBytes: 4096,
  claudeBinary: 'claude',
  geminiBinary: 'gemini',
  resumeUuid: null,
};

export function resolveStateDir(dir: string, cwd: string = process.cwd()): string {
  return resolve(cwd, dir);
}

function parseProvider(raw: string | undefined, fallback: Provider): Provider {
  if (!raw) return fallback;
  return (PROVIDERS as readonly string[]).includes(raw) ? (raw as Provider) : fallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: env.AGUI_BRIDGE_PORT ? Number(env.AGUI_BRIDGE_PORT) : DEFAULT_CONFIG.port,
    host: env.AGUI_BRIDGE_HOST ?? DEFAULT_CONFIG.host,
    provider: parseProvider(env.AGUI_BRIDGE_PROVIDER, DEFAULT_CONFIG.provider),
    cwd: env.AGUI_BRIDGE_CWD ?? DEFAULT_CONFIG.cwd,
    stateDir: env.AGUI_BRIDGE_STATE_DIR ?? DEFAULT_CONFIG.stateDir,
    historyPageSize: env.AGUI_BRIDGE_HISTORY_PAGE_SIZE
      ? Number(env.AGUI_BRIDGE_HISTORY_PAGE_SIZE)
      : DEFAULT_CONFIG.historyPageSize,
    toolOutputPreviewBytes: env.AGUI_BRIDGE_TOOL_OUTPUT_PREVIEW_BYTES
      ? Number(env.AGUI_BRIDGE_TOOL_OUTPUT_PREVIEW_BYTES)
      : DEFAULT_CONFIG.toolOutputPreviewBytes,
    claudeBinary: env.AGUI_BRIDGE_CLAUDE_BINARY ?? DEFAULT_CONFIG.claudeBinary,
    geminiBinary: env.AGUI_BRIDGE_GEMINI_BINARY ?? DEFAULT_CONFIG.geminiBinary,
    resumeUuid: env.AGUI_BRIDGE_RESUME_UUID ?? DEFAULT_CONFIG.resumeUuid,
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
      case '--provider': {
        const raw = argv[++i];
        if (raw && (PROVIDERS as readonly string[]).includes(raw)) {
          out.provider = raw as Provider;
        }
        break;
      }
      case '--cwd':
        out.cwd = argv[++i] ?? DEFAULT_CONFIG.cwd;
        break;
      case '--state-dir':
        out.stateDir = argv[++i] ?? DEFAULT_CONFIG.stateDir;
        break;
      case '--resume-uuid':
        out.resumeUuid = argv[++i] ?? null;
        break;
    }
  }
  return out;
}
