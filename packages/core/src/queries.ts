import { and, desc, eq, gt, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type {
  Agent,
  Device,
  Overview,
  Project,
  Provider,
  Session,
  StoredEvent,
  Task,
} from '@ao/shared';
import { AGENT_STATUSES } from '@ao/shared';
import type { Db } from './db';
import { agents, devices, events, projects, providers, sessions, tasks } from './db/schema';

const all = (conds: (SQL | undefined)[]): SQL | undefined => {
  const present = conds.filter((c): c is SQL => c !== undefined);
  return present.length ? and(...present) : undefined;
};

export interface ListFilter {
  demo: boolean;
  deviceId?: string | undefined;
  projectId?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  providerId?: string | undefined;
  limit: number;
  /** Events only: return events with an id below this one. */
  before?: number | undefined;
  /** Events only: return events with an id above this one, oldest first. */
  after?: number | undefined;
}

const agentColumns = {
  id: agents.id,
  providerId: agents.providerId,
  providerAgentId: agents.providerAgentId,
  sessionId: agents.sessionId,
  deviceId: agents.deviceId,
  deviceName: devices.name,
  projectId: agents.projectId,
  projectName: projects.name,
  parentAgentId: agents.parentAgentId,
  role: agents.role,
  name: agents.name,
  agentType: agents.agentType,
  model: agents.model,
  status: agents.status,
  currentTool: agents.currentTool,
  isDemo: agents.isDemo,
  firstSeenAt: agents.firstSeenAt,
  lastEventAt: agents.lastEventAt,
};

const agentQuery = (db: Db) =>
  db
    .select(agentColumns)
    .from(agents)
    .innerJoin(devices, eq(agents.deviceId, devices.id))
    .leftJoin(projects, eq(agents.projectId, projects.id));

export async function listAgents(db: Db, f: ListFilter): Promise<Agent[]> {
  return (await agentQuery(db)
    .where(
      all([
        eq(agents.isDemo, f.demo),
        f.deviceId ? eq(agents.deviceId, f.deviceId) : undefined,
        f.projectId ? eq(agents.projectId, f.projectId) : undefined,
        f.sessionId ? eq(agents.sessionId, f.sessionId) : undefined,
        f.providerId ? eq(agents.providerId, f.providerId) : undefined,
      ]),
    )
    .orderBy(desc(agents.lastEventAt))
    .limit(f.limit)
    .all()) as Agent[];
}

export async function getAgentsByIds(db: Db, ids: string[]): Promise<Agent[]> {
  if (ids.length === 0) return [];
  return (await agentQuery(db).where(inArray(agents.id, ids)).all()) as Agent[];
}

export async function getAgent(db: Db, id: string): Promise<Agent | null> {
  return ((await agentQuery(db).where(eq(agents.id, id)).get()) as Agent | undefined) ?? null;
}

const eventColumns = {
  id: events.id,
  providerId: events.providerId,
  deviceId: events.deviceId,
  deviceName: devices.name,
  sessionId: events.sessionId,
  agentId: events.agentId,
  agentName: agents.name,
  projectId: events.projectId,
  projectName: projects.name,
  eventType: events.eventType,
  toolName: events.toolName,
  outcome: events.outcome,
  detail: events.detail,
  filePath: events.filePath,
  taskId: events.taskId,
  summary: events.summary,
  text: events.text,
  isDemo: events.isDemo,
  receivedAt: events.receivedAt,
};

const eventQuery = (db: Db) =>
  db
    .select(eventColumns)
    .from(events)
    .innerJoin(devices, eq(events.deviceId, devices.id))
    .innerJoin(agents, eq(events.agentId, agents.id))
    .leftJoin(projects, eq(events.projectId, projects.id));

export async function listEvents(db: Db, f: ListFilter): Promise<StoredEvent[]> {
  const where = all([
    eq(events.isDemo, f.demo),
    f.deviceId ? eq(events.deviceId, f.deviceId) : undefined,
    f.projectId ? eq(events.projectId, f.projectId) : undefined,
    f.sessionId ? eq(events.sessionId, f.sessionId) : undefined,
    f.agentId ? eq(events.agentId, f.agentId) : undefined,
    f.providerId ? eq(events.providerId, f.providerId) : undefined,
    f.before !== undefined ? lt(events.id, f.before) : undefined,
    f.after !== undefined ? gt(events.id, f.after) : undefined,
  ]);
  const order = f.after !== undefined ? events.id : desc(events.id);
  return (await eventQuery(db).where(where).orderBy(order).limit(f.limit).all()) as StoredEvent[];
}

export async function getEvent(db: Db, id: number): Promise<StoredEvent | null> {
  return ((await eventQuery(db).where(eq(events.id, id)).get()) as StoredEvent | undefined) ?? null;
}

export async function listSessions(db: Db, f: ListFilter): Promise<Session[]> {
  return await db
    .select({
      id: sessions.id,
      providerId: sessions.providerId,
      providerSessionId: sessions.providerSessionId,
      deviceId: sessions.deviceId,
      deviceName: devices.name,
      projectId: sessions.projectId,
      projectName: projects.name,
      model: sessions.model,
      isDemo: sessions.isDemo,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      firstSeenAt: sessions.firstSeenAt,
      lastEventAt: sessions.lastEventAt,
    })
    .from(sessions)
    .innerJoin(devices, eq(sessions.deviceId, devices.id))
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      all([
        eq(sessions.isDemo, f.demo),
        f.deviceId ? eq(sessions.deviceId, f.deviceId) : undefined,
        f.projectId ? eq(sessions.projectId, f.projectId) : undefined,
        f.providerId ? eq(sessions.providerId, f.providerId) : undefined,
      ]),
    )
    .orderBy(desc(sessions.lastEventAt))
    .limit(f.limit)
    .all();
}

const taskColumns = {
  id: tasks.id,
  providerTaskId: tasks.providerTaskId,
  providerId: tasks.providerId,
  sessionId: tasks.sessionId,
  agentId: tasks.agentId,
  projectId: tasks.projectId,
  status: tasks.status,
  isDemo: tasks.isDemo,
  createdAt: tasks.createdAt,
  completedAt: tasks.completedAt,
  updatedAt: tasks.updatedAt,
};

export async function listTasks(db: Db, f: ListFilter): Promise<Task[]> {
  return (await db
    .select(taskColumns)
    .from(tasks)
    .where(
      all([
        eq(tasks.isDemo, f.demo),
        f.sessionId ? eq(tasks.sessionId, f.sessionId) : undefined,
        f.agentId ? eq(tasks.agentId, f.agentId) : undefined,
        f.projectId ? eq(tasks.projectId, f.projectId) : undefined,
      ]),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(f.limit)
    .all()) as Task[];
}

export async function getTask(db: Db, id: string): Promise<Task | null> {
  return ((await db.select(taskColumns).from(tasks).where(eq(tasks.id, id)).get()) as Task | undefined) ?? null;
}

export async function listProjects(db: Db, f: ListFilter): Promise<Project[]> {
  return await db
    .select({
      id: projects.id,
      deviceId: projects.deviceId,
      deviceName: devices.name,
      path: projects.path,
      name: projects.name,
      isDemo: projects.isDemo,
      firstSeenAt: projects.firstSeenAt,
      lastEventAt: projects.lastEventAt,
    })
    .from(projects)
    .innerJoin(devices, eq(projects.deviceId, devices.id))
    .where(
      all([eq(projects.isDemo, f.demo), f.deviceId ? eq(projects.deviceId, f.deviceId) : undefined]),
    )
    .orderBy(desc(projects.lastEventAt))
    .limit(f.limit)
    .all();
}

export async function listDevices(db: Db, demo: boolean): Promise<Device[]> {
  return await db.select().from(devices).where(eq(devices.isDemo, demo)).orderBy(devices.name).all();
}

export async function listProviders(db: Db): Promise<Provider[]> {
  return await db.select().from(providers).orderBy(providers.id).all();
}

export async function getOverview(db: Db, demo: boolean, now: number): Promise<Overview> {
  const rows = await db
    .select({ status: agents.status, n: sql<number>`count(*)` })
    .from(agents)
    .where(eq(agents.isDemo, demo))
    .groupBy(agents.status)
    .all();
  const byStatus = Object.fromEntries(AGENT_STATUSES.map((s) => [s, 0])) as Overview['counts']['byStatus'];
  let total = 0;
  for (const row of rows) {
    total += row.n;
    if ((AGENT_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as keyof typeof byStatus] = row.n;
    }
  }
  const latest = await db.select({ id: sql<number | null>`max(${events.id})` }).from(events).get();
  return {
    counts: { total, byStatus },
    devices: await listDevices(db, demo),
    latestEventId: latest?.id ?? null,
    serverTime: now,
  };
}
