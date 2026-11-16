import { z } from 'zod';
import {
  DEMO_HEADER,
  DEVICE_HEADER,
  DeviceNameSchema,
  MODEL_HEADER,
  MODEL_HEADER_PATTERN,
  SSE_HEARTBEAT_MS,
  SSE_REPLAY_LIMIT,
  type NormalizedAgentEvent,
  type StreamMessage,
} from '@ao/shared';
import { checkCronSecret, checkIngestToken, checkViewer, login, logout, LoginLimiter } from '../auth';
import { deleteExpiredEvents } from '../cleanup';
import { normalizeClaudeEvent } from '../collectors/claude';
import { normalizeOpencodeEvent } from '../collectors/opencode';
import type { Config } from '../config';
import type { Db } from '../db';
import { ingestEvent } from '../ingest/pipeline';
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
import { formatSse } from '../sse/format';

export interface HttpDeps {
  config: Config;
  db: Db;
  now: () => number;
  /** Mark the login cookie Secure. True on any https host. */
  secureCookies: boolean;
  /** How often the stream looks for new events. */
  pollMs?: number;
  /** After this long the stream asks the browser to reconnect (hosting time limit). */
  maxStreamMs?: number;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Adds the headers every response from this app carries. */
function finish(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}
const empty = (status: number) => finish(new Response(null, { status }));
const json = (body: unknown, status = 200) => finish(Response.json(body, { status }));

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

function parseFilter(req: Request): ListFilter | null {
  const query = Object.fromEntries(new URL(req.url).searchParams);
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
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((ok) => {
    if (signal.aborted) return ok();
    const t = setTimeout(ok, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), ok()), { once: true });
  });

export type Provider = 'claude' | 'opencode';

export function createHandlers(deps: HttpDeps) {
  const { config, db, now } = deps;
  const limiter = new LoginLimiter();
  const captureDetail = config.captureDetail;

  const normalizers: Record<Provider, (raw: unknown) => NormalizedAgentEvent | null> = {
    claude: (raw) => normalizeClaudeEvent(raw, { captureDetail }),
    opencode: (raw) => normalizeOpencodeEvent(raw, { captureDetail }),
  };

  /** Runs a read handler only for a logged-in viewer. */
  const viewer =
    (fn: (req: Request) => Promise<Response> | Response) =>
    async (req: Request): Promise<Response> => {
      if (!checkViewer(config, req, now())) return empty(401);
      return fn(req);
    };

  const list = <T>(fn: (f: ListFilter) => Promise<T>) =>
    viewer(async (req) => {
      const f = parseFilter(req);
      if (!f) return json({ error: 'invalid_query' }, 400);
      return json(await fn(f));
    });

  /**
   * Ingestion never returns a body. For Claude Code an empty 2xx means
   * "nothing to add": no decision, no context, no output.
   */
  const ingest = async (provider: Provider, req: Request): Promise<Response> => {
    if (!checkIngestToken(config, req)) return empty(401);
    const device = DeviceNameSchema.safeParse(req.headers.get(DEVICE_HEADER) ?? '');
    if (!device.success) return empty(400);
    const isDemo = ['1', 'true'].includes((req.headers.get(DEMO_HEADER) ?? '').toLowerCase());

    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > config.ingestMaxBodyBytes) return empty(413);
    const text = await req.text().catch(() => null);
    if (text === null) return empty(400);
    if (Buffer.byteLength(text) > config.ingestMaxBodyBytes) return empty(413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return empty(400);
    }

    let event: NormalizedAgentEvent | null;
    try {
      event = normalizers[provider](raw);
    } catch (error) {
      // Never log the payload: it may hold prompts or file contents.
      if (!(error instanceof z.ZodError)) console.error(`[ingest/${provider}] normalize failed`);
      return empty(400);
    }
    // From here on the raw body is no longer referenced anywhere.
    if (event) {
      // Claude Code hook payloads do not carry the model, so the sender may
      // name it in a header. It describes the main agent only.
      const headerModel = req.headers.get(MODEL_HEADER) ?? '';
      if (!event.model && event.role === 'main' && MODEL_HEADER_PATTERN.test(headerModel)) {
        event.model = headerModel;
      }
      try {
        await ingestEvent(db, event, {
          deviceName: device.data,
          isDemo,
          now: now(),
          extraRoots: config.extraRoots,
        });
      } catch (error) {
        console.error(`[ingest/${provider}] store failed:`, error instanceof Error ? error.message : 'unknown');
      }
    }
    return empty(204);
  };

  /** Agents a dashboard needs in order to show what one stored event changed. */
  const agentsFor = async (event: { agentId: string; eventType: string; sessionId: string; isDemo: boolean }) => {
    const own = await getAgentsByIds(db, [event.agentId]);
    const parents = own.flatMap((a) => (a.parentAgentId ? [a.parentAgentId] : []));
    const rest = parents.length ? await getAgentsByIds(db, parents) : [];
    const ended =
      event.eventType === 'session_end'
        ? await listAgents(db, { demo: event.isDemo, sessionId: event.sessionId, limit: 500 })
        : [];
    const byId = new Map([...own, ...rest, ...ended].map((a) => [a.id, a]));
    return [...byId.values()];
  };

  const stream = viewer(async (req) => {
    const f = parseFilter(req);
    if (!f) return empty(400);
    const pollMs = deps.pollMs ?? 1000;
    const maxMs = deps.maxStreamMs ?? 280_000;
    const encoder = new TextEncoder();
    const startedAt = Date.now();

    const lastHeader = Number(req.headers.get('last-event-id') ?? new URL(req.url).searchParams.get('lastEventId') ?? NaN);
    const resumeFrom = Number.isInteger(lastHeader) && lastHeader >= 0 ? lastHeader : null;

    let cursor: number;
    if (resumeFrom !== null) {
      cursor = resumeFrom;
    } else {
      // No replay point: deliver only what happens from now on.
      cursor = (await listEvents(db, { demo: f.demo, limit: 1 }))[0]?.id ?? 0;
    }
    let replaying = resumeFrom !== null;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (frame: string) => controller.enqueue(encoder.encode(frame));
        const abort = new AbortController();
        req.signal.addEventListener('abort', () => abort.abort(), { once: true });
        write('retry: 2000\n\n');
        let sinceHeartbeat = 0;
        try {
          while (!abort.signal.aborted) {
            // The first pass replays what the browser missed while disconnected.
            const batch = await listEvents(db, {
              demo: f.demo,
              after: cursor,
              limit: replaying ? SSE_REPLAY_LIMIT : 200,
            });
            replaying = false;
            for (const event of batch) {
              const message: StreamMessage = { event, agents: await agentsFor(event), tasks: [] };
              write(formatSse(message));
              cursor = event.id;
            }
            if (Date.now() - startedAt >= maxMs) {
              write('event: reconnect\ndata: {}\n\n');
              break;
            }
            if (batch.length === 0) {
              await sleep(pollMs, abort.signal);
              sinceHeartbeat += pollMs;
              if (sinceHeartbeat >= SSE_HEARTBEAT_MS) {
                write(': heartbeat\n\n');
                sinceHeartbeat = 0;
              }
            }
          }
        } catch (error) {
          console.error('[stream] stopped:', error instanceof Error ? error.message : 'unknown');
        } finally {
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        }
      },
    });
    return finish(
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      }),
    );
  });

  return {
    ingest,
    health: async () => json({ status: 'ok' }),
    login: async (req: Request) => finish(await login(config, limiter, req, now(), deps.secureCookies)),
    logout: async () => finish(logout(deps.secureCookies)),
    me: viewer(() => json({ authenticated: true })),
    overview: list((f) => getOverview(db, f.demo, now())),
    agents: list((f) => listAgents(db, f)),
    agent: (req: Request, agentId: string) =>
      viewer(async () => {
        const agent = await getAgent(db, agentId);
        if (!agent) return json({ error: 'not_found' }, 404);
        const children = (await listAgents(db, { demo: agent.isDemo, sessionId: agent.sessionId, limit: 500 })).filter(
          (a) => a.parentAgentId === agent.id,
        );
        return json({
          agent,
          parent: agent.parentAgentId ? await getAgent(db, agent.parentAgentId) : null,
          children,
          tasks: await listTasks(db, { demo: agent.isDemo, agentId: agent.id, limit: 100 }),
          recentEvents: await listEvents(db, { demo: agent.isDemo, agentId: agent.id, limit: 50 }),
        });
      })(req),
    sessions: list((f) => listSessions(db, f)),
    tasks: list((f) => listTasks(db, f)),
    events: list((f) => listEvents(db, f)),
    projects: list((f) => listProjects(db, f)),
    providers: viewer(async () => json(await listProviders(db))),
    stream,
    /** Called by Vercel Cron once a day. */
    cleanup: async (req: Request) => {
      if (!checkCronSecret(config, req)) return empty(401);
      const removed = await deleteExpiredEvents(db, config.retentionDays, now());
      return json({ removed });
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
