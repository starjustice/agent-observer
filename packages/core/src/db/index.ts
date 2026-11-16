import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema';

export type Db = LibSQLDatabase<typeof schema>;

/**
 * Opens the database. `url` is `libsql://...` (Turso) or `file:...` (local).
 * Schema changes are applied by `pnpm db:migrate`, never while serving requests.
 */
export function openDatabase(url: string, authToken?: string): { db: Db; close: () => void } {
  const client = createClient({ url, ...(authToken ? { authToken } : {}) });
  const db = drizzle(client, { schema });
  return { db, close: () => client.close() };
}

let shared: { url: string; db: Db } | null = null;

/** One connection per server instance, reused across requests. */
export function getDb(url: string, authToken?: string): Db {
  if (!shared || shared.url !== url) shared = { url, db: openDatabase(url, authToken).db };
  return shared.db;
}

export { schema };
