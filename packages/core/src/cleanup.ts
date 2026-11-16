import { lt } from 'drizzle-orm';
import type { Db } from './db';
import { events } from './db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes events older than the retention setting. Returns how many were removed. */
export async function deleteExpiredEvents(db: Db, retentionDays: number, now: number): Promise<number> {
  const cutoff = now - retentionDays * DAY_MS;
  const result = await db.delete(events).where(lt(events.receivedAt, cutoff));
  return result.rowsAffected;
}
