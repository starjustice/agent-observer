import { lt } from 'drizzle-orm';
import type { Db } from './db';
import { events } from './db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes events older than the retention setting. Returns how many were removed. */
export function deleteExpiredEvents(db: Db, retentionDays: number, now: number): number {
  const cutoff = now - retentionDays * DAY_MS;
  return db.delete(events).where(lt(events.receivedAt, cutoff)).run().changes;
}

export function startCleanupJob(db: Db, retentionDays: number, intervalMs = 6 * 60 * 60 * 1000) {
  const run = () => {
    try {
      const removed = deleteExpiredEvents(db, retentionDays, Date.now());
      if (removed > 0) console.log(`[cleanup] removed ${removed} events older than ${retentionDays} days`);
    } catch (error) {
      console.error('[cleanup] failed:', error instanceof Error ? error.message : 'unknown error');
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
