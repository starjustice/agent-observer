import express, { Router } from 'express';
import { z } from 'zod';
import { SSE_REPLAY_LIMIT } from '@ao/shared';
import { LoginLimiter, loginHandler, logoutHandler, requireViewer } from '../auth';
import type { AppDeps } from '../app';
import {
  getAgent,
  getAgentsByIds,
  getOverview,
  listAgents,
  listEvents,
  listProjects,
  listProviders,
  listSessions,
  listTasks,
  type ListFilter,
} from '../queries';
import { formatSse } from '../sse/hub';

const id = z.string().min(1).max(700).optional();
const QuerySchema = z.object({
  demo: z.enum(['0', '1', 'true', 'false']).optional(),
  device: id,
  project: id,
  session: id,
  agent: id,
  provider: id,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().min(0).optional(),
  after: z.coerce.number().int().min(0).optional(),
});

export function readRouter(deps: AppDeps): Router {
  const router = Router();
  const { config, db, hub, now } = deps;
  const limiter = new LoginLimiter();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // The only read endpoints that work without logging in.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.post('/auth/login', express.json({ limit: '2kb' }), loginHandler(config, limiter, now));
  router.post('/auth/logout', logoutHandler);

  router.use(requireViewer(config, now));

  router.get('/auth/me', (_req, res) => {
    res.json({ authenticated: true });
  });

  const filter = (query: unknown): ListFilter | null => {
    const parsed = QuerySchema.safeParse(query);
    if (!parsed.success) return null;
    const q = parsed.data;
    return {
      demo: q.demo === '1' || q.demo === 'true',
      deviceId: q.device,
      projectId: q.project,
      sessionId: q.session,
      agentId: q.agent,
      providerId: q.provider,
      limit: q.limit,
      before: q.before,
      after: q.after,
    };
  };

  const list =
    <T>(fn: (f: ListFilter) => T) =>
    (req: express.Request, res: express.Response) => {
      const f = filter(req.query);
      if (!f) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }
      res.json(fn(f));
    };

  router.get('/overview', list((f) => getOverview(db, f.demo, now())));
  router.get('/agents', list((f) => listAgents(db, f)));
  router.get('/agents/:id', (req, res) => {
    const agent = getAgent(db, req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const children = listAgents(db, { demo: agent.isDemo, sessionId: agent.sessionId, limit: 500 }).filter(
      (a) => a.parentAgentId === agent.id,
    );
    res.json({
      agent,
      parent: agent.parentAgentId ? getAgent(db, agent.parentAgentId) : null,
      children,
      tasks: listTasks(db, { demo: agent.isDemo, agentId: agent.id, limit: 100 }),
      recentEvents: listEvents(db, { demo: agent.isDemo, agentId: agent.id, limit: 50 }),
    });
  });
  router.get('/sessions', list((f) => listSessions(db, f)));
  router.get('/tasks', list((f) => listTasks(db, f)));
  router.get('/events', list((f) => listEvents(db, f)));
  router.get('/projects', list((f) => listProjects(db, f)));
  router.get('/providers', (_req, res) => {
    res.json(listProviders(db));
  });

  router.get('/stream', (req, res) => {
    const f = filter(req.query);
    if (!f) {
      res.status(400).end();
      return;
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    // Replay what the browser missed while it was disconnected.
    const lastId = Number(req.header('last-event-id') ?? req.query.lastEventId ?? NaN);
    if (Number.isInteger(lastId) && lastId >= 0) {
      const missed = listEvents(db, { demo: f.demo, after: lastId, limit: SSE_REPLAY_LIMIT });
      const snapshot = new Map(
        getAgentsByIds(db, [...new Set(missed.map((e) => e.agentId))]).map((a) => [a.id, a]),
      );
      for (const event of missed) {
        const agent = snapshot.get(event.agentId);
        res.write(formatSse({ event, agents: agent ? [agent] : [], tasks: [] }));
      }
    }
    hub.add(res, f.demo);
  });

  return router;
}
