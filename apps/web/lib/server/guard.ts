/**
 * Cheap abuse guards for the public ingest endpoint.
 *
 * - INGEST_ALLOWED_IPS: optional comma-separated list of client IPs. When set,
 *   every other address gets a 403 before the token is even checked.
 * - INGEST_RATE_LIMIT: max requests per client IP per minute (default 600,
 *   0 disables). Counted in memory, so on serverless it is per warm instance:
 *   it blunts floods and brute-forcing but is not a hard global limit. Use the
 *   Vercel Firewall for that.
 */

const WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; reset: number }>();

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (
    request.headers.get("x-real-ip") ??
    fwd?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** Returns a Response to send back when the request must be refused, else null. */
export function guardIngest(request: Request): Response | null {
  const ip = clientIp(request);

  const allowed = (process.env.INGEST_ALLOWED_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(ip)) return new Response(null, { status: 403 });

  const limit = Number(process.env.INGEST_RATE_LIMIT ?? 600);
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const now = Date.now();
  if (hits.size > 5_000) {
    for (const [key, v] of hits) if (v.reset <= now) hits.delete(key);
  }
  const entry = hits.get(ip);
  if (!entry || entry.reset <= now) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return null;
  }
  entry.count += 1;
  if (entry.count > limit) {
    const retry = Math.max(1, Math.ceil((entry.reset - now) / 1000));
    return new Response(null, { status: 429, headers: { "Retry-After": String(retry) } });
  }
  return null;
}
