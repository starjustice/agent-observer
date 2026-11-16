import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Config } from '../src/config';
import { openDatabase, type Db } from '../src/db';
import { createHandlers, type Handlers } from '../src/http/handlers';

export const TOKEN = 'test-ingest-token-0123456789';
export const PASSWORD = 'test-viewer-password';
export const CRON = 'test-cron-secret-0123456789';

export const testConfig: Config = {
  databaseUrl: 'file::memory:',
  databaseAuthToken: undefined,
  ingestToken: TOKEN,
  viewerPassword: PASSWORD,
  sessionSecretEnv: { VIEWER_PASSWORD: PASSWORD },
  cronSecret: CRON,
  retentionDays: 30,
  extraRoots: [],
  ingestMaxBodyBytes: 64 * 1024,
  captureDetail: false,
};

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

/**
 * A migrated, empty database in its own temp file. (An in-memory libSQL
 * database is dropped as soon as a transaction starts, so tests use a file.)
 */
export async function createTestDb(): Promise<{ db: Db; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'ao-test-'));
  const { db, close } = openDatabase(`file:${join(dir, 'test.db')}`);
  await migrate(db, { migrationsFolder });
  return {
    db,
    close: () => {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestHub {
  db: Db;
  handlers: Handlers;
  clock: { now: number };
  ingest: (payload: unknown, headers?: Record<string, string>, provider?: 'claude' | 'opencode') => Promise<Response>;
  /** Calls a read handler as a logged-in viewer. */
  get: (path: string, handler: (req: Request) => Promise<Response>, cookie?: string) => Promise<Response>;
  login: () => Promise<string>;
  stop: () => void;
}

export async function startTestHub(over: Partial<Config> = {}, deps: { pollMs?: number; maxStreamMs?: number } = {}): Promise<TestHub> {
  const { db, close } = await createTestDb();
  const clock = { now: 1_700_000_000_000 };
  const handlers = createHandlers({
    config: { ...testConfig, ...over },
    db,
    now: () => clock.now,
    secureCookies: false,
    ...deps,
  });
  const url = 'http://hub.test';
  return {
    db,
    handlers,
    clock,
    ingest: (payload, headers = {}, provider = 'claude') =>
      handlers.ingest(
        provider,
        new Request(`${url}/ingest/${provider}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
            'X-Device': 'laptop-a',
            ...headers,
          },
          body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        }),
      ),
    get: (path, handler, cookie) =>
      handler(new Request(`${url}${path}`, { headers: cookie ? { cookie } : {} })),
    login: async () => {
      const res = await handlers.login(
        new Request(`${url}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: PASSWORD }),
        }),
      );
      return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    },
    stop: close,
  };
}

/** A realistic PreToolUse payload stuffed with things that must never be stored. */
export const SECRET = 'SUPER-SECRET-CANARY-91f3';
export const noisyToolPayload = (over: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  transcript_path: `/Users/me/.claude/${SECRET}.jsonl`,
  cwd: '/Users/me/projects/shop',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_use_id: 'toolu_1',
  tool_input: {
    file_path: '/Users/me/projects/shop/src/cart.ts',
    old_string: `old ${SECRET}`,
    new_string: `new ${SECRET}`,
    command: `echo ${SECRET}`,
  },
  tool_response: { stdout: SECRET },
  prompt: `please ${SECRET}`,
  last_assistant_message: SECRET,
  env: { API_KEY: SECRET },
  ...over,
});
