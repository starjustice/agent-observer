import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const secret = (min: number, label: string) => z.string().min(min, `${label} must be at least ${min} characters`);

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default('file:./data/observatory.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  INGEST_TOKEN: secret(16, 'INGEST_TOKEN'),
  VIEWER_PASSWORD: secret(8, 'VIEWER_PASSWORD'),
  SESSION_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  PROJECT_ROOTS: z.string().default(''),
  CAPTURE_DETAIL: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  INGEST_MAX_BODY_KB: z.coerce.number().int().min(1).max(20480).default(2048),
});

export interface Config {
  databaseUrl: string;
  databaseAuthToken: string | undefined;
  ingestToken: string;
  viewerPassword: string;
  sessionSecretEnv: Record<string, string | undefined>;
  /** Shared secret Vercel Cron sends as a bearer token. Unset = cron route is closed. */
  cronSecret: string | undefined;
  retentionDays: number;
  extraRoots: string[];
  ingestMaxBodyBytes: number;
  /** Keep prompts and tool input (trimmed, secrets masked). Off = summaries only. */
  captureDetail: boolean;
}

/** Relative `file:` URLs are resolved against `root` so every process finds the same file. */
export function resolveDatabaseUrl(url: string, root: string): string {
  if (!url.startsWith('file:')) return url;
  const path = url.slice('file:'.length);
  if (path === ':memory:' || path.startsWith('//') || isAbsolute(path)) return url;
  return `file:${resolve(root, path)}`;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { requireSecrets?: boolean } = {},
): Config {
  // Treat empty strings in .env as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  if (opts.requireSecrets === false) {
    cleaned.INGEST_TOKEN ??= 'x'.repeat(16);
    cleaned.VIEWER_PASSWORD ??= 'x'.repeat(8);
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration. Check your environment variables:\n${problems}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    databaseAuthToken: e.DATABASE_AUTH_TOKEN,
    ingestToken: e.INGEST_TOKEN,
    viewerPassword: e.VIEWER_PASSWORD,
    sessionSecretEnv: { SESSION_SECRET: e.SESSION_SECRET, VIEWER_PASSWORD: e.VIEWER_PASSWORD },
    cronSecret: e.CRON_SECRET,
    retentionDays: e.EVENT_RETENTION_DAYS,
    extraRoots: e.PROJECT_ROOTS.split(',').map((s) => s.trim()).filter(Boolean),
    ingestMaxBodyBytes: e.INGEST_MAX_BODY_KB * 1024,
    captureDetail: e.CAPTURE_DETAIL,
  };
}

let cached: Config | null = null;

/** Parsed once per server instance. Throws a readable error if the environment is wrong. */
export function getConfig(): Config {
  return (cached ??= loadConfig());
}
