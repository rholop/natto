import { describe, expect, it } from 'vitest';
import { FanoutEmitter, type EventSink } from '../../src/protocol/emitter.js';
import type { ServerEvent } from '../../src/protocol/events.js';

function recorder(): EventSink & { events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  return {
    events,
    send(e) {
      events.push(e);
    },
  };
}

function msgEvent(seq: number, id: string): ServerEvent {
  return {
    type: 'MESSAGE',
    seq,
    message: {
      messageId: id,
      role: 'user',
      content: `m${seq}`,
      at: seq,
      status: 'complete',
    },
  };
}

describe('FanoutEmitter (multi-subscriber)', () => {
  it('broadcasts the same ordered stream to every subscriber', () => {
    const fanout = new FanoutEmitter();
    const a = recorder();
    const b = recorder();
    const c = recorder();
    fanout.add(a);
    fanout.add(b);
    fanout.add(c);
    for (let i = 1; i <= 5; i++) fanout.broadcast(msgEvent(i, `m${i}`));
    expect(a.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(b.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(c.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(a.events).toEqual(b.events);
    expect(b.events).toEqual(c.events);
  });

  it('after remove(), that subscriber sees no further events but others continue', () => {
    const fanout = new FanoutEmitter();
    const a = recorder();
    const b = recorder();
    const c = recorder();
    fanout.add(a);
    fanout.add(b);
    fanout.add(c);

    fanout.broadcast(msgEvent(1, 'm1'));
    fanout.broadcast(msgEvent(2, 'm2'));
    fanout.remove(b);
    fanout.broadcast(msgEvent(3, 'm3'));
    fanout.broadcast(msgEvent(4, 'm4'));

    expect(a.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(b.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(c.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('isolates errors: a throwing sink does not break others', () => {
    const fanout = new FanoutEmitter();
    const good = recorder();
    const bad: EventSink = {
      send() {
        throw new Error('boom');
      },
    };
    fanout.add(bad);
    fanout.add(good);
    fanout.broadcast(msgEvent(1, 'm1'));
    expect(good.events).toHaveLength(1);
  });
});
