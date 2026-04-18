import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHolder } from './session/holder.js';

interface HookPayload {
  token?: string;
  toolCallId?: string;
  name?: string;
  args?: string;
}

export interface HookEndpointOptions {
  holder: SessionHolder;
  logger?: (msg: string) => void;
}

export class HookEndpoint {
  private readonly pending = new Set<ServerResponse>();
  private readonly logger: (msg: string) => void;

  constructor(private readonly opts: HookEndpointOptions) {
    this.logger = opts.logger ?? (() => {});
  }

  isHookPath(url: string | undefined): boolean {
    if (!url) return false;
    const path = url.split('?')[0];
    return path === '/hook/permission-prompt';
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      respondJson(res, 405, { allow: false, reason: 'method_not_allowed' });
      return;
    }
    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : '';

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        respondJson(res, 413, { allow: false, reason: 'payload_too_large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      let payload: HookPayload;
      try {
        payload = JSON.parse(raw) as HookPayload;
      } catch {
        respondJson(res, 400, { allow: false, reason: 'invalid_json' });
        return;
      }
      const token = bearer || payload.token || '';
      if (!token) {
        respondJson(res, 401, { allow: false, reason: 'missing_token' });
        return;
      }
      const session = this.opts.holder.resolveHookToken(token);
      if (!session) {
        respondJson(res, 401, { allow: false, reason: 'invalid_token' });
        return;
      }

      this.pending.add(res);
      const cleanup = () => {
        this.pending.delete(res);
      };
      res.on('close', cleanup);
      res.on('finish', cleanup);

      session.handlePermissionHook(
        payload.toolCallId ?? '',
        payload.name ?? '',
        payload.args ?? '',
        (decision) => {
          if (res.writableEnded) return;
          respondJson(res, 200, decision);
        },
      );
    });
    req.on('error', (err) => {
      this.logger(`hook request error: ${err.message}`);
      if (!res.writableEnded) {
        respondJson(res, 500, { allow: false, reason: 'request_error' });
      }
    });
  }

  shutdown(reason = 'bridge_shutdown'): void {
    for (const res of [...this.pending]) {
      if (!res.writableEnded) {
        respondJson(res, 200, { allow: false, reason });
      }
    }
    this.pending.clear();
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}
