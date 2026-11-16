import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CRON, PASSWORD, SECRET, TOKEN, noisyToolPayload, startTestHub, type TestHub } from './helpers';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub();
});
afterEach(() => t.stop());

const stop = { session_id: 's1', cwd: '/p/shop', hook_event_name: 'Stop' };
const count = async (table: string) =>
  ((await t.db.all(sql.raw(`select count(*) as n from ${table}`))) as { n: number }[])[0]?.n;

describe('ingest authentication', () => {
  it('rejects a missing, wrong or malformed bearer token', async () => {
    for (const auth of ['', 'Bearer wrong-token-000000000', TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const res = await t.ingest(stop, { Authorization: auth });
      expect(res.status, auth).toBe(401);
      expect(await res.text()).toBe('');
    }
    expect(await count('agents')).toBe(0);
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

  it('accepts opencode events on their own path', async () => {
    const res = await t.ingest({ event: 'session_start', session_id: 'o1', cwd: '/p/shop' }, {}, 'opencode');
    expect([204, 400]).toContain(res.status);
  });

  it('answers unhandled hook events with an empty 204 and stores nothing', async () => {
    const res = await t.ingest({ ...stop, hook_event_name: 'PreCompact' });
    expect(res.status).toBe(204);
    expect(await count('events')).toBe(0);
  });

  it('rejects invalid and oversized bodies', async () => {
    expect((await t.ingest({ hook_event_name: 'Stop' })).status).toBe(400);
    expect((await t.ingest('{not json')).status).toBe(400);
    expect((await t.ingest({ ...stop, prompt: 'x'.repeat(80 * 1024) })).status).toBe(413);
  });
});

describe('model header', () => {
  const models = async () =>
    (await t.db.all(sql`select model from agents union all select model from sessions`)) as { model: string | null }[];

  it('stores the model from X-Model when the payload has none', async () => {
    expect((await t.ingest(stop, { 'X-Model': 'claude-fable-5-2' })).status).toBe(204);
    expect(await models()).toEqual([{ model: 'claude-fable-5-2' }, { model: 'claude-fable-5-2' }]);
  });

  it('keeps the known model when a later event has no header', async () => {
    await t.ingest(stop, { 'X-Model': 'claude-fable-5-2' });
    await t.ingest({ ...stop, hook_event_name: 'UserPromptSubmit' });
    expect(await models()).toEqual([{ model: 'claude-fable-5-2' }, { model: 'claude-fable-5-2' }]);
  });

  it('ignores an empty or malformed X-Model and still stores the event', async () => {
    for (const bad of ['', '<synthetic>', 'has space', 'x'.repeat(200)]) {
      expect((await t.ingest(stop, { 'X-Model': bad })).status, bad).toBe(204);
    }
    expect(await models()).toEqual([{ model: null }, { model: null }]);
  });

  it('does not put the session model on a subagent', async () => {
    await t.ingest(
      { ...stop, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { 'X-Model': 'claude-fable-5-2' },
    );
    const rows = (await t.db.all(sql`select role, model from agents order by role`)) as { role: string; model: string | null }[];
    expect(rows.find((r) => r.role === 'subagent')?.model).toBeNull();
  });
});

describe('read API authentication', () => {
  const routes = (): [string, (req: Request) => Promise<Response>][] => [
    ['overview', t.handlers.overview],
    ['agents', t.handlers.agents],
    ['sessions', t.handlers.sessions],
    ['tasks', t.handlers.tasks],
    ['events', t.handlers.events],
    ['projects', t.handlers.projects],
    ['providers', t.handlers.providers],
    ['stream', t.handlers.stream],
    ['agents/x', (req) => t.handlers.agent(req, 'x')],
  ];

  it('returns nothing without the viewer cookie', async () => {
    await t.ingest(stop);
    for (const [name, handler] of routes()) {
      const res = await t.get(`/api/${name}`, handler);
      expect(res.status, name).toBe(401);
      expect(await res.text()).toBe('');
    }
  });

  it('does not accept the ingest token or a forged cookie', async () => {
    const bearer = await t.handlers.agents(
      new Request('http://hub.test/api/agents', { headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(bearer.status).toBe(401);
    const forged = await t.get('/api/agents', t.handlers.agents, `ao_session=${t.clock.now + 100000}.deadbeef`);
    expect(forged.status).toBe(401);
  });

  it('serves data after login and never leaks the token', async () => {
    await t.ingest(stop);
    const cookie = await t.login();
    expect(cookie).toMatch(/^ao_session=\d+\.[0-9a-f]{64}$/);
    for (const [name, handler] of routes().filter(([n]) => n !== 'stream' && n !== 'agents/x')) {
      const res = await t.get(`/api/${name}`, handler, cookie);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.text();
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(PASSWORD);
    }
    const agents = (await (await t.get('/api/agents', t.handlers.agents, cookie)).json()) as unknown[];
    expect(agents).toMatchObject([{ deviceName: 'laptop-a', status: 'idle', projectName: 'shop' }]);
  });

  it('rejects an invalid query with 400', async () => {
    const cookie = await t.login();
    expect((await t.get('/api/events?limit=0', t.handlers.events, cookie)).status).toBe(400);
  });

  it('rate limits failed logins', async () => {
    const attempt = (password: string) =>
      t.handlers.login(
        new Request('http://hub.test/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ password }),
        }),
      );
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong-password')).status).toBe(401);
    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    t.clock.now += 16 * 60 * 1000;
    expect((await attempt(PASSWORD)).status).toBe(204);
  });

  it('logout clears the cookie', async () => {
    const res = await t.handlers.logout();
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('retention cron', () => {
  const call = (auth?: string) =>
    t.handlers.cleanup(new Request('http://hub.test/api/cron/cleanup', { headers: auth ? { Authorization: auth } : {} }));

  it('is closed without the cron secret, and for the ingest token', async () => {
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
  });

  it('is closed when no CRON_SECRET is configured', async () => {
    const closed = await startTestHub({ cronSecret: undefined });
    const res = await closed.handlers.cleanup(
      new Request('http://hub.test/api/cron/cleanup', { headers: { Authorization: `Bearer ${CRON}` } }),
    );
    expect(res.status).toBe(401);
    closed.stop();
  });

  it('deletes events older than the retention window', async () => {
    await t.ingest(stop);
    t.clock.now += 40 * 24 * 60 * 60 * 1000;
    const res = await call(`Bearer ${CRON}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 1 });
    expect(await count('events')).toBe(0);
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
      const all = await t.db.all(sql.raw(`select * from ${table}`));
      rows += all.length;
      expect(JSON.stringify(all), table).not.toContain(SECRET);
    }
    expect(rows).toBeGreaterThan(8);
    const event = await t.db.all(sql`select file_path from events where tool_name = 'Edit' limit 1`);
    expect(event).toEqual([{ file_path: 'src/cart.ts' }]);
  });
});
