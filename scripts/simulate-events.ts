/**
 * Sends fake Claude Code hook events to the hub (local by default; set AO_HUB_URL
 * to your Vercel address to try the deployed one).
 * Every request carries "X-Demo: 1", so the hub stores each record as DEMO
 * and shows it only on the /demo page, never mixed with real agents.
 *
 *   pnpm simulate            one scripted run (about 20 seconds)
 *   pnpm simulate --loop     keep going until Ctrl+C
 *   pnpm simulate --fast     no pauses (useful for tests)
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const host = process.env.BIND_ADDRESS || '127.0.0.1';
const port = process.env.WEB_PORT || '4318';
const token = process.env.INGEST_TOKEN;
const hubUrl = (process.env.AO_HUB_URL || `http://${host.includes(':') ? `[${host}]` : host}:${port}`).replace(/\/+$/, '');
const url = `${hubUrl}/ingest/claude`;
const loop = process.argv.includes('--loop');
const fast = process.argv.includes('--fast');

if (!token) {
  console.error('INGEST_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, fast ? 0 : ms));
let sent = 0;

async function send(device: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Device': device,
      'X-Demo': '1',
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 204) throw new Error(`hub answered ${res.status} for ${String(payload.hook_event_name)}`);
  sent += 1;
}

async function tool(
  device: string,
  base: Record<string, unknown>,
  name: string,
  file?: string,
  fail = false,
  extra: Record<string, unknown> = {},
) {
  const id = `toolu_demo_${randomUUID().slice(0, 8)}`;
  const input = { ...(file ? { file_path: `${String(base.cwd)}/${file}` } : {}), ...extra };
  await send(device, { ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input });
  await sleep(900);
  await send(device, {
    ...base,
    hook_event_name: fail ? 'PostToolUseFailure' : 'PostToolUse',
    tool_name: name,
    tool_use_id: id,
    tool_input: input,
  });
  await sleep(400);
}

async function laptopSession(): Promise<void> {
  const device = 'demo-laptop';
  const base = { session_id: `demo-${randomUUID()}`, cwd: '/demo/projects/web-shop' };
  await send(device, { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'demo-model' });
  await sleep(600);
  await send(device, {
    ...base,
    hook_event_name: 'UserPromptSubmit',
    prompt_id: randomUUID(),
    prompt: 'Fix the cart total so it includes shipping, then run the tests',
  });
  await tool(device, base, 'Read', 'src/cart.ts');
  await tool(device, base, 'Edit', 'src/cart.ts');
  await send(device, { ...base, hook_event_name: 'TaskCreated', task_id: 'demo-task-1' });

  const delegation = {
    subagent_type: 'Explore',
    description: 'Find shipping cost code',
    prompt: 'Find every place the cart total is computed and report which ones ignore shipping.',
  };
  const delegationId = `toolu_demo_${randomUUID().slice(0, 8)}`;
  await send(device, {
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: delegationId,
    tool_input: delegation,
  });
  const sub = { ...base, agent_id: `demo-agent-${randomUUID().slice(0, 8)}`, agent_type: 'Explore' };
  await send(device, { ...sub, hook_event_name: 'SubagentStart' });
  await tool(device, sub, 'Grep', undefined, false, { pattern: 'shippingCost', path: 'src/' });
  await tool(device, sub, 'Read', 'src/checkout.ts');
  await send(device, { ...sub, hook_event_name: 'SubagentStop' });
  await send(device, {
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_use_id: delegationId,
    tool_input: delegation,
  });

  await tool(device, base, 'Bash', undefined, true, { command: 'pnpm test --filter cart' });
  await send(device, {
    ...base,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test --filter cart -- --update-snapshots' },
  });
  await sleep(2500);
  await tool(device, base, 'Bash', undefined, false, { command: 'pnpm test --filter cart -- --update-snapshots' });
  await send(device, { ...base, hook_event_name: 'TaskCompleted', task_id: 'demo-task-1' });
  await send(device, { ...base, hook_event_name: 'Stop' });
  await sleep(1500);
  await send(device, { ...base, hook_event_name: 'SessionEnd', reason: 'other' });
}

async function desktopSession(): Promise<void> {
  const device = 'demo-desktop';
  const base = { session_id: `demo-${randomUUID()}`, cwd: '/demo/projects/data-pipeline' };
  await sleep(1200);
  await send(device, { ...base, hook_event_name: 'SessionStart', source: 'resume', model: 'demo-model' });
  await send(device, {
    ...base,
    hook_event_name: 'UserPromptSubmit',
    prompt_id: randomUUID(),
    prompt: 'Add a weekly job that mirrors the nightly one but only runs on Sundays',
  });
  await tool(device, base, 'Glob', undefined, false, { pattern: 'jobs/**/*.py' });
  await tool(device, base, 'Read', 'jobs/nightly.py');
  await tool(device, base, 'Write', 'jobs/weekly.py');
  await send(device, { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  await tool(device, base, 'Edit', 'jobs/weekly.py');
  // Left without a Stop or SessionEnd on purpose: this agent stays "working"
  // and turns "stale" after five quiet minutes.
}

try {
  do {
    await Promise.all([laptopSession(), desktopSession()]);
    console.log(`Sent ${sent} DEMO events to ${url}. Open the dashboard and choose "Demo".`);
    if (loop) await sleep(3000);
  } while (loop);
} catch (error) {
  console.error(`Simulation stopped: ${error instanceof Error ? error.message : error}`);
  console.error('Is the hub running? Start it with: pnpm dev');
  process.exit(1);
}
