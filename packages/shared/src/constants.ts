export const AGENT_STATUSES = [
  'starting',
  'working',
  'waiting',
  'idle',
  'completed',
  'failed',
  'ended',
  'unknown',
] as const;

export const EVENT_TYPES = [
  'session_start',
  'session_end',
  'prompt_submitted',
  'tool_started',
  'tool_finished',
  'tool_failed',
  'permission_requested',
  'subagent_started',
  'subagent_stopped',
  'task_created',
  'task_completed',
  'turn_ended',
  'notification',
] as const;

export const TASK_STATUSES = ['pending', 'completed', 'unknown'] as const;
export const EVENT_OUTCOMES = ['success', 'failure'] as const;
export const AGENT_ROLES = ['main', 'subagent'] as const;

/** Statuses where silence is worth pointing out. */
export const LIVE_STATUSES = ['starting', 'working', 'waiting'] as const;

/** An agent in a live status with no events for this long is shown as stale. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export const SESSION_COOKIE = 'ao_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const DEVICE_HEADER = 'x-device';
export const DEMO_HEADER = 'x-demo';
/** Optional. The sender's model id, for providers whose events do not carry it. */
export const MODEL_HEADER = 'x-model';
export const MODEL_HEADER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,127}$/;
export const DEMO_DEVICE_PREFIX = 'demo~';

export const CLAUDE_PROVIDER_ID = 'claude-code';
export const OPENCODE_PROVIDER_ID = 'opencode';

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_REPLAY_LIMIT = 500;

/** Longest prompt kept on an event. Commands and other tool input are cut shorter. */
export const DETAIL_TEXT_MAX = 1000;
export const TOOL_TEXT_MAX = 500;
