import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { startCleanupJob } from './cleanup';
import { loadConfig, REPO_ROOT } from './config';
import { openDatabase } from './db';
import { SseHub } from './sse/hub';

const envFile = resolve(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const { db, close } = openDatabase(config.databasePath);
const hub = new SseHub();
hub.startHeartbeat();
const stopCleanup = startCleanupJob(db, config.retentionDays);

const app = createApp({ config, db, hub, now: Date.now });
const server = app.listen(config.apiPort, config.bindAddress, () => {
  console.log(`[api] listening on http://${config.bindAddress}:${config.apiPort}`);
  console.log(`[api] database: ${config.databasePath}`);
  if (config.bindAddress === '0.0.0.0' || config.bindAddress === '::') {
    console.warn(
      '[api] WARNING: bound to every network interface. Anyone who can reach this machine can reach the hub. ' +
        'Set BIND_ADDRESS to the hub\'s private (Tailscale or home Wi-Fi) address instead.',
    );
  }
});
server.on('error', (error) => {
  console.error(`[api] could not start: ${error.message}`);
  process.exit(1);
});

const shutdown = () => {
  stopCleanup();
  hub.closeAll();
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
