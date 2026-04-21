import { NattoMessageList } from './element.js';

if (!customElements.get('natto-message-list')) {
  customElements.define('natto-message-list', NattoMessageList);
}

export { NattoMessageList };
export type {
  HandledEvent,
  Message,
  MessageEvent,
  MessageUpdate,
  MessageUpdateEvent,
} from './protocol.js';

declare global {
  interface HTMLElementTagNameMap {
    'natto-message-list': NattoMessageList;
  }
}
