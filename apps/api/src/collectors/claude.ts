import { z } from 'zod';
import {
  CLAUDE_PROVIDER_ID,
  DETAIL_TEXT_MAX,
  NormalizedAgentEventSchema,
  TOOL_TEXT_MAX,
  type EventType,
  type NormalizedAgentEvent,
} from '@ao/shared';
import { cleanText } from '../ingest/redact';

/**
 * Only the fields we are allowed to look at. z.object() strips everything else,
 * so tool_response, last_assistant_message, transcript paths, file contents and
 * the rest of tool_input never leave this function. The prompt and the few
 * tool_input fields that say what a tool was asked to do are read here, but
 * they only reach the event when the hub runs with CAPTURE_DETAIL on.
 *
 * Field names follow https://code.claude.com/docs/en/hooks (checked for
 * Claude Code 2.1.310).
 */
const key = z.string().min(1).max(200);
const input = z.string().max(20000).optional().catch(undefined);
const ClaudeHookPayloadSchema = z.object({
  session_id: key,
  hook_event_name: z.string().min(1).max(64),
  cwd: z.string().max(1024).optional(),
  agent_id: z.string().max(200).optional(),
  agent_type: z.string().max(200).optional(),
  prompt_id: z.string().max(200).optional(),
  tool_name: z.string().max(400).optional(),
  tool_use_id: z.string().max(200).optional(),
  prompt: z.string().max(100000).optional().catch(undefined),
  tool_input: z
    .object({
      file_path: z.string().max(1024).optional(),
      notebook_path: z.string().max(1024).optional(),
      command: input,
      description: input,
      pattern: input,
      path: input,
      glob: input,
      query: input,
      url: input,
      subagent_type: input,
      prompt: input,
    })
    .optional()
    .catch(undefined),
  task_id: z.string().max(200).optional(),
  source: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  reason: z.string().max(64).optional(),
  notification_type: z.string().max(64).optional(),
  is_interrupt: z.boolean().optional().catch(undefined),
});

const EVENT_MAP: Record<string, EventType> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'prompt_submitted',
  PreToolUse: 'tool_started',
  PostToolUse: 'tool_finished',
  PostToolUseFailure: 'tool_failed',
  PermissionRequest: 'permission_requested',
  SubagentStart: 'subagent_started',
  SubagentStop: 'subagent_stopped',
  TaskCreated: 'task_created',
  TaskCompleted: 'task_completed',
  Stop: 'turn_ended',
  Notification: 'notification',
};

export const CLAUDE_HOOK_EVENTS = Object.keys(EVENT_MAP);

const clean = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined;
  const out = value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
  return out || undefined;
};
const idOf = (value: string | undefined): string | undefined =>
  value && /^[^\s\u0000-\u001f]{1,200}$/.test(value) ? value : undefined;
const codeOf = (value: string | undefined): string | undefined =>
  value && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;

type ToolInput = NonNullable<z.infer<typeof ClaudeHookPayloadSchema>['tool_input']>;

const oneLine = (value: string | undefined, max: number): string | undefined =>
  value ? value.replace(/\s+/g, ' ').trim().slice(0, max) || undefined : undefined;

/** A short, readable description of what a tool was asked to do. File tools return nothing: their path is stored already. */
function describeToolInput(tool: string, i: ToolInput | undefined): string | undefined {
  if (!i) return undefined;
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return i.command;
    case 'Grep': {
      if (!i.pattern) return undefined;
      const where = i.path ?? i.glob;
      return `"${oneLine(i.pattern, 200)}"${where ? ` in ${oneLine(where, 200)}` : ''}`;
    }
    case 'Glob':
      return i.pattern ?? i.glob;
    case 'WebFetch':
      return i.url;
    case 'WebSearch':
      return i.query;
    case 'Agent':
    case 'Task': {
      const head = [i.subagent_type, oneLine(i.description, 200)].filter(Boolean).join(': ');
      const brief = oneLine(i.prompt, 300);
      return [head, brief].filter(Boolean).join('\n') || undefined;
    }
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return undefined;
    default: {
      const parts = Object.entries({
        description: i.description,
        query: i.query,
        pattern: i.pattern,
        url: i.url,
        command: i.command,
      })
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${oneLine(v, 120)}`);
      return parts.length ? parts.join(' ') : undefined;
    }
  }
}

export interface ClaudeNormalizeOptions {
  /** Keep the prompt and tool input as `text`. Default off, so a bare call stays strict. */
  captureDetail?: boolean;
}

/**
 * Turns one raw Claude Code hook payload into a NormalizedAgentEvent.
 * Returns null for hook events this collector does not handle.
 * Throws a ZodError when the payload is not a usable hook payload.
 */
export function normalizeClaudeEvent(
  raw: unknown,
  opts: ClaudeNormalizeOptions = {},
): NormalizedAgentEvent | null {
  const p = ClaudeHookPayloadSchema.parse(raw);
  const capture = opts.captureDetail === true;
  const eventType = EVENT_MAP[p.hook_event_name];
  if (!eventType) return null;

  const agentId = idOf(p.agent_id);
  const agentType = clean(p.agent_type, 128);
  const toolName = clean(p.tool_name, 128);
  const toolUseId = idOf(p.tool_use_id);
  const taskId = idOf(p.task_id);
  const tool = toolName ?? 'Unknown';
  const sub = agentType ?? 'Unnamed';

  const event: NormalizedAgentEvent = {
    provider: CLAUDE_PROVIDER_ID,
    eventType,
    sessionId: p.session_id.replace(/\s+/g, '_'),
    summary: '',
  };
  if (agentId) {
    event.agentId = agentId;
    event.role = 'subagent';
  } else {
    event.role = 'main';
  }
  if (agentType) event.agentType = agentType;
  if (p.cwd) event.projectPath = p.cwd;

  switch (eventType) {
    case 'session_start': {
      event.summary = 'Session started';
      const detail = codeOf(p.source);
      if (detail) event.detail = detail;
      const model = clean(p.model, 128);
      if (model) event.model = model;
      break;
    }
    case 'session_end': {
      event.summary = 'Session ended';
      const detail = codeOf(p.reason);
      if (detail) event.detail = detail;
      break;
    }
    case 'prompt_submitted': {
      event.summary = 'Prompt submitted';
      if (capture) {
        const text = cleanText(p.prompt, DETAIL_TEXT_MAX);
        if (text) event.text = text;
      }
      const promptId = idOf(p.prompt_id);
      if (promptId) event.dedupKey = `prompt:${promptId}`;
      break;
    }
    case 'tool_started':
    case 'tool_finished':
    case 'tool_failed': {
      if (toolName) event.toolName = toolName;
      if (toolUseId) {
        event.toolUseId = toolUseId;
        event.dedupKey = `${eventType}:${toolUseId}`;
      }
      const filePath = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
      if (filePath) event.filePath = filePath;
      if (eventType === 'tool_started') {
        event.summary = `${tool} tool started`;
        if (capture) {
          const text = cleanText(describeToolInput(tool, p.tool_input), TOOL_TEXT_MAX);
          if (text) event.text = text;
        }
      } else if (eventType === 'tool_finished') {
        event.summary = `${tool} tool finished`;
        event.outcome = 'success';
      } else {
        event.outcome = 'failure';
        if (p.is_interrupt) {
          event.summary = `${tool} tool interrupted`;
          event.detail = 'interrupt';
        } else {
          event.summary = `${tool} tool failed`;
        }
      }
      break;
    }
    case 'permission_requested':
      if (toolName) event.toolName = toolName;
      event.summary = `Permission requested for ${tool}`;
      if (capture) {
        const text = cleanText(describeToolInput(tool, p.tool_input), TOOL_TEXT_MAX);
        if (text) event.text = text;
      }
      break;
    case 'subagent_started':
      event.summary = `${sub} subagent started`;
      break;
    case 'subagent_stopped':
      event.summary = `${sub} subagent finished`;
      break;
    case 'task_created':
      if (taskId) {
        event.taskId = taskId;
        event.dedupKey = `task_created:${taskId}`;
      }
      event.summary = 'Task created';
      break;
    case 'task_completed':
      if (taskId) event.taskId = taskId;
      event.summary = 'Task completed';
      break;
    case 'turn_ended':
      event.summary = 'Turn ended';
      break;
    case 'notification': {
      const detail = codeOf(p.notification_type);
      if (detail) event.detail = detail;
      event.summary = detail ? `Notification: ${detail}` : 'Notification';
      break;
    }
  }

  return NormalizedAgentEventSchema.parse(event);
}
