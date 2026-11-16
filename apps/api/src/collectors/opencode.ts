import { z } from 'zod';
import {
  NormalizedAgentEventSchema,
  OPENCODE_PROVIDER_ID,
  TOOL_TEXT_MAX,
  type EventType,
  type NormalizedAgentEvent,
} from '@ao/shared';
import { cleanText } from '../ingest/redact';

/**
 * The payload built by integrations/opencode/agent-observatory.js. Unlike
 * Claude Code hooks, that sender only ever puts these fields on the wire.
 * z.object() still strips anything else, so a changed sender cannot make the
 * hub store tool output. input_text (a short description of what a tool was
 * asked to do) is kept only when the hub runs with CAPTURE_DETAIL on.
 *
 * Field shapes were observed on OpenCode 2.2.1.
 */
const ShortText = z.string().max(200).optional();
const OpencodePayloadSchema = z.object({
  event: z.string().min(1).max(64),
  session_id: z.string().min(1).max(200),
  cwd: z.string().max(1024).optional(),
  tool: ShortText,
  call_id: ShortText,
  message_id: ShortText,
  event_id: ShortText,
  status: z.string().max(64).optional(),
  file_path: z.string().max(1024).optional(),
  model: ShortText,
  input_text: z.string().max(5000).optional().catch(undefined),
});

const EVENT_MAP: Record<string, EventType> = {
  session_start: 'session_start',
  session_end: 'session_end',
  prompt: 'prompt_submitted',
  tool_start: 'tool_started',
  tool_end: 'tool_finished',
  permission: 'permission_requested',
  turn_end: 'turn_ended',
};

export const OPENCODE_EVENTS = Object.keys(EVENT_MAP);

const clean = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined;
  const out = value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
  return out || undefined;
};
const idOf = (value: string | undefined): string | undefined =>
  value && /^[^\s\u0000-\u001f]{1,200}$/.test(value) ? value : undefined;

export interface OpencodeNormalizeOptions {
  /** Keep input_text as `text`. Default off. */
  captureDetail?: boolean;
}

/**
 * Turns one sender payload into a NormalizedAgentEvent.
 * Returns null for events this collector does not handle.
 * Throws a ZodError when the payload is not usable.
 */
export function normalizeOpencodeEvent(
  raw: unknown,
  opts: OpencodeNormalizeOptions = {},
): NormalizedAgentEvent | null {
  const p = OpencodePayloadSchema.parse(raw);
  let eventType = EVENT_MAP[p.event];
  if (!eventType) return null;

  const toolName = clean(p.tool, 128);
  const tool = toolName ?? 'Unknown';
  const callId = idOf(p.call_id);

  const event: NormalizedAgentEvent = {
    provider: OPENCODE_PROVIDER_ID,
    eventType,
    sessionId: p.session_id.replace(/\s+/g, '_'),
    role: 'main',
    summary: '',
  };
  if (p.cwd) event.projectPath = p.cwd;
  const model = clean(p.model, 128);
  if (model) event.model = model;
  // More than one plugin instance can see the same server event.
  const eventId = idOf(p.event_id);
  if (eventId) event.dedupKey = `${eventType}:${eventId}`;

  switch (eventType) {
    case 'session_start':
      event.summary = 'Session started';
      break;
    case 'session_end':
      event.summary = 'Session ended';
      break;
    case 'prompt_submitted': {
      event.summary = 'Prompt submitted';
      const messageId = idOf(p.message_id);
      if (messageId) event.dedupKey = `prompt:${messageId}`;
      break;
    }
    case 'tool_started':
    case 'tool_finished': {
      if (eventType === 'tool_finished' && p.status === 'error') {
        eventType = 'tool_failed';
        event.eventType = eventType;
      }
      if (toolName) event.toolName = toolName;
      if (callId) {
        event.toolUseId = callId;
        event.dedupKey = `${eventType}:${callId}`;
      }
      if (p.file_path) event.filePath = p.file_path;
      if (eventType === 'tool_started') {
        event.summary = `${tool} tool started`;
        if (opts.captureDetail === true) {
          const text = cleanText(p.input_text, TOOL_TEXT_MAX);
          if (text) event.text = text;
        }
      } else if (eventType === 'tool_finished') {
        event.summary = `${tool} tool finished`;
        event.outcome = 'success';
      } else {
        event.summary = `${tool} tool failed`;
        event.outcome = 'failure';
      }
      break;
    }
    case 'permission_requested':
      if (toolName) event.toolName = toolName;
      event.summary = `Permission requested for ${tool}`;
      break;
    case 'turn_ended':
      if (p.status === 'failed') {
        event.summary = 'Turn failed';
        event.detail = 'failed';
        event.outcome = 'failure';
      } else if (p.status === 'interrupted') {
        event.summary = 'Turn interrupted';
        event.detail = 'interrupt';
      } else {
        event.summary = 'Turn ended';
      }
      break;
  }

  return NormalizedAgentEventSchema.parse(event);
}
