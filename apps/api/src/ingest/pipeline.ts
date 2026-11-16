import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  DEMO_DEVICE_PREFIX,
  type AgentStatus,
  type NormalizedAgentEvent,
  type StreamMessage,
} from '@ao/shared';
import type { Db } from '../db';
import { agents, devices, events, projects, providers, sessions, tasks } from '../db/schema';
import { getAgentsByIds, getEvent, getTask } from '../queries';
import { resolveAgentState, resolveTaskStatus, statusOnSessionEnd } from '../status/resolver';
import { filterFilePath, folderName } from './paths';

export interface IngestContext {
  deviceName: string;
  isDemo: boolean;
  /** Hub clock, in milliseconds. */
  now: number;
  extraRoots: readonly string[];
}

export type IngestResult =
  | { stored: true; message: StreamMessage }
  | { stored: false; reason: 'duplicate' | 'orphan_subagent_stop' };

const MAIN = 'main';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export const deviceIdFor = (name: string, isDemo: boolean) =>
  isDemo ? `${DEMO_DEVICE_PREFIX}${name}` : name;

/**
 * Stores one normalized event and updates everything it touches, in a single
 * transaction. This is the only code that writes agent activity.
 */
export function ingestEvent(db: Db, ev: NormalizedAgentEvent, ctx: IngestContext): IngestResult {
  return db.transaction((tx): IngestResult => {
    const { now, isDemo } = ctx;
    const deviceId = deviceIdFor(ctx.deviceName, isDemo);
    const sessionId = `${ev.provider}~${deviceId}~${ev.sessionId}`;
    const dedupKey = ev.dedupKey
      ? `${sessionId}~${ev.dedupKey}`
      : ev.providerEventId
        ? `${ev.provider}~${deviceId}~id:${ev.providerEventId}`
        : null;

    if (dedupKey) {
      const seen = tx.select({ id: events.id }).from(events).where(eq(events.dedupKey, dedupKey)).get();
      if (seen) return { stored: false, reason: 'duplicate' };
    }

    const isSubagent = ev.agentId !== undefined;
    const agentId = `${sessionId}~${ev.agentId ?? MAIN}`;
    const mainAgentId = `${sessionId}~${MAIN}`;
    const existingAgent = tx.select().from(agents).where(eq(agents.id, agentId)).get();

    // Claude Code also fires SubagentStop for internal helpers that never had a
    // SubagentStart. With no earlier trace of the agent there is nothing to update.
    if (ev.eventType === 'subagent_stopped' && isSubagent && !existingAgent) {
      return { stored: false, reason: 'orphan_subagent_stop' };
    }

    tx.insert(devices)
      .values({ id: deviceId, name: ctx.deviceName, isDemo, firstSeenAt: now, lastEventAt: now })
      .onConflictDoUpdate({ target: devices.id, set: { lastEventAt: now } })
      .run();
    tx.insert(providers)
      .values({ id: ev.provider, name: ev.provider, firstSeenAt: now, lastEventAt: now })
      .onConflictDoUpdate({ target: providers.id, set: { lastEventAt: now } })
      .run();

    // A session keeps the project it was first seen in, even if the agent later
    // changes directory. Same folder on two devices is two projects.
    let session = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    let projectId = session?.projectId ?? null;
    if (!projectId && ev.projectPath) {
      projectId = hash(`${deviceId}\n${ev.projectPath}`);
      tx.insert(projects)
        .values({
          id: projectId,
          deviceId,
          path: ev.projectPath,
          name: folderName(ev.projectPath),
          isDemo,
          firstSeenAt: now,
          lastEventAt: now,
        })
        .onConflictDoUpdate({ target: projects.id, set: { lastEventAt: now } })
        .run();
    } else if (projectId) {
      tx.update(projects).set({ lastEventAt: now }).where(eq(projects.id, projectId)).run();
    }
    const projectPath = projectId
      ? (tx.select({ path: projects.path }).from(projects).where(eq(projects.id, projectId)).get()?.path ?? null)
      : null;

    const sessionModel = !isSubagent ? ev.model : undefined;
    if (!session) {
      tx.insert(sessions)
        .values({
          id: sessionId,
          providerId: ev.provider,
          providerSessionId: ev.sessionId,
          deviceId,
          projectId,
          model: sessionModel ?? null,
          isDemo,
          startedAt: ev.eventType === 'session_start' ? now : null,
          endedAt: ev.eventType === 'session_end' ? now : null,
          firstSeenAt: now,
          lastEventAt: now,
        })
        .run();
    } else {
      tx.update(sessions)
        .set({
          lastEventAt: now,
          projectId,
          ...(sessionModel ? { model: sessionModel } : {}),
          ...(ev.eventType === 'session_start' ? { startedAt: session.startedAt ?? now, endedAt: null } : {}),
          ...(ev.eventType === 'session_end' ? { endedAt: now } : {}),
        })
        .where(eq(sessions.id, sessionId))
        .run();
    }
    session = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();

    const changedAgentIds = new Set<string>([agentId]);

    // Parent link. An explicit parentAgentId is used as given. Otherwise a
    // subagent event arrived under the parent's own session id, which is the
    // proof that the session's main agent started it (see integrations/claude-code/README.md).
    const parentAgentId = isSubagent
      ? `${sessionId}~${ev.parentAgentId ?? MAIN}`
      : ev.parentAgentId
        ? `${sessionId}~${ev.parentAgentId}`
        : null;
    if (parentAgentId && parentAgentId !== agentId) {
      const parent = tx.select({ id: agents.id }).from(agents).where(eq(agents.id, parentAgentId)).get();
      if (!parent) {
        // We know the parent exists but have never heard from it: status unknown.
        tx.insert(agents)
          .values({
            id: parentAgentId,
            providerId: ev.provider,
            providerAgentId: parentAgentId === mainAgentId ? null : (ev.parentAgentId ?? null),
            sessionId,
            deviceId,
            projectId,
            parentAgentId: null,
            role: parentAgentId === mainAgentId ? 'main' : 'subagent',
            name: parentAgentId === mainAgentId ? MAIN : 'subagent',
            status: 'unknown',
            isDemo,
            firstSeenAt: now,
            lastEventAt: now,
          })
          .run();
        changedAgentIds.add(parentAgentId);
      }
    }

    const next = resolveAgentState(
      {
        status: (existingAgent?.status as AgentStatus | undefined) ?? 'unknown',
        currentTool: existingAgent?.currentTool ?? null,
        currentToolUseId: existingAgent?.currentToolUseId ?? null,
      },
      { eventType: ev.eventType, toolName: ev.toolName, toolUseId: ev.toolUseId },
    );
    const role = ev.role ?? (isSubagent ? 'subagent' : 'main');
    const name = ev.agentType ?? existingAgent?.name ?? (isSubagent ? 'subagent' : MAIN);

    if (!existingAgent) {
      tx.insert(agents)
        .values({
          id: agentId,
          providerId: ev.provider,
          providerAgentId: ev.agentId ?? null,
          sessionId,
          deviceId,
          projectId,
          parentAgentId: parentAgentId !== agentId ? parentAgentId : null,
          role,
          name,
          agentType: ev.agentType ?? null,
          model: ev.model ?? null,
          status: next.status,
          currentTool: next.currentTool,
          currentToolUseId: next.currentToolUseId,
          isDemo,
          firstSeenAt: now,
          lastEventAt: now,
        })
        .run();
    } else {
      tx.update(agents)
        .set({
          status: next.status,
          currentTool: next.currentTool,
          currentToolUseId: next.currentToolUseId,
          lastEventAt: now,
          name,
          projectId: existingAgent.projectId ?? projectId,
          ...(ev.agentType ? { agentType: ev.agentType } : {}),
          ...(ev.model ? { model: ev.model } : {}),
          ...(parentAgentId && parentAgentId !== agentId && !existingAgent.parentAgentId
            ? { parentAgentId }
            : {}),
        })
        .where(eq(agents.id, agentId))
        .run();
    }

    if (ev.eventType === 'session_end' && !isSubagent) {
      const others = tx
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.sessionId, sessionId), ne(agents.id, agentId)))
        .all();
      for (const other of others) {
        const ended = statusOnSessionEnd(other.status as AgentStatus);
        if (ended === other.status) continue;
        tx.update(agents)
          .set({ status: ended, currentTool: null, currentToolUseId: null })
          .where(eq(agents.id, other.id))
          .run();
        changedAgentIds.add(other.id);
      }
    }

    let taskRowId: string | null = null;
    const taskStatus = resolveTaskStatus(ev.eventType);
    if (ev.taskId && taskStatus) {
      taskRowId = `${sessionId}~${ev.taskId}`;
      const existingTask = tx.select().from(tasks).where(eq(tasks.id, taskRowId)).get();
      if (!existingTask) {
        tx.insert(tasks)
          .values({
            id: taskRowId,
            providerTaskId: ev.taskId,
            providerId: ev.provider,
            sessionId,
            agentId,
            projectId,
            status: taskStatus,
            isDemo,
            // Only claim a created time if we actually saw the creation.
            createdAt: taskStatus === 'pending' ? now : null,
            completedAt: taskStatus === 'completed' ? now : null,
            updatedAt: now,
          })
          .run();
      } else {
        tx.update(tasks)
          .set({
            status: taskStatus,
            updatedAt: now,
            ...(taskStatus === 'completed' ? { completedAt: now } : { completedAt: null }),
          })
          .where(eq(tasks.id, taskRowId))
          .run();
      }
    } else if (ev.taskId) {
      taskRowId = `${sessionId}~${ev.taskId}`;
    }

    const inserted = tx
      .insert(events)
      .values({
        providerId: ev.provider,
        deviceId,
        sessionId,
        agentId,
        projectId,
        eventType: ev.eventType,
        toolName: ev.toolName ?? null,
        outcome: ev.outcome ?? null,
        detail: ev.detail ?? null,
        filePath: filterFilePath(ev.filePath, projectPath, ctx.extraRoots),
        taskId: taskRowId,
        providerEventId: ev.providerEventId ?? null,
        dedupKey,
        summary: ev.summary,
        text: ev.text ?? null,
        isDemo,
        receivedAt: now,
      })
      .returning({ id: events.id })
      .get();

    const stored = getEvent(tx as unknown as Db, inserted.id);
    if (!stored) throw new Error('event vanished inside its own transaction');
    const task = taskRowId && taskStatus ? getTask(tx as unknown as Db, taskRowId) : null;
    return {
      stored: true,
      message: {
        event: stored,
        agents: getAgentsByIds(tx as unknown as Db, [...changedAgentIds]),
        tasks: task ? [task] : [],
      },
    };
  });
}
