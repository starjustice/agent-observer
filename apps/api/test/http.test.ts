import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PASSWORD, SECRET, TOKEN, noisyToolPayload, startTestHub, type TestHub } from './helpers';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub();
});
afterEach(() => t.stop());

const stop = { session_id: 's1', cwd: '/p/shop', hook_event_name: 'Stop' };

describe('ingest authentication', () => {
  it('rejects a missing, wrong or malformed bearer token', async () => {
    for (const auth of ['', 'Bearer wrong-token-000000000', TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const res = await t.ingest(stop, { Authorization: auth });
      expect(res.status, auth).toBe(401);
      expect(await res.text()).toBe('');
    }
    const agents = t.db.all(sql`select count(*) as n from agents`) as { n: number }[];
    expect(agents[0]?.n).toBe(0);
  });

  it('does not accept the viewer cookie for ingest', async () => {
    const cookie = await t.login();
    const res = await t.ingest(stop, { Authorization: '', Cookie: cookie });
    expect(res.status).toBe(401);
  });

  it('requires a valid X-Device header', async () => {
    expect((await t.ingest(stop, { 'X-Device': '' })).status).toBe(400);
    expect((await t.ingest(stop, { 'X-Device': 'bad name!' })).status).toBe(400);
  });

  it('answers a valid event with an empty 204', async () => {
    const res = await t.ingest(stop);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers unhandled hook events with an empty 204 and stores nothing', async () => {
    const res = await t.ingest({ ...stop, hook_event_name: 'PreCompact' });
    expect(res.status).toBe(204);
    expect(t.db.all(sql`select count(*) as n from events`)).toEqual([{ n: 0 }]);
  });

  it('rejects invalid and oversized bodies', async () => {
    expect((await t.ingest({ hook_event_name: 'Stop' })).status).toBe(400);
    expect((await t.ingest('{not json')).status).toBe(400);
    expect((await t.ingest({ ...stop, prompt: 'x'.repeat(80 * 1024) })).status).toBe(413);
  });
});

describe('model header', () => {
  const models = (t: TestHub) =>
    t.db.all(sql`select model from agents union all select model from sessions`) as { model: string | null }[];

  it('stores the model from X-Model when the payload has none', async () => {
    expect((await t.ingest(stop, { 'X-Model': 'claude-fable-5-2' })).status).toBe(204);
    expect(models(t)).toEqual([{ model: 'claude-fable-5-2' }, { model: 'claude-fable-5-2' }]);
  });

  it('keeps the known model when a later event has no header', async () => {
    await t.ingest(stop, { 'X-Model': 'claude-fable-5-2' });
    await t.ingest({ ...stop, hook_event_name: 'UserPromptSubmit' });
    expect(models(t)).toEqual([{ model: 'claude-fable-5-2' }, { model: 'claude-fable-5-2' }]);
  });

  it('ignores an empty or malformed X-Model and still stores the event', async () => {
    for (const bad of ['', '<synthetic>', 'has space', 'x'.repeat(200)]) {
      expect((await t.ingest(stop, { 'X-Model': bad })).status, bad).toBe(204);
    }
    expect(models(t)).toEqual([{ model: null }, { model: null }]);
  });

  it('does not put the session model on a subagent', async () => {
    await t.ingest(
      { ...stop, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { 'X-Model': 'claude-fable-5-2' },
    );
    const rows = t.db.all(sql`select role, model from agents order by role`) as { role: string; model: string | null }[];
    expect(rows.find((r) => r.role === 'subagent')?.model).toBeNull();
  });
});

describe('read API authentication', () => {
  const paths = ['overview', 'agents', 'agents/x', 'sessions', 'tasks', 'events', 'projects', 'providers', 'stream'];

  it('returns nothing without the viewer cookie', async () => {
    await t.ingest(stop);
    for (const p of paths) {
      const res = await fetch(`${t.url}/api/${p}`);
      expect(res.status, p).toBe(401);
      expect(await res.text()).toBe('');
    }
  });

  it('does not accept the ingest token or a forged cookie', async () => {
    const bearer = await fetch(`${t.url}/api/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(bearer.status).toBe(401);
    const forged = await fetch(`${t.url}/api/agents`, {
      headers: { Cookie: `ao_session=${t.clock.now + 100000}.deadbeef` },
    });
    expect(forged.status).toBe(401);
  });

  it('serves data after login and never leaks the token', async () => {
    await t.ingest(stop);
    const cookie = await t.login();
    expect(cookie).toMatch(/^ao_session=\d+\.[0-9a-f]{64}$/);
    for (const p of paths.filter((x) => x !== 'stream' && x !== 'agents/x')) {
      const res = await fetch(`${t.url}/api/${p}`, { headers: { Cookie: cookie } });
      expect(res.status, p).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(PASSWORD);
    }
    const agents = (await (await fetch(`${t.url}/api/agents`, { headers: { Cookie: cookie } })).json()) as unknown[];
    expect(agents).toMatchObject([{ deviceName: 'laptop-a', status: 'idle', projectName: 'shop' }]);
  });

  it('rate limits failed logins', async () => {
    const attempt = (password: string) =>
      fetch(`${t.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong-password')).status).toBe(401);
    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    t.clock.now += 16 * 60 * 1000;
    expect((await attempt(PASSWORD)).status).toBe(204);
  });

  it('is read-only: no write routes exist on the read API', async () => {
    const cookie = await t.login();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${t.url}/api/agents`, { method, headers: { Cookie: cookie } });
      expect(res.status, method).toBe(404);
    }
  });
});

describe('stored data', () => {
  it('holds no prompt, command, tool input, tool output or transcript text', async () => {
    await t.ingest(noisyToolPayload());
    await t.ingest(noisyToolPayload({ hook_event_name: 'PostToolUse' }));
    await t.ingest(noisyToolPayload({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }));
    await t.ingest(noisyToolPayload({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }));
    await t.ingest(noisyToolPayload({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' }));
    await t.ingest(noisyToolPayload({ hook_event_name: 'Notification', message: SECRET, title: SECRET }));
    const tables = ['devices', 'providers', 'projects', 'sessions', 'agents', 'tasks', 'events'];
    let rows = 0;
    for (const table of tables) {
      const all = t.db.all(sql.raw(`select * from ${table}`));
      rows += all.length;
      expect(JSON.stringify(all), table).not.toContain(SECRET);
    }
    expect(rows).toBeGreaterThan(8);
    const event = t.db.all(sql`select file_path from events where tool_name = 'Edit' limit 1`);
    expect(event).toEqual([{ file_path: 'src/cart.ts' }]);
  });
});

/** Reads SSE frames from a streaming response until `count` activity frames arrived. */
async function readFrames(res: Response, count: number): Promise<{ id: number; data: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { id: number; data: any }[] = [];
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
  return frames;
}

describe('SSE stream over HTTP', () => {
  it('pushes new events to a connected viewer with event ids', async () => {
    const cookie = await t.login();
    const res = await fetch(`${t.url}/api/stream`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const pending = readFrames(res, 2);
    await t.ingest({ session_id: 's1', cwd: '/p/shop', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1' });
    await t.ingest(stop);
    const frames = await pending;
    expect(frames.map((f) => f.data.event.summary)).toEqual(['Read tool started', 'Turn ended']);
    expect(frames[1]!.id).toBeGreaterThan(frames[0]!.id);
    expect(frames[0]!.data.agents[0]).toMatchObject({ status: 'working', currentTool: 'Read' });
  });

  it('replays missed events after Last-Event-ID', async () => {
    const cookie = await t.login();
    await t.ingest(stop);
    await t.ingest({ ...stop, hook_event_name: 'UserPromptSubmit' });
    await t.ingest(stop);
    const res = await fetch(`${t.url}/api/stream`, { headers: { Cookie: cookie, 'Last-Event-ID': '1' } });
    const frames = await readFrames(res, 2);
    expect(frames.map((f) => f.id)).toEqual([2, 3]);
  });

  it('does not send demo events to a real viewer', async () => {
    const cookie = await t.login();
    const res = await fetch(`${t.url}/api/stream`, { headers: { Cookie: cookie } });
    const pending = readFrames(res, 1);
    await t.ingest(stop, { 'X-Demo': '1' });
    await t.ingest(stop);
    const frames = await pending;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.event.isDemo).toBe(false);
  });

  it('cleans up when the viewer disconnects', async () => {
    const cookie = await t.login();
    const controller = new AbortController();
    await fetch(`${t.url}/api/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
    expect(t.hub.size).toBe(1);
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(t.hub.size).toBe(0);
  });
});
