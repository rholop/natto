import type { WebSocket } from 'ws';
import type { ServerEvent } from './events.js';

export interface EventSink {
  send(event: ServerEvent): void;
}

export function socketSink(socket: WebSocket): EventSink {
  return {
    send(event) {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(event));
    },
  };
}

export class FanoutEmitter {
  private readonly subscribers = new Set<EventSink>();

  add(sink: EventSink): void {
    this.subscribers.add(sink);
  }

  remove(sink: EventSink): void {
    this.subscribers.delete(sink);
  }

  size(): number {
    return this.subscribers.size;
  }

  clear(): void {
    this.subscribers.clear();
  }

  broadcast(event: ServerEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub.send(event);
      } catch {
        // individual sink failures should not affect the rest
      }
    }
  }
}
