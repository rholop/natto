import type { WebSocket } from 'ws';
import type { ServerEvent } from './events.js';

export interface EventSink {
  emit(event: ServerEvent): void;
}

export class WebSocketEmitter implements EventSink {
  constructor(private readonly socket: WebSocket) {}

  emit(event: ServerEvent): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(event));
  }
}

export class CallbackEmitter implements EventSink {
  constructor(private readonly cb: (event: ServerEvent) => void) {}

  emit(event: ServerEvent): void {
    this.cb(event);
  }
}
