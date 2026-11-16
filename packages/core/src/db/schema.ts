import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const bool = (name: string) => integer(name, { mode: 'boolean' }).notNull().default(false);

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isDemo: bool('is_demo'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastEventAt: integer('last_event_at').notNull(),
});

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastEventAt: integer('last_event_at'),
});

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    path: text('path').notNull(),
    name: text('name').notNull(),
    isDemo: bool('is_demo'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastEventAt: integer('last_event_at').notNull(),
  },
  (t) => [uniqueIndex('projects_device_path_uq').on(t.deviceId, t.path)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    providerSessionId: text('provider_session_id').notNull(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    projectId: text('project_id').references(() => projects.id),
    model: text('model'),
    isDemo: bool('is_demo'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastEventAt: integer('last_event_at').notNull(),
  },
  (t) => [
    index('sessions_provider_idx').on(t.providerId),
    index('sessions_project_idx').on(t.projectId),
    index('sessions_device_idx').on(t.deviceId),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    providerAgentId: text('provider_agent_id'),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    projectId: text('project_id').references(() => projects.id),
    parentAgentId: text('parent_agent_id'),
    role: text('role').notNull(),
    name: text('name').notNull(),
    agentType: text('agent_type'),
    model: text('model'),
    status: text('status').notNull(),
    currentTool: text('current_tool'),
    currentToolUseId: text('current_tool_use_id'),
    isDemo: bool('is_demo'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastEventAt: integer('last_event_at').notNull(),
  },
  (t) => [
    index('agents_provider_idx').on(t.providerId),
    index('agents_session_idx').on(t.sessionId),
    index('agents_project_idx').on(t.projectId),
    index('agents_device_idx').on(t.deviceId),
    index('agents_parent_idx').on(t.parentAgentId),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    providerTaskId: text('provider_task_id').notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    agentId: text('agent_id'),
    projectId: text('project_id'),
    status: text('status').notNull(),
    isDemo: bool('is_demo'),
    createdAt: integer('created_at'),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('tasks_session_idx').on(t.sessionId),
    index('tasks_agent_idx').on(t.agentId),
    index('tasks_project_idx').on(t.projectId),
  ],
);

export const events = sqliteTable(
  'events',
  {
    /** Also the Server-Sent Events id, so it must only ever grow. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    providerId: text('provider_id').notNull(),
    deviceId: text('device_id').notNull(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    projectId: text('project_id'),
    eventType: text('event_type').notNull(),
    toolName: text('tool_name'),
    outcome: text('outcome'),
    detail: text('detail'),
    filePath: text('file_path'),
    taskId: text('task_id'),
    providerEventId: text('provider_event_id'),
    dedupKey: text('dedup_key'),
    summary: text('summary').notNull(),
    /** Prompt or tool input, masked and trimmed. Null when capture is off. */
    text: text('text'),
    isDemo: bool('is_demo'),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => [
    uniqueIndex('events_dedup_uq').on(t.dedupKey),
    index('events_provider_idx').on(t.providerId),
    index('events_agent_idx').on(t.agentId),
    index('events_session_idx').on(t.sessionId),
    index('events_project_idx').on(t.projectId),
    index('events_received_idx').on(t.receivedAt),
    index('events_device_idx').on(t.deviceId),
  ],
);
