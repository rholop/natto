import { describe, expect, it } from 'vitest';
import { JsonlLineBuffer } from '../../src/protocol/parser.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';

describe('JsonlLineBuffer', () => {
  it('returns whole lines from a single chunk', () => {
    const buf = new JsonlLineBuffer();
    const lines = buf.feed('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('buffers partial lines across chunks', () => {
    const buf = new JsonlLineBuffer();
    expect(buf.feed('{"a"')).toEqual([]);
    expect(buf.feed(':1}\n{"b":2}')).toEqual(['{"a":1}']);
    expect(buf.feed('\n')).toEqual(['{"b":2}']);
  });

  it('skips blank lines', () => {
    const buf = new JsonlLineBuffer();
    expect(buf.feed('\n\n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('flushes trailing non-terminated line', () => {
    const buf = new JsonlLineBuffer();
    buf.feed('{"a":1}');
    expect(buf.flush()).toEqual(['{"a":1}']);
    expect(buf.flush()).toEqual([]);
  });
});

describe('ClaudeCodeAdapter.parseJsonlLine', () => {
  const adapter = new ClaudeCodeAdapter();

  it('parses text events', () => {
    expect(adapter.parseJsonlLine('{"type":"text","text":"hello"}')).toEqual({
      type: 'text_delta',
      delta: 'hello',
    });
  });

  it('parses tool_use with input object', () => {
    const ev = adapter.parseJsonlLine(
      '{"type":"tool_use","name":"Read","input":{"file":"a.ts"},"id":"t1"}',
    );
    expect(ev).toEqual({
      type: 'tool_call',
      name: 'Read',
      args: JSON.stringify({ file: 'a.ts' }),
      id: 't1',
    });
  });

  it('parses session_id from system events', () => {
    expect(adapter.parseJsonlLine('{"type":"system","session_id":"abc"}')).toEqual({
      type: 'session_id',
      uuid: 'abc',
    });
  });

  it('parses end_turn from result events', () => {
    expect(adapter.parseJsonlLine('{"type":"result","stop_reason":"end_turn"}')).toEqual({
      type: 'end_turn',
      stopReason: 'end_turn',
    });
  });

  it('parses error events', () => {
    expect(adapter.parseJsonlLine('{"type":"error","message":"boom"}')).toEqual({
      type: 'error',
      message: 'boom',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(adapter.parseJsonlLine('not json')).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(adapter.parseJsonlLine('{"type":"surprise"}')).toBeNull();
  });
});
