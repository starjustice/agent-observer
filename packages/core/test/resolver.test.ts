import { describe, expect, it } from 'vitest';
import type { EventType } from '@ao/shared';
import {
  resolveAgentState,
  resolveTaskStatus,
  statusOnSessionEnd,
  type AgentState,
} from '../src/status/resolver';

const fresh: AgentState = { status: 'unknown', currentTool: null, currentToolUseId: null };
const run = (steps: [EventType, string?, string?][], from = fresh) =>
  steps.reduce(
    (state, [eventType, toolName, toolUseId]) => resolveAgentState(state, { eventType, toolName, toolUseId }),
    from,
  );

describe('agent status transitions', () => {
  it('follows a normal turn', () => {
    expect(run([['session_start']]).status).toBe('starting');
    expect(run([['session_start'], ['prompt_submitted']]).status).toBe('working');
    const inTool = run([['prompt_submitted'], ['tool_started', 'Edit', 't1']]);
    expect(inTool).toEqual({ status: 'working', currentTool: 'Edit', currentToolUseId: 't1' });
    const after = resolveAgentState(inTool, { eventType: 'tool_finished', toolUseId: 't1' });
    expect(after).toEqual({ status: 'working', currentTool: null, currentToolUseId: null });
    expect(run([['prompt_submitted'], ['turn_ended']]).status).toBe('idle');
    expect(run([['turn_ended'], ['session_end']]).status).toBe('ended');
  });

  it('waits on a permission request and resumes when the tool runs', () => {
    const waiting = run([['prompt_submitted'], ['permission_requested', 'Bash']]);
    expect(waiting.status).toBe('waiting');
    expect(waiting.currentTool).toBe('Bash');
    expect(run([['tool_started', 'Bash', 't2']], waiting).status).toBe('working');
  });

  it('does not mark the agent failed when one tool fails', () => {
    const state = run([['tool_started', 'Bash', 't1'], ['tool_failed', 'Bash', 't1']]);
    expect(state.status).toBe('working');
    expect(state.currentTool).toBeNull();
  });

  it('keeps the current tool when a different tool call finishes', () => {
    const state = run([['tool_started', 'Bash', 't1'], ['tool_finished', 'Read', 't0']]);
    expect(state.currentTool).toBe('Bash');
  });

  it('handles subagent start and stop', () => {
    expect(run([['subagent_started']]).status).toBe('starting');
    expect(run([['subagent_started'], ['tool_started', 'Grep', 't'], ['subagent_stopped']]).status).toBe(
      'completed',
    );
  });

  it('leaves status alone for task events and notifications', () => {
    const working = run([['prompt_submitted']]);
    for (const e of ['task_created', 'task_completed', 'notification'] as const) {
      expect(resolveAgentState(working, { eventType: e })).toEqual(working);
    }
  });

  it('ends other agents with the session but keeps finished ones', () => {
    expect(statusOnSessionEnd('working')).toBe('ended');
    expect(statusOnSessionEnd('waiting')).toBe('ended');
    expect(statusOnSessionEnd('completed')).toBe('completed');
    expect(statusOnSessionEnd('failed')).toBe('failed');
  });
});

describe('task status transitions', () => {
  it('maps task events and ignores everything else', () => {
    expect(resolveTaskStatus('task_created')).toBe('pending');
    expect(resolveTaskStatus('task_completed')).toBe('completed');
    expect(resolveTaskStatus('tool_started')).toBeNull();
    expect(resolveTaskStatus('session_end')).toBeNull();
  });
});
