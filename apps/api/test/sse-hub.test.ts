import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '@ao/shared';
import { SseHub, formatSse } from '../src/sse/hub';

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
  }
}
const client = () => new FakeRes() as unknown as Response & FakeRes;
const message = (id: number, isDemo = false) =>
  ({ event: { id, isDemo, summary: 'Turn ended' }, agents: [], tasks: [] }) as unknown as StreamMessage;

describe('SSE hub', () => {
  it('formats frames with the event id', () => {
    expect(formatSse(message(42))).toMatch(/^id: 42\nevent: activity\ndata: \{.*\}\n\n$/);
  });

  it('broadcasts to every open client', () => {
    const hub = new SseHub();
    const a = client();
    const b = client();
    hub.add(a, false);
    hub.add(b, false);
    hub.broadcast(message(1));
    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toEqual(a.chunks);
  });

  it('keeps demo and real viewers apart', () => {
    const hub = new SseHub();
    const real = client();
    const demo = client();
    hub.add(real, false);
    hub.add(demo, true);
    hub.broadcast(message(1, true));
    hub.broadcast(message(2, false));
    expect(demo.chunks.join('')).toContain('id: 1\n');
    expect(demo.chunks.join('')).not.toContain('id: 2\n');
    expect(real.chunks.join('')).toContain('id: 2\n');
    expect(real.chunks.join('')).not.toContain('id: 1\n');
  });

  it('forgets clients that close', () => {
    const hub = new SseHub();
    const a = client();
    hub.add(a, false);
    expect(hub.size).toBe(1);
    a.emit('close');
    expect(hub.size).toBe(0);
    hub.broadcast(message(1));
    expect(a.chunks).toHaveLength(0);
  });

  it('drops a client whose connection is already gone', () => {
    const hub = new SseHub();
    const a = client();
    hub.add(a, false);
    a.destroyed = true;
    hub.broadcast(message(1));
    expect(hub.size).toBe(0);
  });

  it('sends heartbeats', () => {
    vi.useFakeTimers();
    const hub = new SseHub();
    const a = client();
    hub.add(a, false);
    hub.startHeartbeat(1000);
    vi.advanceTimersByTime(2500);
    hub.stopHeartbeat();
    vi.useRealTimers();
    expect(a.chunks).toEqual([': heartbeat\n\n', ': heartbeat\n\n']);
  });
});
