import type { Message, MessageUpdate } from './events.js';

export function applyPatch(message: Message, patch: MessageUpdate): Message {
  if (patch.messageId !== message.messageId) {
    throw new Error(
      `applyPatch: messageId mismatch (message=${message.messageId} patch=${patch.messageId})`,
    );
  }
  switch (message.role) {
    case 'user':
      if (patch.status && patch.status !== 'complete') {
        return { ...message, status: 'complete' };
      }
      return message;

    case 'assistant': {
      const next: Message = { ...message };
      if (patch.contentDelta !== undefined) next.content += patch.contentDelta;
      if (patch.status !== undefined) next.status = patch.status;
      return next;
    }

    case 'tool_call': {
      const next = { ...message };
      if (patch.args !== undefined) next.args = patch.args;
      if (patch.approval !== undefined) next.approval = patch.approval;
      if (patch.result !== undefined) next.result = patch.result;
      if (patch.status !== undefined) next.status = patch.status;
      return next;
    }
  }
}
