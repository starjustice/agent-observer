import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SESSION_COOKIE, SESSION_TTL_MS } from '@ao/shared';
import { createSessionValue, safeEqual, sessionSecret, verifySessionValue } from '@ao/shared/session';
import type { Config } from './config';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Ingestion: bearer token only. Checked before the body is read. */
export function requireIngestToken(config: Config): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, config.ingestToken)) {
      res.status(401).end();
      return;
    }
    next();
  };
}

/** Dashboard and read API: signed viewer cookie only. The ingest token never works here. */
export function requireViewer(config: Config, now: () => number = Date.now): RequestHandler {
  const secret = sessionSecret(config.sessionSecretEnv);
  return (req, res, next) => {
    if (!verifySessionValue(readCookie(req, SESSION_COOKIE), secret, now())) {
      res.status(401).end();
      return;
    }
    next();
  };
}

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  retryAfterMs(key: string, now: number): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    if (entry.resetAt <= now) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count >= MAX_FAILURES ? entry.resetAt - now : 0;
  }

  recordFailure(key: string, now: number): void {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count += 1;
    }
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export function loginHandler(config: Config, limiter: LoginLimiter, now: () => number) {
  const secret = sessionSecret(config.sessionSecretEnv);
  return (req: Request, res: Response, _next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const wait = limiter.retryAfterMs(key, now());
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil(wait / 1000) });
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || password.length > 512 || !safeEqual(password, config.viewerPassword)) {
      limiter.recordFailure(key, now());
      res.status(401).json({ error: 'wrong_password' });
      return;
    }
    limiter.reset(key);
    const value = createSessionValue(secret, now());
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
    res.status(204).end();
  };
}

export function logoutHandler(_req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.status(204).end();
}
