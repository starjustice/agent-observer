import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestHub, type TestHub } from './helpers';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub({}, { pollMs: 20, maxStreamMs: 60_000 });
});
afterEach(() => t.stop());

const stop = { session_id: 's1', cwd: '/p/shop', hook_event_name: 'Stop' };
const tool = { session_id: 's1', cwd: '/p/shop', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1' };

type Frame = { id: number; data: any };

/** Reads SSE frames from a streaming response until `count` activity frames arrived. */
async function readFrames(res: Response, count: number, signal?: AbortController): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  const deadline = Date.now() + 3000;
  while (frames.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const id = /^id: (\d+)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (id && data) frames.push({ id: Number(id), data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  signal?.abort();
  return frames;
}

const open = async (headers: Record<string, string> = {}, query = '') => {
  const cookie = await t.login();
  const controller = new AbortController();
  const res = await t.handlers.stream(
    new Request(`http://hub.test/api/stream${query}`, { headers: { cookie, ...headers }, signal: controller.signal }),
  );
  return { res, controller };
};

describe('SSE stream', () => {
  it('delivers events that arrive after it opened, with event ids', async () => {
    const { res, controller } = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const pending = readFrames(res, 2, controller);
    await t.ingest(tool);
    await t.ingest(stop);
    const frames = await pending;
    expect(frames.map((f) => f.data.event.summary)).toEqual(['Read tool started', 'Turn ended']);
    expect(frames[1]!.id).toBeGreaterThan(frames[0]!.id);
    // The agent snapshot is read when the event is sent, so it reflects the latest state.
    expect(frames[1]!.data.agents[0]).toMatchObject({ status: 'idle', currentTool: null });
  });

  it('carries the agent state at the time of the event', async () => {
    const { res, controller } = await open();
    const pending = readFrames(res, 1, controller);
    await t.ingest(tool);
    const [frame] = await pending;
    expect(frame!.data.agents[0]).toMatchObject({ status: 'working', currentTool: 'Read' });
  });

  it('does not replay history when no Last-Event-ID is given', async () => {
    await t.ingest(stop);
    const { res, controller } = await open();
    const pending = readFrames(res, 1, controller);
    await t.ingest(tool);
    const frames = await pending;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.event.summary).toBe('Read tool started');
  });

  it('replays missed events after Last-Event-ID', async () => {
    await t.ingest(stop);
    await t.ingest({ ...stop, hook_event_name: 'UserPromptSubmit' });
    await t.ingest(stop);
    const { res, controller } = await open({ 'Last-Event-ID': '1' });
    const frames = await readFrames(res, 2, controller);
    expect(frames.map((f) => f.id)).toEqual([2, 3]);
  });

  it('accepts the replay point as a query parameter', async () => {
    await t.ingest(stop);
    await t.ingest(stop);
    const { res, controller } = await open({}, '?lastEventId=1');
    expect((await readFrames(res, 1, controller)).map((f) => f.id)).toEqual([2]);
  });

  it('does not send demo events to a real viewer', async () => {
    const { res, controller } = await open();
    const pending = readFrames(res, 1, controller);
    await t.ingest(stop, { 'X-Demo': '1' });
    await t.ingest(stop);
    const frames = await pending;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.event.isDemo).toBe(false);
  });

  it('includes every agent of a session when it ends', async () => {
    await t.ingest({ ...stop, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    const { res, controller } = await open({ 'Last-Event-ID': '1' });
    const pending = readFrames(res, 1, controller);
    await t.ingest({ ...stop, hook_event_name: 'SessionEnd', reason: 'other' });
    const [frame] = await pending;
    expect(frame!.data.agents.map((a: { status: string }) => a.status).sort()).toEqual(['ended', 'ended']);
  });

  it('asks the browser to reconnect before the hosting time limit', async () => {
    const short = await startTestHub({}, { pollMs: 10, maxStreamMs: 50 });
    const cookie = await short.login();
    const res = await short.handlers.stream(new Request('http://hub.test/api/stream', { headers: { cookie } }));
    const text = await res.text();
    expect(text).toContain('event: reconnect');
    short.stop();
  });

  it('stops polling when the viewer disconnects', async () => {
    const { res, controller } = await open();
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    const end = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return 'closed';
      })(),
      new Promise((ok) => setTimeout(() => ok('still open'), 1000)),
    ]);
    expect(end).toBe('closed');
  });
});
