import { WebSocket } from 'ws';
import type { ClientEvent, ServerEvent } from '../../src/protocol/events.js';

export class TestWsClient {
  private socket: WebSocket | null = null;
  private readonly received: ServerEvent[] = [];
  private readonly waiters: Array<{
    predicate: (e: ServerEvent) => boolean;
    resolve: (e: ServerEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.on('open', () => {
        this.socket = socket;
        resolve();
      });
      socket.on('error', (err) => reject(err));
      socket.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        try {
          const event = JSON.parse(text) as ServerEvent;
          this.received.push(event);
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            const w = this.waiters[i]!;
            if (w.predicate(event)) {
              clearTimeout(w.timer);
              this.waiters.splice(i, 1);
              w.resolve(event);
            }
          }
        } catch {
          // ignore non-JSON
        }
      });
    });
  }

  async send(event: ClientEvent): Promise<void> {
    if (!this.socket) throw new Error('not connected');
    await new Promise<void>((resolve, reject) => {
      this.socket!.send(JSON.stringify(event), (err) => (err ? reject(err) : resolve()));
    });
  }

  waitFor<T extends ServerEvent['type']>(
    type: T,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerEvent, { type: T }>> {
    const existing = this.received.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing as Extract<ServerEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for ${type} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({
        predicate: (e) => e.type === type,
        resolve: (e) => resolve(e as Extract<ServerEvent, { type: T }>),
        reject,
        timer,
      });
    });
  }

  async collectUntil(type: ServerEvent['type'], timeoutMs = 5_000): Promise<ServerEvent[]> {
    await this.waitFor(type, timeoutMs);
    const endIdx = this.received.findIndex((e) => e.type === type);
    return this.received.slice(0, endIdx + 1);
  }

  received_copy(): ServerEvent[] {
    return [...this.received];
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      if (socket.readyState === socket.CLOSED) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
      socket.close();
    });
    this.socket = null;
  }
}
