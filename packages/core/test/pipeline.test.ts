import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteExpiredEvents } from '../src/cleanup';
import { normalizeClaudeEvent } from '../src/collectors/claude';
import type { Db } from '../src/db';
import { ingestEvent, type IngestContext } from '../src/ingest/pipeline';
import { createTestDb } from './helpers';
import { getAgent, listAgents, listEvents, listProjects, listSessions, listTasks } from '../src/queries';

let db: Db;
let close: () => void;
let now = 1000;
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({
  deviceName: 'laptop-a',
  isDemo: false,
  now: (now += 10),
  extraRoots: [],
  ...over,
});
const send = (payload: Record<string, unknown>, over: Partial<IngestContext> = {}) => {
  const ev = normalizeClaudeEvent({ session_id: 's1', cwd: '/p/shop', ...payload });
  if (!ev) throw new Error('unhandled event');
  return ingestEvent(db, ev, ctx(over));
};
const real = { demo: false, limit: 100 };
const main = 'claude-code~laptop-a~s1~main';

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  now = 1000;
});
afterEach(() => close());

describe('deduplication', () => {
  it('stores a repeated tool event once', async () => {
    const p = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1' };
    expect((await send(p)).stored).toBe(true);
    expect((await send(p))).toEqual({ stored: false, reason: 'duplicate' });
    expect((await listEvents(db, real))).toHaveLength(1);
  });

  it('treats the same tool id on another device or session as a new event', async () => {
    const p = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1' };
    await send(p);
    expect((await send(p, { deviceName: 'laptop-b' })).stored).toBe(true);
    expect((await send({ ...p, session_id: 's2' })).stored).toBe(true);
    expect((await listEvents(db, real))).toHaveLength(3);
  });

  it('keeps events that carry no id', async () => {
    await send({ hook_event_name: 'Stop' });
    await send({ hook_event_name: 'Stop' });
    expect((await listEvents(db, real))).toHaveLength(2);
  });
});

describe('agents, sessions and projects', () => {
  it('tracks status and current tool through a turn', async () => {
    await send({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' });
    await send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't1' });
    expect((await getAgent(db, main))).toMatchObject({ status: 'working', currentTool: 'Edit', deviceName: 'laptop-a' });
    await send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't1' });
    await send({ hook_event_name: 'Stop' });
    expect((await getAgent(db, main))).toMatchObject({ status: 'idle', currentTool: null, projectName: 'shop' });
  });

  it('keeps two devices with the same folder as two projects', async () => {
    await send({ hook_event_name: 'Stop' });
    await send({ hook_event_name: 'Stop' }, { deviceName: 'laptop-b' });
    const projects = (await listProjects(db, real));
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((p) => p.deviceName))).toEqual(new Set(['laptop-a', 'laptop-b']));
    expect((await listSessions(db, real))).toHaveLength(2);
  });

  it('links a subagent to the main agent of the same session', async () => {
    await send({ hook_event_name: 'UserPromptSubmit' });
    await send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    const sub = (await getAgent(db, 'claude-code~laptop-a~s1~a1'));
    expect(sub).toMatchObject({ role: 'subagent', parentAgentId: main, status: 'starting', name: 'Explore' });
    await send({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' });
    expect((await getAgent(db, 'claude-code~laptop-a~s1~a1'))?.status).toBe('completed');
    expect((await getAgent(db, main))?.status).toBe('working');
  });

  it('ignores a SubagentStop for an agent it never saw', async () => {
    expect((await send({ hook_event_name: 'SubagentStop', agent_id: 'ghost' }))).toEqual({
      stored: false,
      reason: 'orphan_subagent_stop',
    });
    expect((await listAgents(db, real))).toHaveLength(0);
  });

  it('ends running agents when the session ends', async () => {
    await send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    await send({ hook_event_name: 'SessionEnd', reason: 'other' });
    expect((await getAgent(db, main))?.status).toBe('ended');
    expect((await getAgent(db, 'claude-code~laptop-a~s1~a1'))?.status).toBe('ended');
    expect((await listSessions(db, real))[0]?.endedAt).not.toBeNull();
  });

  it('stores file paths relative to the project and drops outside ones', async () => {
    await send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/p/shop/src/a.ts' } });
    await send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: '/etc/hosts' } });
    const [second, first] = (await listEvents(db, real));
    expect(first?.filePath).toBe('src/a.ts');
    expect(second?.filePath).toBeNull();
  });

  it('orders events by the hub clock', async () => {
    await send({ hook_event_name: 'Stop' }, { now: 5000 });
    await send({ hook_event_name: 'UserPromptSubmit' }, { now: 6000 });
    expect((await listEvents(db, real)).map((e) => e.receivedAt)).toEqual([6000, 5000]);
  });
});

describe('task transitions', () => {
  it('creates a pending task and completes it', async () => {
    await send({ hook_event_name: 'TaskCreated', task_id: 'k1' });
    expect((await listTasks(db, real))).toMatchObject([{ providerTaskId: 'k1', status: 'pending', completedAt: null }]);
    await send({ hook_event_name: 'TaskCompleted', task_id: 'k1' });
    const [task] = (await listTasks(db, real));
    expect(task?.status).toBe('completed');
    expect(task?.completedAt).not.toBeNull();
  });

  it('records a completion for a task it never saw created without inventing a creation time', async () => {
    await send({ hook_event_name: 'TaskCompleted', task_id: 'k9' });
    expect((await listTasks(db, real))).toMatchObject([{ status: 'completed', createdAt: null }]);
  });
});

describe('demo separation and retention', () => {
  it('never mixes demo and real records', async () => {
    await send({ hook_event_name: 'Stop' });
    await send({ hook_event_name: 'Stop' }, { isDemo: true });
    expect((await listAgents(db, real)).every((a) => !a.isDemo)).toBe(true);
    const demo = (await listAgents(db, { demo: true, limit: 100 }));
    expect(demo).toHaveLength(1);
    expect(demo[0]).toMatchObject({ isDemo: true, deviceId: 'demo~laptop-a' });
    expect((await listEvents(db, { demo: true, limit: 100 })).every((e) => e.isDemo)).toBe(true);
  });

  it('deletes only events older than the retention period', async () => {
    const day = 24 * 60 * 60 * 1000;
    await send({ hook_event_name: 'Stop' }, { now: 1 * day });
    await send({ hook_event_name: 'Stop' }, { now: 40 * day });
    expect((await deleteExpiredEvents(db, 30, 41 * day))).toBe(1);
    expect((await listEvents(db, real))).toHaveLength(1);
  });
});
