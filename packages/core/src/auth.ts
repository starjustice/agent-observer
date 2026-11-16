import { SESSION_COOKIE, SESSION_TTL_MS } from '@ao/shared';
import { createSessionValue, safeEqual, sessionSecret, verifySessionValue } from '@ao/shared/session';
import type { Config } from './config';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Ingestion: bearer token only. Checked before the body is read. */
export function checkIngestToken(config: Config, req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token !== '' && safeEqual(token, config.ingestToken);
}

/** Cron: bearer token only. With no CRON_SECRET set the route stays closed. */
export function checkCronSecret(config: Config, req: Request): boolean {
  if (!config.cronSecret) return false;
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token !== '' && safeEqual(token, config.cronSecret);
}

/** Dashboard and read API: signed viewer cookie only. The ingest token never works here. */
export function checkViewer(config: Config, req: Request, now: number = Date.now()): boolean {
  const secret = sessionSecret(config.sessionSecretEnv);
  return verifySessionValue(readCookie(req, SESSION_COOKIE), secret, now);
}

/**
 * The browser's address, as set by the platform in front of us (Vercel sets
 * x-forwarded-for; locally there is no proxy, so everyone shares one key).
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
}

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

/** In memory, so on a serverless host the count is per running instance. */
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

const cookieAttrs = (secure: boolean) => `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export async function login(
  config: Config,
  limiter: LoginLimiter,
  req: Request,
  now: number,
  secure: boolean,
): Promise<Response> {
  const key = clientKey(req);
  const wait = limiter.retryAfterMs(key, now);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    return Response.json(
      { error: 'too_many_attempts', retryAfterSeconds: seconds },
      { status: 429, headers: { 'Retry-After': String(seconds) } },
    );
  }
  const body: unknown = await req.json().catch(() => null);
  const password =
    body && typeof body === 'object' && typeof (body as { password?: unknown }).password === 'string'
      ? (body as { password: string }).password
      : '';
  if (!password || password.length > 512 || !safeEqual(password, config.viewerPassword)) {
    limiter.recordFailure(key, now);
    return Response.json({ error: 'wrong_password' }, { status: 401 });
  }
  limiter.reset(key);
  const value = createSessionValue(sessionSecret(config.sessionSecretEnv), now);
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': `${SESSION_COOKIE}=${value}; ${cookieAttrs(secure)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` },
  });
}

export function logout(secure: boolean): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(secure)}; Max-Age=0` },
  });
}
