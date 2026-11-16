import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { OPENCODE_EVENTS, normalizeOpencodeEvent } from '../src/collectors/opencode';
import { SECRET, TOKEN, startTestHub, type TestHub } from './helpers';

const base = { session_id: 'ses_1', cwd: '/p/app' };

describe('OpenCode normalization', () => {
  it('maps every sender event to an event type with a template summary', () => {
    const cases: [string, string, string][] = [
      ['session_start', 'session_start', 'Session started'],
      ['session_end', 'session_end', 'Session ended'],
      ['prompt', 'prompt_submitted', 'Prompt submitted'],
      ['tool_start', 'tool_started', 'read tool started'],
      ['tool_end', 'tool_finished', 'read tool finished'],
      ['permission', 'permission_requested', 'Permission requested for read'],
      ['turn_end', 'turn_ended', 'Turn ended'],
    ];
    expect(OPENCODE_EVENTS).toHaveLength(cases.length);
    for (const [name, type, summary] of cases) {
      const ev = normalizeOpencodeEvent({ ...base, event: name, tool: 'read' });
      expect(ev?.provider).toBe('opencode');
      expect(ev?.role).toBe('main');
      expect(ev?.eventType).toBe(type);
      expect(ev?.summary).toBe(summary);
      expect(ev?.projectPath).toBe('/p/app');
    }
  });

  it('turns a failed tool into tool_failed', () => {
    const ev = normalizeOpencodeEvent({ ...base, event: 'tool_end', tool: 'shell', call_id: 'c1', status: 'error' });
    expect(ev).toMatchObject({ eventType: 'tool_failed', outcome: 'failure', summary: 'shell tool failed', toolUseId: 'c1' });
  });

  it('keeps ids, file path and model, and dedups by call and message id', () => {
    const tool = normalizeOpencodeEvent({
      ...base,
      event: 'tool_start',
      tool: 'read',
      call_id: 'call_9',
      file_path: '/p/app/note.txt',
      model: 'opencode/big-pickle',
    });
    expect(tool).toMatchObject({
      toolName: 'read',
      toolUseId: 'call_9',
      dedupKey: 'tool_started:call_9',
      filePath: '/p/app/note.txt',
      model: 'opencode/big-pickle',
    });
    const prompt = normalizeOpencodeEvent({ ...base, event: 'prompt', message_id: 'msg_1' });
    expect(prompt?.dedupKey).toBe('prompt:msg_1');
    const turn = normalizeOpencodeEvent({ ...base, event: 'turn_end', event_id: 'evt_7' });
    expect(turn?.dedupKey).toBe('turn_ended:evt_7');
  });

  it('records why a turn ended when it did not succeed', () => {
    expect(normalizeOpencodeEvent({ ...base, event: 'turn_end', status: 'failed' })).toMatchObject({
      summary: 'Turn failed',
      detail: 'failed',
      outcome: 'failure',
    });
    expect(normalizeOpencodeEvent({ ...base, event: 'turn_end', status: 'interrupted' })).toMatchObject({
      summary: 'Turn interrupted',
      detail: 'interrupt',
    });
  });

  it('drops every field it does not know', () => {
    const ev = normalizeOpencodeEvent({
      ...base,
      event: 'tool_start',
      tool: 'shell',
      input: { command: SECRET },
      prompt: SECRET,
      result: SECRET,
    });
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });

  it('returns null for unknown events and throws on unusable payloads', () => {
    expect(normalizeOpencodeEvent({ ...base, event: 'session.usage.updated' })).toBeNull();
    expect(() => normalizeOpencodeEvent({ event: 'prompt' })).toThrow(ZodError);
    expect(() => normalizeOpencodeEvent('nope')).toThrow(ZodError);
  });
});

describe('POST /ingest/opencode', () => {
  let t: TestHub;
  beforeEach(async () => {
    t = await startTestHub();
  });
  afterEach(() => t.stop());

  const send = (payload: unknown, headers: Record<string, string> = {}) =>
    fetch(`${t.url}/ingest/opencode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Device': 'laptop-a', ...headers },
      body: JSON.stringify(payload),
    });

  it('needs the ingest token', async () => {
    expect((await send({ ...base, event: 'prompt' }, { Authorization: '' })).status).toBe(401);
  });

  it('stores an agent under the opencode provider with its model and tool', async () => {
    expect((await send({ ...base, event: 'prompt' })).status).toBe(204);
    const res = await send({ ...base, event: 'tool_start', tool: 'read', call_id: 'c1', model: 'opencode/big-pickle' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(t.db.all(sql`select provider_id, model, status, current_tool from agents`)).toEqual([
      { provider_id: 'opencode', model: 'opencode/big-pickle', status: 'working', current_tool: 'read' },
    ]);
    expect(t.db.all(sql`select id from providers`)).toEqual([{ id: 'opencode' }]);
  });

  it('answers unknown events with 204 and stores nothing, and bad bodies with 400', async () => {
    expect((await send({ ...base, event: 'whatever' })).status).toBe(204);
    expect(t.db.all(sql`select count(*) as n from events`)).toEqual([{ n: 0 }]);
    expect((await send({ event: 'prompt' })).status).toBe(400);
  });
});
