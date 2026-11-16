import { isIP } from 'node:net';
import express, { type Express } from 'express';
import type { Config } from './config';
import type { Db } from './db';
import { ingestRouter } from './routes/ingest';
import { readRouter } from './routes/read';
import type { SseHub } from './sse/hub';

export interface AppDeps {
  config: Config;
  db: Db;
  hub: SseHub;
  now: () => number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // The website proxies /api from this same machine, so only its own addresses
  // may pass on the browser's address (used for login rate limiting).
  const own = deps.config.bindAddress;
  app.set('trust proxy', isIP(own) && !/^(0\.0\.0\.0|::)$/.test(own) ? ['loopback', own] : 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Read-only by design: the only write paths are /ingest/* and login/logout.
  app.use('/ingest', ingestRouter(deps));
  app.use('/api', readRouter(deps));
  app.use((_req, res) => {
    res.status(404).end();
  });
  return app;
}
