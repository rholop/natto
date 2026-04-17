export interface ServerConfig {
  port: number;
  host: string;
  approvalTimeoutMs: number;
  maxSessions: number;
  claudeBinary: string;
  geminiBinary: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 7878,
  host: '127.0.0.1',
  approvalTimeoutMs: 300_000,
  maxSessions: 10,
  claudeBinary: 'claude',
  geminiBinary: 'gemini',
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = env.AGUI_BRIDGE_PORT ? Number(env.AGUI_BRIDGE_PORT) : DEFAULT_CONFIG.port;
  const host = env.AGUI_BRIDGE_HOST ?? DEFAULT_CONFIG.host;
  const approvalTimeoutMs = env.AGUI_BRIDGE_APPROVAL_TIMEOUT_MS
    ? Number(env.AGUI_BRIDGE_APPROVAL_TIMEOUT_MS)
    : DEFAULT_CONFIG.approvalTimeoutMs;
  const maxSessions = env.AGUI_BRIDGE_MAX_SESSIONS
    ? Number(env.AGUI_BRIDGE_MAX_SESSIONS)
    : DEFAULT_CONFIG.maxSessions;
  return {
    port,
    host,
    approvalTimeoutMs,
    maxSessions,
    claudeBinary: env.AGUI_BRIDGE_CLAUDE_BINARY ?? DEFAULT_CONFIG.claudeBinary,
    geminiBinary: env.AGUI_BRIDGE_GEMINI_BINARY ?? DEFAULT_CONFIG.geminiBinary,
  };
}
