import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteExpiredEvents } from '../src/cleanup';
import { normalizeClaudeEvent } from '../src/collectors/claude';
import { openDatabase, type Db } from '../src/db';
import { ingestEvent, type IngestContext } from '../src/ingest/pipeline';
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

beforeEach(() => {
  ({ db, close } = openDatabase(':memory:'));
  now = 1000;
});
afterEach(() => close());

describe('deduplication', () => {
  it('stores a repeated tool event once', () => {
    const p = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1' };
    expect(send(p).stored).toBe(true);
    expect(send(p)).toEqual({ stored: false, reason: 'duplicate' });
    expect(listEvents(db, real)).toHaveLength(1);
  });

  it('treats the same tool id on another device or session as a new event', () => {
    const p = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1' };
    send(p);
    expect(send(p, { deviceName: 'laptop-b' }).stored).toBe(true);
    expect(send({ ...p, session_id: 's2' }).stored).toBe(true);
    expect(listEvents(db, real)).toHaveLength(3);
  });

  it('keeps events that carry no id', () => {
    send({ hook_event_name: 'Stop' });
    send({ hook_event_name: 'Stop' });
    expect(listEvents(db, real)).toHaveLength(2);
  });
});

describe('agents, sessions and projects', () => {
  it('tracks status and current tool through a turn', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' });
    send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't1' });
    expect(getAgent(db, main)).toMatchObject({ status: 'working', currentTool: 'Edit', deviceName: 'laptop-a' });
    send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't1' });
    send({ hook_event_name: 'Stop' });
    expect(getAgent(db, main)).toMatchObject({ status: 'idle', currentTool: null, projectName: 'shop' });
  });

  it('keeps two devices with the same folder as two projects', () => {
    send({ hook_event_name: 'Stop' });
    send({ hook_event_name: 'Stop' }, { deviceName: 'laptop-b' });
    const projects = listProjects(db, real);
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((p) => p.deviceName))).toEqual(new Set(['laptop-a', 'laptop-b']));
    expect(listSessions(db, real)).toHaveLength(2);
  });

  it('links a subagent to the main agent of the same session', () => {
    send({ hook_event_name: 'UserPromptSubmit' });
    send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    const sub = getAgent(db, 'claude-code~laptop-a~s1~a1');
    expect(sub).toMatchObject({ role: 'subagent', parentAgentId: main, status: 'starting', name: 'Explore' });
    send({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' });
    expect(getAgent(db, 'claude-code~laptop-a~s1~a1')?.status).toBe('completed');
    expect(getAgent(db, main)?.status).toBe('working');
  });

  it('ignores a SubagentStop for an agent it never saw', () => {
    expect(send({ hook_event_name: 'SubagentStop', agent_id: 'ghost' })).toEqual({
      stored: false,
      reason: 'orphan_subagent_stop',
    });
    expect(listAgents(db, real)).toHaveLength(0);
  });

  it('ends running agents when the session ends', () => {
    send({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    send({ hook_event_name: 'SessionEnd', reason: 'other' });
    expect(getAgent(db, main)?.status).toBe('ended');
    expect(getAgent(db, 'claude-code~laptop-a~s1~a1')?.status).toBe('ended');
    expect(listSessions(db, real)[0]?.endedAt).not.toBeNull();
  });

  it('stores file paths relative to the project and drops outside ones', () => {
    send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/p/shop/src/a.ts' } });
    send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: '/etc/hosts' } });
    const [second, first] = listEvents(db, real);
    expect(first?.filePath).toBe('src/a.ts');
    expect(second?.filePath).toBeNull();
  });

  it('orders events by the hub clock', () => {
    send({ hook_event_name: 'Stop' }, { now: 5000 });
    send({ hook_event_name: 'UserPromptSubmit' }, { now: 6000 });
    expect(listEvents(db, real).map((e) => e.receivedAt)).toEqual([6000, 5000]);
  });
});

describe('task transitions', () => {
  it('creates a pending task and completes it', () => {
    send({ hook_event_name: 'TaskCreated', task_id: 'k1' });
    expect(listTasks(db, real)).toMatchObject([{ providerTaskId: 'k1', status: 'pending', completedAt: null }]);
    send({ hook_event_name: 'TaskCompleted', task_id: 'k1' });
    const [task] = listTasks(db, real);
    expect(task?.status).toBe('completed');
    expect(task?.completedAt).not.toBeNull();
  });

  it('records a completion for a task it never saw created without inventing a creation time', () => {
    send({ hook_event_name: 'TaskCompleted', task_id: 'k9' });
    expect(listTasks(db, real)).toMatchObject([{ status: 'completed', createdAt: null }]);
  });
});

describe('demo separation and retention', () => {
  it('never mixes demo and real records', () => {
    send({ hook_event_name: 'Stop' });
    send({ hook_event_name: 'Stop' }, { isDemo: true });
    expect(listAgents(db, real).every((a) => !a.isDemo)).toBe(true);
    const demo = listAgents(db, { demo: true, limit: 100 });
    expect(demo).toHaveLength(1);
    expect(demo[0]).toMatchObject({ isDemo: true, deviceId: 'demo~laptop-a' });
    expect(listEvents(db, { demo: true, limit: 100 }).every((e) => e.isDemo)).toBe(true);
  });

  it('deletes only events older than the retention period', () => {
    const day = 24 * 60 * 60 * 1000;
    send({ hook_event_name: 'Stop' }, { now: 1 * day });
    send({ hook_event_name: 'Stop' }, { now: 40 * day });
    expect(deleteExpiredEvents(db, 30, 41 * day)).toBe(1);
    expect(listEvents(db, real)).toHaveLength(1);
  });
});
