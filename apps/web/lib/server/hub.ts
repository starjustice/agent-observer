import { createHandlers, getConfig, getDb, type Handlers } from "@ao/core";

let handlers: Handlers | null = null;

/**
 * The hub's HTTP handlers, built once per server instance from the environment.
 * Every route file under app/api and app/ingest is a thin wrapper around this.
 */
export function hub(): Handlers {
  if (!handlers) {
    const config = getConfig();
    handlers = createHandlers({
      config,
      db: getDb(config.databaseUrl, config.databaseAuthToken),
      now: Date.now,
      // Vercel serves everything over https; local http must not get Secure cookies.
      secureCookies: Boolean(process.env.VERCEL),
    });
  }
  return handlers;
}
