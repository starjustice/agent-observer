/**
 * On a self-run server, delete expired events now and every 6 hours.
 * On Vercel there is no long-running process, so Vercel Cron calls
 * /api/cron/cleanup instead (see vercel.json).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL) return;
  const { deleteExpiredEvents, getConfig, getDb } = await import("@ao/core");
  const run = async () => {
    try {
      const config = getConfig();
      const removed = await deleteExpiredEvents(
        getDb(config.databaseUrl, config.databaseAuthToken),
        config.retentionDays,
        Date.now(),
      );
      if (removed > 0) console.log(`[cleanup] removed ${removed} events older than ${config.retentionDays} days`);
    } catch (error) {
      console.error("[cleanup] failed:", error instanceof Error ? error.message : "unknown error");
    }
  };
  void run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}
