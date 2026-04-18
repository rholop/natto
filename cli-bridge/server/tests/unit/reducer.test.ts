import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/protocol/reducer.js';
import type {
  AssistantMessage,
  ToolCallMessage,
  UserMessage,
} from '../../src/protocol/events.js';

describe('applyPatch', () => {
  it('appends assistant contentDelta and preserves other fields', () => {
    const msg: AssistantMessage = {
      messageId: 'a1',
      role: 'assistant',
      content: 'hello ',
      at: 1,
      status: 'in_progress',
    };
    const next = applyPatch(msg, { messageId: 'a1', contentDelta: 'world' });
    expect(next.role).toBe('assistant');
    expect((next as AssistantMessage).content).toBe('hello world');
    expect((next as AssistantMessage).status).toBe('in_progress');
  });

  it('marks assistant status complete', () => {
    const msg: AssistantMessage = {
      messageId: 'a2',
      role: 'assistant',
      content: 'done',
      at: 1,
      status: 'in_progress',
    };
    const next = applyPatch(msg, { messageId: 'a2', status: 'complete' });
    expect((next as AssistantMessage).status).toBe('complete');
  });

  it('applies tool_call approval and result patches', () => {
    const msg: ToolCallMessage = {
      messageId: 't1',
      role: 'tool_call',
      toolCallId: 'tc1',
      name: 'Read',
      args: '{}',
      approval: 'pending',
      result: null,
      at: 1,
      status: 'in_progress',
    };
    const approved = applyPatch(msg, { messageId: 't1', approval: 'approved' });
    expect((approved as ToolCallMessage).approval).toBe('approved');

    const withResult = applyPatch(approved, {
      messageId: 't1',
      result: { preview: 'ok', totalBytes: 2, truncated: false },
      status: 'complete',
    });
    expect((withResult as ToolCallMessage).result?.preview).toBe('ok');
    expect((withResult as ToolCallMessage).status).toBe('complete');
  });

  it('is a no-op for user messages (identity patch)', () => {
    const msg: UserMessage = {
      messageId: 'u1',
      role: 'user',
      content: 'hi',
      at: 1,
      status: 'complete',
    };
    const next = applyPatch(msg, { messageId: 'u1' });
    expect(next).toEqual(msg);
  });
});
