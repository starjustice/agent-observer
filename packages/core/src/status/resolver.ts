import type { AgentStatus, EventType, TaskStatus } from '@ao/shared';

export interface AgentState {
  status: AgentStatus;
  currentTool: string | null;
  currentToolUseId: string | null;
}

export interface StatusInput {
  eventType: EventType;
  toolName?: string | undefined;
  toolUseId?: string | undefined;
}

/**
 * Pure status rules. Knows nothing about providers, HTTP or the database.
 * Silence never changes a status: "stale" is worked out separately from
 * lastEventAt and shown next to the status, never instead of it.
 */
export function resolveAgentState(current: AgentState, input: StatusInput): AgentState {
  const cleared = { currentTool: null, currentToolUseId: null };
  switch (input.eventType) {
    case 'session_start':
    case 'subagent_started':
      return { status: 'starting', ...cleared };
    case 'prompt_submitted':
      return { ...current, status: 'working' };
    case 'tool_started':
      return {
        status: 'working',
        currentTool: input.toolName ?? null,
        currentToolUseId: input.toolUseId ?? null,
      };
    case 'tool_finished':
    case 'tool_failed': {
      // A failed tool is recorded on the event. The agent itself carries on.
      const sameCall =
        !current.currentToolUseId ||
        !input.toolUseId ||
        current.currentToolUseId === input.toolUseId;
      return sameCall ? { status: 'working', ...cleared } : { ...current, status: 'working' };
    }
    case 'permission_requested':
      return {
        status: 'waiting',
        currentTool: input.toolName ?? current.currentTool,
        currentToolUseId: current.currentToolUseId,
      };
    case 'turn_ended':
      // The turn ended, not the session.
      return { status: 'idle', ...cleared };
    case 'subagent_stopped':
      return { status: 'completed', ...cleared };
    case 'session_end':
      return { status: 'ended', ...cleared };
    case 'task_created':
    case 'task_completed':
    case 'notification':
      return current;
  }
}

/** Returns the new task status, or null when the event does not concern tasks. */
export function resolveTaskStatus(eventType: EventType): TaskStatus | null {
  if (eventType === 'task_created') return 'pending';
  if (eventType === 'task_completed') return 'completed';
  return null;
}

/** Status for the other agents of a session when that session ends. */
export function statusOnSessionEnd(status: AgentStatus): AgentStatus {
  return status === 'completed' || status === 'failed' ? status : 'ended';
}
