import { h, render } from 'preact';
import { App } from './app.js';
import {
  type HandledEvent,
  type Message,
  type MessageUpdate,
  isHandledEvent,
} from './protocol.js';
import { styles } from './styles.js';

const WS_URL_ATTR = 'ws-url';

export class NattoMessageList extends HTMLElement {
  static get observedAttributes(): string[] {
    return [WS_URL_ATTR];
  }

  private root: ShadowRoot;
  private host: HTMLDivElement;
  private order: string[] = [];
  private byId = new Map<string, Message>();
  private socket: WebSocket | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.host = document.createElement('div');
    this.host.className = 'natto-root';
    this.root.append(style, this.host);
  }

  connectedCallback(): void {
    this.renderApp();
    this.openSocketFromAttr();
  }

  disconnectedCallback(): void {
    this.closeSocket();
    render(null, this.host);
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === WS_URL_ATTR && this.isConnected) {
      this.closeSocket();
      if (value) this.openSocket(value);
    }
  }

  /** Programmatic entry point for tests/demos. Ignores non-handled event types. */
  applyServerEvent(event: unknown): void {
    if (!isHandledEvent(event)) return;
    this.handle(event);
  }

  private openSocketFromAttr(): void {
    const url = this.getAttribute(WS_URL_ATTR);
    if (url) this.openSocket(url);
  }

  private openSocket(url: string): void {
    const ws = new WebSocket(url);
    ws.addEventListener('message', (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isHandledEvent(parsed)) this.handle(parsed);
    });
    this.socket = ws;
  }

  private closeSocket(): void {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  private handle(event: HandledEvent): void {
    if (event.type === 'MESSAGE') {
      this.appendMessage(event.message);
    } else {
      this.patchMessage(event.update);
    }
    this.renderApp();
  }

  private appendMessage(msg: Message): void {
    if (this.byId.has(msg.messageId)) {
      this.byId.set(msg.messageId, msg);
      return;
    }
    this.byId.set(msg.messageId, msg);
    this.order.push(msg.messageId);
  }

  private patchMessage(update: MessageUpdate): void {
    const current = this.byId.get(update.messageId);
    if (!current) return;
    this.byId.set(update.messageId, applyUpdate(current, update));
  }

  private renderApp(): void {
    const messages = this.order
      .map((id) => this.byId.get(id))
      .filter((m): m is Message => !!m);
    render(h(App, { messages }), this.host);
  }
}

function applyUpdate(message: Message, update: MessageUpdate): Message {
  switch (message.role) {
    case 'user':
      return message;
    case 'assistant':
      return {
        ...message,
        content:
          update.contentDelta !== undefined
            ? message.content + update.contentDelta
            : message.content,
        status: update.status ?? message.status,
      };
    case 'tool_call':
      return {
        ...message,
        args: update.args ?? message.args,
        approval: update.approval ?? message.approval,
        result: update.result ?? message.result,
        status: update.status ?? message.status,
      };
  }
}
