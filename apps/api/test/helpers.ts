import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { openDatabase, type Db } from '../src/db';
import { SseHub } from '../src/sse/hub';

export const TOKEN = 'test-ingest-token-0123456789';
export const PASSWORD = 'test-viewer-password';

export const testConfig: Config = {
  bindAddress: '127.0.0.1',
  apiPort: 0,
  ingestToken: TOKEN,
  viewerPassword: PASSWORD,
  sessionSecretEnv: { VIEWER_PASSWORD: PASSWORD },
  databasePath: ':memory:',
  retentionDays: 30,
  extraRoots: [],
  ingestMaxBodyBytes: 64 * 1024,
  captureDetail: false,
};

export interface TestHub {
  db: Db;
  hub: SseHub;
  url: string;
  clock: { now: number };
  ingest: (payload: unknown, headers?: Record<string, string>) => Promise<Response>;
  login: () => Promise<string>;
  stop: () => Promise<void>;
}

export async function startTestHub(over: Partial<Config> = {}): Promise<TestHub> {
  const { db, close } = openDatabase(':memory:');
  const hub = new SseHub();
  const clock = { now: 1_700_000_000_000 };
  const app = createApp({ config: { ...testConfig, ...over }, db, hub, now: () => clock.now });
  const server: Server = await new Promise((ok) => {
    const s = app.listen(0, '127.0.0.1', () => ok(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    hub,
    url,
    clock,
    ingest: (payload, headers = {}) =>
      fetch(`${url}/ingest/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'X-Device': 'laptop-a',
          ...headers,
        },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
    login: async () => {
      const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    },
    stop: async () => {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      close();
    },
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
