import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { GeminiAdapter } from './adapters/gemini.js';
import type { CliAdapter } from './adapters/adapter.js';
import { socketSink, type EventSink } from './protocol/emitter.js';
import {
  parseClientEvent,
  type ClientEvent,
  type Provider,
  type ServerEvent,
} from './protocol/events.js';
import { SessionRegistry } from './session/registry.js';
import type { Session } from './session/session.js';
import { acquireLock, type LockHandle } from './session/store.js';
import { DEFAULT_CONFIG, resolveStateDir, type ServerConfig } from './config.js';
import { HookEndpoint } from './hook-endpoint.js';

export interface StartServerOptions extends Partial<ServerConfig> {
  adapterFor?: (provider: Provider) => CliAdapter;
  logger?: (msg: string) => void;
  sweepIntervalMs?: number;
}

export interface StartedServer {
  address: () => AddressInfo;
  close: () => Promise<void>;
  registry: SessionRegistry;
  stateDir: string;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const config: ServerConfig = { ...DEFAULT_CONFIG, ...options };
  const logger = options.logger ?? (() => {});
  const stateDir = resolveStateDir(config.stateDir);

  const lock: LockHandle = acquireLock(stateDir);

  const adapterFor =
    options.adapterFor ??
    ((provider: Provider): CliAdapter => {
      if (provider === 'claude-code') return new ClaudeCodeAdapter({ binary: config.claudeBinary });
      return new GeminiAdapter({ binary: config.geminiBinary });
    });

  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  // hookBaseUrl is filled in after listen() so adapters can reach loopback.
  let hookBaseUrl = `http://${config.host}:${config.port}`;

  const registry = new SessionRegistry({
    stateDir,
    maxSessions: config.maxSessions,
    historyPageSize: config.historyPageSize,
    toolOutputPreviewBytes: config.toolOutputPreviewBytes,
    orphanTtlMs: config.orphanTtlMs,
    hookBaseUrl,
    adapterFor,
    logger,
  });

  registry.hydrateFromDisk();

  const hookEndpoint = new HookEndpoint({ registry, logger });

  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (hookEndpoint.isHookPath(req.url)) {
      hookEndpoint.handle(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    const sink: EventSink = socketSink(socket);
    const attached = new Set<string>();

    socket.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const parsed = parseClientEvent(text);
      if (!parsed.ok) {
        sendErr(sink, '', 'invalid_message', parsed.error);
        return;
      }
      try {
        handleClientEvent(parsed.event, sink, attached, registry, logger);
      } catch (err) {
        sendErr(sink, '', 'handler_error', (err as Error).message);
      }
    });

    socket.on('close', () => {
      for (const id of attached) {
        const s = registry.get(id);
        if (s) s.detach(sink);
      }
      attached.clear();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  // Now that the server is bound, refresh hookBaseUrl with the actual port (handles port:0).
  const addr = http.address() as AddressInfo;
  hookBaseUrl = `http://${addr.address === '::' ? '127.0.0.1' : addr.address}:${addr.port}`;
  registry.setHookBaseUrl(hookBaseUrl);

  const sweepInterval = options.sweepIntervalMs ?? 60_000;
  const sweepTimer = setInterval(() => {
    try {
      registry.sweepOrphans();
    } catch (err) {
      logger(`orphan sweep error: ${(err as Error).message}`);
    }
  }, sweepInterval);
  sweepTimer.unref();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    hookEndpoint.shutdown('bridge_shutdown');
    await registry.shutdown();
    for (const ws of wss.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      http.close((err) => (err ? reject(err) : resolve())),
    );
    lock.release();
  };

  return {
    address: () => http.address() as AddressInfo,
    close,
    registry,
    stateDir,
  };
}

function handleClientEvent(
  event: ClientEvent,
  sink: EventSink,
  attached: Set<string>,
  registry: SessionRegistry,
  logger: (msg: string) => void,
): void {
  switch (event.type) {
    case 'CREATE_SESSION': {
      let session: Session;
      try {
        session = registry.create({ provider: event.provider, cwd: event.cwd });
      } catch (err) {
        sendErr(sink, '', 'create_failed', (err as Error).message);
        return;
      }
      sink.send({
        type: 'SESSION_CREATED',
        seq: session.getMeta().lastSeq,
        sessionId: session.sessionId,
        provider: session.provider,
        cwd: session.cwd,
      });
      return;
    }

    case 'LIST_SESSIONS': {
      sink.send({
        type: 'SESSION_LIST',
        seq: 0,
        sessionId: '',
        sessions: registry.list(),
      });
      return;
    }

    case 'ATTACH_SESSION': {
      const session = registry.get(event.sessionId);
      if (!session) {
        sendErr(sink, event.sessionId, 'unknown_session', 'session not found');
        return;
      }
      const snapshot = session.attach(sink);
      attached.add(event.sessionId);
      sink.send(snapshot);
      sink.send({
        type: 'SESSION_ATTACHED',
        seq: snapshot.lastSeq,
        sessionId: session.sessionId,
        lastSeq: snapshot.lastSeq,
      });
      return;
    }

    case 'DETACH_SESSION': {
      const session = registry.get(event.sessionId);
      if (session) session.detach(sink);
      attached.delete(event.sessionId);
      return;
    }

    case 'REMOVE_SESSION': {
      const removed = registry.remove(event.sessionId);
      attached.delete(event.sessionId);
      if (removed) {
        sink.send({
          type: 'SESSION_REMOVED',
          seq: 0,
          sessionId: event.sessionId,
        });
      }
      return;
    }

    case 'START_TURN': {
      const session = registry.get(event.sessionId);
      if (!session) {
        sendErr(sink, event.sessionId, 'unknown_session', 'session not found');
        return;
      }
      session.startTurn(event.prompt);
      return;
    }

    case 'TOOL_CALL_RESULT': {
      const session = registry.get(event.sessionId);
      if (!session) {
        sendErr(sink, event.sessionId, 'unknown_session', 'session not found');
        return;
      }
      session.submitToolResult({
        toolCallId: event.toolCallId,
        approved: event.approved,
        reason: event.reason,
      });
      return;
    }

    case 'FETCH_HISTORY': {
      const session = registry.get(event.sessionId);
      if (!session) {
        sendErr(sink, event.sessionId, 'unknown_session', 'session not found');
        return;
      }
      const { entries, hasMore } = session.fetchHistory(event.beforeSeq, event.limit);
      sink.send({
        type: 'HISTORY_PAGE',
        seq: 0,
        sessionId: session.sessionId,
        requestId: event.requestId,
        entries,
        hasMore,
      });
      return;
    }

    case 'TOOL_RESULT_FETCH': {
      const session = registry.get(event.sessionId);
      if (!session) {
        sendErr(sink, event.sessionId, 'unknown_session', 'session not found');
        return;
      }
      void session.fetchToolResult(event.toolCallId).then((content) => {
        sink.send({
          type: 'TOOL_RESULT_CONTENT',
          seq: 0,
          sessionId: session.sessionId,
          requestId: event.requestId,
          toolCallId: event.toolCallId,
          content: content ?? '',
        });
      });
      return;
    }

    case 'ABORT_TURN': {
      const session = registry.get(event.sessionId);
      if (!session) {
        sendErr(sink, event.sessionId, 'unknown_session', 'session not found');
        return;
      }
      session.abortTurn('client_abort');
      return;
    }

    default: {
      const _exhaustive: never = event;
      logger(`unhandled client event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function sendErr(sink: EventSink, sessionId: string, reason: string, message: string): void {
  const event: ServerEvent = {
    type: 'CLI_ERROR',
    seq: 0,
    sessionId,
    reason,
    message,
  };
  sink.send(event);
}
