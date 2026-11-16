import { z } from 'zod';
import {
  AGENT_ROLES,
  AGENT_STATUSES,
  DETAIL_TEXT_MAX,
  EVENT_OUTCOMES,
  EVENT_TYPES,
  TASK_STATUSES,
} from './constants';

export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export const EventTypeSchema = z.enum(EVENT_TYPES);
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const EventOutcomeSchema = z.enum(EVENT_OUTCOMES);
export const AgentRoleSchema = z.enum(AGENT_ROLES);

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type EventOutcome = z.infer<typeof EventOutcomeSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** A device name as sent in the X-Device header. */
export const DeviceNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, dot, dash, underscore; max 64');

export const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/** IDs handed to us by a provider. Opaque, single line, bounded. */
const ProviderKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s\u0000-\u001f]+$/, 'no whitespace or control characters');

/** Short machine codes such as "startup" or "permission_prompt". Never free text. */
const DetailCode = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

const ShortLabel = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f]+$/);

/**
 * The one event shape every provider is normalized into before storage.
 * `text` is the only free-text field. It holds the user's prompt or a short
 * description of what a tool was asked to do (a command, a search pattern, a
 * subagent task), and only when the hub has CAPTURE_DETAIL on. Tool output, AI
 * replies and file contents have no field at all.
 * The device name and receivedAt are added by the hub, not by the sender.
 */
export const NormalizedAgentEventSchema = z.strictObject({
  provider: ProviderIdSchema,
  eventType: EventTypeSchema,
  sessionId: ProviderKey,
  /** Absent means the session's main agent. */
  agentId: ProviderKey.optional(),
  agentType: ShortLabel.optional(),
  parentAgentId: ProviderKey.optional(),
  role: AgentRoleSchema.optional(),
  model: ShortLabel.optional(),
  /** Absolute folder the session runs in. Used to group sessions into projects. */
  projectPath: z.string().min(1).max(1024).optional(),
  toolName: ShortLabel.optional(),
  toolUseId: ProviderKey.optional(),
  outcome: EventOutcomeSchema.optional(),
  detail: DetailCode.optional(),
  /** Absolute path a tool touched. Dropped unless inside an allowed project root. */
  filePath: z.string().min(1).max(1024).optional(),
  taskId: ProviderKey.optional(),
  providerEventId: ProviderKey.optional(),
  /** Scoped to the session by the hub. Two events with the same key are one event. */
  dedupKey: z.string().min(1).max(300).optional(),
  /** Fixed template text built in code, never model or user text. */
  summary: z.string().min(1).max(160),
  /** Prompt or tool input, secrets masked, trimmed. Present only with CAPTURE_DETAIL on. */
  text: z
    .string()
    .min(1)
    .max(DETAIL_TEXT_MAX)
    .regex(/^[^\u0000-\u0008\u000b-\u001f]+$/, 'no control characters except newline and tab')
    .optional(),
});
export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDemo: z.boolean(),
  firstSeenAt: z.number(),
  lastEventAt: z.number(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  firstSeenAt: z.number(),
  lastEventAt: z.number().nullable(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  path: z.string(),
  /** Folder name, used as the label. */
  name: z.string(),
  isDemo: z.boolean(),
  firstSeenAt: z.number(),
  lastEventAt: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerSessionId: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  model: z.string().nullable(),
  isDemo: z.boolean(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  firstSeenAt: z.number(),
  lastEventAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerAgentId: z.string().nullable(),
  sessionId: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  role: AgentRoleSchema,
  name: z.string(),
  agentType: z.string().nullable(),
  model: z.string().nullable(),
  status: AgentStatusSchema,
  currentTool: z.string().nullable(),
  isDemo: z.boolean(),
  firstSeenAt: z.number(),
  lastEventAt: z.number(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  providerTaskId: z.string(),
  providerId: z.string(),
  sessionId: z.string(),
  agentId: z.string().nullable(),
  projectId: z.string().nullable(),
  status: TaskStatusSchema,
  isDemo: z.boolean(),
  createdAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const StoredEventSchema = z.object({
  id: z.number(),
  providerId: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  eventType: EventTypeSchema,
  toolName: z.string().nullable(),
  outcome: EventOutcomeSchema.nullable(),
  detail: z.string().nullable(),
  /** Relative to the project folder when inside it. */
  filePath: z.string().nullable(),
  taskId: z.string().nullable(),
  summary: z.string(),
  /** The prompt or tool input behind the summary, when the hub captured it. */
  text: z.string().nullable(),
  isDemo: z.boolean(),
  /** Hub clock. All ordering uses this, never a device clock. */
  receivedAt: z.number(),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

/** One message on the live stream: the new event plus every record it changed. */
export const StreamMessageSchema = z.object({
  event: StoredEventSchema,
  agents: z.array(AgentSchema),
  tasks: z.array(TaskSchema),
});
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

export const OverviewSchema = z.object({
  counts: z.object({
    total: z.number(),
    byStatus: z.record(AgentStatusSchema, z.number()),
  }),
  devices: z.array(DeviceSchema),
  latestEventId: z.number().nullable(),
  serverTime: z.number(),
});
export type Overview = z.infer<typeof OverviewSchema>;
