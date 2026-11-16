// Starts Next.js on the address and port from the repository's .env file.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(webDir, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const host = process.env.BIND_ADDRESS || '127.0.0.1';
const port = process.env.WEB_PORT || '4318';

if (!process.env.VIEWER_PASSWORD) {
  console.error('[web] VIEWER_PASSWORD is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (host === '0.0.0.0' || host === '::') {
  console.warn(
    '[web] WARNING: bound to every network interface. Set BIND_ADDRESS to the hub\'s private ' +
      '(Tailscale or home Wi-Fi) address instead.',
  );
}

const child = spawn('next', [mode, '-H', host, '-p', port], {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
