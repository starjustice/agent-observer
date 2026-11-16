import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

const EnvSchema = z.object({
  BIND_ADDRESS: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  INGEST_TOKEN: z.string().min(16, 'INGEST_TOKEN must be at least 16 characters'),
  VIEWER_PASSWORD: z.string().min(8, 'VIEWER_PASSWORD must be at least 8 characters'),
  SESSION_SECRET: z.string().optional(),
  DATABASE_PATH: z.string().min(1).default('./data/observatory.db'),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  PROJECT_ROOTS: z.string().default(''),
  CAPTURE_DETAIL: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  INGEST_MAX_BODY_KB: z.coerce.number().int().min(1).max(20480).default(2048),
});

export interface Config {
  bindAddress: string;
  apiPort: number;
  ingestToken: string;
  viewerPassword: string;
  sessionSecretEnv: Record<string, string | undefined>;
  databasePath: string;
  retentionDays: number;
  extraRoots: string[];
  ingestMaxBodyBytes: number;
  /** Keep prompts and tool input (trimmed, secrets masked). Off = summaries only. */
  captureDetail: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings in .env as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration. Check your .env file:\n${problems}`);
  }
  const e = parsed.data;
  return {
    bindAddress: e.BIND_ADDRESS,
    apiPort: e.API_PORT,
    ingestToken: e.INGEST_TOKEN,
    viewerPassword: e.VIEWER_PASSWORD,
    sessionSecretEnv: { SESSION_SECRET: e.SESSION_SECRET, VIEWER_PASSWORD: e.VIEWER_PASSWORD },
    databasePath:
      e.DATABASE_PATH === ':memory:' || isAbsolute(e.DATABASE_PATH)
        ? e.DATABASE_PATH
        : resolve(REPO_ROOT, e.DATABASE_PATH),
    retentionDays: e.EVENT_RETENTION_DAYS,
    extraRoots: e.PROJECT_ROOTS.split(',').map((s) => s.trim()).filter(Boolean),
    ingestMaxBodyBytes: e.INGEST_MAX_BODY_KB * 1024,
    captureDetail: e.CAPTURE_DETAIL,
  };
}
