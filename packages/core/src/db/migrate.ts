import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadConfig, resolveDatabaseUrl } from '../config';
import { openDatabase } from './index';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const migrationsFolder = resolve(here, '../../drizzle');

const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { databaseUrl, databaseAuthToken } = loadConfig(process.env, { requireSecrets: false });
const url = resolveDatabaseUrl(databaseUrl, repoRoot);
const { db, close } = openDatabase(url, databaseAuthToken);
try {
  await migrate(db, { migrationsFolder });
  console.log(`[db] migrations applied to ${url.startsWith('file:') ? url : url.replace(/\/\/.*@/, '//')}`);
} finally {
  close();
}
