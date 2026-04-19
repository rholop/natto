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
import { SessionHolder } from './session/holder.js';
import { acquireLock, type LockHandle } from './session/store.js';
import { DEFAULT_CONFIG, resolveStateDir, type ServerConfig } from './config.js';
import { HookEndpoint } from './hook-endpoint.js';

export interface StartServerOptions extends Partial<ServerConfig> {
  adapterFor?: (provider: Provider) => CliAdapter;
  logger?: (msg: string) => void;
}

export interface StartedServer {
  address: () => AddressInfo;
  close: () => Promise<void>;
  holder: SessionHolder;
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

  let hookBaseUrl = `http://${config.host}:${config.port}`;

  const holder = new SessionHolder({
    stateDir,
    provider: config.provider,
    cwd: config.cwd,
    historyPageSize: config.historyPageSize,
    toolOutputPreviewBytes: config.toolOutputPreviewBytes,
    hookBaseUrl,
    adapterFor,
    logger,
    resumeUuid: config.resumeUuid,
  });

  try {
    holder.load();
  } catch (err) {
    lock.release();
    throw err;
  }

  const hookEndpoint = new HookEndpoint({ holder, logger });

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
    const session = holder.get();
    const snapshot = session.attach(sink);
    sink.send(snapshot);

    socket.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const parsed = parseClientEvent(text);
      if (!parsed.ok) {
        sendErr(sink, 'invalid_message', parsed.error);
        return;
      }
      try {
        handleClientEvent(parsed.event, sink, holder, logger);
      } catch (err) {
        sendErr(sink, 'handler_error', (err as Error).message);
      }
    });

    socket.on('close', () => {
      session.detach(sink);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const addr = http.address() as AddressInfo;
  hookBaseUrl = `http://${addr.address === '::' ? '127.0.0.1' : addr.address}:${addr.port}`;
  holder.setHookBaseUrl(hookBaseUrl);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    hookEndpoint.shutdown('bridge_shutdown');
    await holder.shutdown();
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
    holder,
    stateDir,
  };
}

function handleClientEvent(
  event: ClientEvent,
  sink: EventSink,
  holder: SessionHolder,
  logger: (msg: string) => void,
): void {
  const session = holder.get();
  switch (event.type) {
    case 'START_TURN':
      session.startTurn(event.prompt);
      return;

    case 'TOOL_CALL_RESULT':
      session.submitToolResult({
        toolCallId: event.toolCallId,
        approved: event.approved,
        reason: event.reason,
      });
      return;

    case 'FETCH_HISTORY': {
      const { entries, hasMore } = session.fetchHistory(event.beforeSeq, event.limit);
      sink.send({
        type: 'HISTORY_PAGE',
        seq: 0,
        requestId: event.requestId,
        entries,
        hasMore,
      });
      return;
    }

    case 'TOOL_RESULT_FETCH':
      void session.fetchToolResult(event.toolCallId).then((content) => {
        sink.send({
          type: 'TOOL_RESULT_CONTENT',
          seq: 0,
          requestId: event.requestId,
          toolCallId: event.toolCallId,
          content: content ?? '',
        });
      });
      return;

    case 'ABORT_TURN':
      session.abortTurn('client_abort');
      return;

    default: {
      const _exhaustive: never = event;
      logger(`unhandled client event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function sendErr(sink: EventSink, reason: string, message: string): void {
  const event: ServerEvent = {
    type: 'CLI_ERROR',
    seq: 0,
    reason,
    message,
  };
  sink.send(event);
}
