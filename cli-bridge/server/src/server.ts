import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { GeminiAdapter } from './adapters/gemini.js';
import type { CliAdapter } from './adapters/adapter.js';
import { WebSocketEmitter } from './protocol/emitter.js';
import { parseClientEvent, type ClientEvent, type Provider } from './protocol/events.js';
import type { Session } from './session/session.js';
import { SessionRegistry } from './session/registry.js';
import { DEFAULT_CONFIG, type ServerConfig } from './config.js';

export interface StartServerOptions extends Partial<ServerConfig> {
  adapterFor?: (provider: Provider) => CliAdapter;
  logger?: (msg: string) => void;
}

export interface StartedServer {
  address: () => AddressInfo;
  close: () => Promise<void>;
  registry: SessionRegistry;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const config: ServerConfig = { ...DEFAULT_CONFIG, ...options };
  const logger = options.logger ?? (() => {});

  const adapterFor =
    options.adapterFor ??
    ((provider: Provider): CliAdapter => {
      if (provider === 'claude-code') return new ClaudeCodeAdapter({ binary: config.claudeBinary });
      return new GeminiAdapter({ binary: config.geminiBinary });
    });

  const registry = new SessionRegistry({
    maxSessions: config.maxSessions,
    approvalTimeoutMs: config.approvalTimeoutMs,
    adapterFor,
    logger,
  });

  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket) => {
    const connectionSessions = new Set<string>();
    const emitter = new WebSocketEmitter(socket);

    socket.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const parsed = parseClientEvent(text);
      if (!parsed.ok) {
        logger(`rejected client message: ${parsed.error}`);
        return;
      }
      handleClientEvent(parsed.event, socket, emitter, registry, connectionSessions, logger);
    });

    socket.on('close', () => {
      for (const id of connectionSessions) registry.remove(id);
      connectionSessions.clear();
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(config.port, config.host, resolve);
  });

  return {
    address: () => http.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        registry.clear();
        wss.close(() => {
          http.close((err) => (err ? reject(err) : resolve()));
        });
      }),
    registry,
  };
}

function handleClientEvent(
  event: ClientEvent,
  socket: WebSocket,
  emitter: WebSocketEmitter,
  registry: SessionRegistry,
  connectionSessions: Set<string>,
  logger: (msg: string) => void,
): void {
  switch (event.type) {
    case 'CREATE_SESSION': {
      let session: Session;
      try {
        session = registry.create({ provider: event.provider, cwd: event.cwd, emitter });
      } catch (err) {
        emitter.emit({
          type: 'CLI_ERROR',
          sessionId: '',
          reason: 'create_failed',
          message: (err as Error).message,
        });
        return;
      }
      connectionSessions.add(session.sessionId);
      emitter.emit({
        type: 'SESSION_CREATED',
        sessionId: session.sessionId,
        provider: session.provider,
        cwd: session.cwd,
      });
      return;
    }

    case 'LIST_SESSIONS':
      emitter.emit({ type: 'SESSION_LIST', sessions: registry.listRecords() });
      return;

    case 'REMOVE_SESSION':
      registry.remove(event.sessionId);
      connectionSessions.delete(event.sessionId);
      return;

    case 'RUN_STARTED': {
      const session = registry.get(event.sessionId);
      if (!session) {
        emitter.emit({
          type: 'CLI_ERROR',
          sessionId: event.sessionId,
          runId: event.runId,
          reason: 'unknown_session',
          message: `No session with id ${event.sessionId}`,
        });
        return;
      }
      const lastUser = [...event.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) {
        emitter.emit({
          type: 'CLI_ERROR',
          sessionId: event.sessionId,
          runId: event.runId,
          reason: 'no_user_message',
          message: 'RUN_STARTED must include at least one user message.',
        });
        return;
      }
      session.startTurn(event.runId, lastUser.content);
      return;
    }

    case 'TOOL_CALL_RESULT': {
      const sessions = registry.list();
      // The client doesn't supply sessionId for tool result in v0.1; we look up
      // by toolCallId across this connection's sessions.
      for (const info of sessions) {
        if (!connectionSessions.has(info.sessionId)) continue;
        const session = registry.get(info.sessionId);
        if (!session) continue;
        // submitToolResult no-ops for sessions where the toolCallId isn't pending.
        session.submitToolResult(event.toolCallId, event.approved, event.content);
      }
      return;
    }

    default: {
      const _exhaustive: never = event;
      logger(`unhandled client event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
