import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_TTL_MS } from './constants';

/**
 * Viewer session cookie: "<expiryMs>.<hmac>". Stateless, so the API and the
 * website can both check it without sharing anything but the environment.
 */
export function sessionSecret(env: Record<string, string | undefined>): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  return createHash('sha256')
    .update(`agent-observatory:${env.VIEWER_PASSWORD ?? ''}`)
    .digest('hex');
}

function sign(expiry: string, secret: string): string {
  return createHmac('sha256', secret).update(expiry).digest('hex');
}

export function createSessionValue(secret: string, now = Date.now()): string {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry, secret)}`;
}

export function verifySessionValue(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expiry = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^\d{1,16}$/.test(expiry) || Number(expiry) < now) return false;
  return safeEqual(mac, sign(expiry, secret));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
