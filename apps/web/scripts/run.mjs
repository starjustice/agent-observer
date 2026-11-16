// Starts the whole app (website + API) on the address and port from the repository's .env file.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webDir, '../..');
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const host = process.env.BIND_ADDRESS || '127.0.0.1';
const port = process.env.WEB_PORT || '4318';

for (const name of ['VIEWER_PASSWORD', 'INGEST_TOKEN']) {
  if (!process.env[name]) {
    console.error(`[web] ${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}
if (host === '0.0.0.0' || host === '::') {
  console.warn(
    '[web] WARNING: bound to every network interface. Set BIND_ADDRESS to this machine\'s private ' +
      '(Tailscale or home Wi-Fi) address instead.',
  );
}

// A relative local database path is relative to the repository, whatever folder Next runs in.
const dbUrl = process.env.DATABASE_URL || 'file:./data/observatory.db';
if (dbUrl.startsWith('file:') && !dbUrl.startsWith('file://')) {
  const path = dbUrl.slice('file:'.length);
  process.env.DATABASE_URL = path === ':memory:' || isAbsolute(path) ? dbUrl : `file:${resolve(repoRoot, path)}`;
}

// Bring the database up to date first. Safe to run every time.
const migrate = spawnSync('pnpm', ['--filter', '@ao/core', 'db:migrate'], { cwd: repoRoot, stdio: 'inherit', env: process.env });
if (migrate.status !== 0) {
  console.error('[web] database migration failed, not starting.');
  process.exit(migrate.status ?? 1);
}

const child = spawn('next', [mode, '-H', host, '-p', port], {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
