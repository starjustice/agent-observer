import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeClaudeEvent } from '../src/collectors/claude';
import { normalizeOpencodeEvent } from '../src/collectors/opencode';
import { openDatabase, type Db } from '../src/db';
import { ingestEvent } from '../src/ingest/pipeline';
import { cleanText, redactSecrets } from '../src/ingest/redact';
import { listEvents } from '../src/queries';
import { SECRET, noisyToolPayload, startTestHub, type TestHub } from './helpers';

const base = { session_id: 's1', cwd: '/p/app' };
const on = { captureDetail: true };

describe('redactSecrets', () => {
  it.each([
    ['key sk-abcdefghijklmnopqrstuvwx used', 'sk-abcdefghijklmnopqrstuvwx'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123 end', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['aws AKIAABCDEFGHIJKLMNOP end', 'AKIAABCDEFGHIJKLMNOP'],
    ['slack xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['curl -H "Authorization: Bearer abc.def-ghi_jkl123456"', 'abc.def-ghi_jkl123456'],
    ['export PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['run --token s3cr3tvalue now', 's3cr3tvalue'],
    ['postgres://admin:p4ssw0rd@db:5432/x', 'p4ssw0rd'],
    ['hash 0123456789abcdef0123456789abcdef0123', '0123456789abcdef0123456789abcdef0123'],
  ])('masks %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('leaves ordinary commands alone', () => {
    expect(redactSecrets('pnpm test --filter api')).toBe('pnpm test --filter api');
    expect(redactSecrets('git commit -m "fix cart total"')).toBe('git commit -m "fix cart total"');
  });

  it('cleans, masks and caps text', () => {
    expect(cleanText('  \u0007hi\u0000there  ', 50)).toBe('hi there');
    expect(cleanText('', 50)).toBeUndefined();
    expect(cleanText('word '.repeat(100), 100)).toHaveLength(100);
    expect(cleanText('line one\nline two', 50)).toBe('line one\nline two');
  });
});

describe('Claude detail capture', () => {
  it('keeps the prompt and a shell command when capture is on', () => {
    const prompt = normalizeClaudeEvent({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'add retry to the client' }, on);
    expect(prompt?.text).toBe('add retry to the client');
    const bash = normalizeClaudeEvent(
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test --filter api' } },
      on,
    );
    expect(bash?.text).toBe('pnpm test --filter api');
  });

  it('stores nothing extra when capture is off or not asked for', () => {
    const payload = { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' };
    expect(normalizeClaudeEvent(payload)?.text).toBeUndefined();
    expect(normalizeClaudeEvent(payload, { captureDetail: false })?.text).toBeUndefined();
  });

  it('describes search, web and delegation input', () => {
    const run = (tool_name: string, tool_input: Record<string, unknown>) =>
      normalizeClaudeEvent({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input }, on)?.text;
    expect(run('Grep', { pattern: 'retryCount', path: 'src/' })).toBe('"retryCount" in src/');
    expect(run('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(run('WebFetch', { url: 'https://example.com/docs' })).toBe('https://example.com/docs');
    expect(run('WebSearch', { query: 'sqlite wal mode' })).toBe('sqlite wal mode');
    expect(run('Agent', { subagent_type: 'Explore', description: 'Find call sites', prompt: 'List all callers' })).toBe(
      'Explore: Find call sites\nList all callers',
    );
    expect(run('mcp__x__lookup', { query: 'orders', token: 'nope' })).toBe('query=orders');
  });

  it('adds no text for file tools, whose path is already stored', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit']) {
      const ev = normalizeClaudeEvent(
        { ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/p/app/a.ts', content: SECRET } },
        on,
      );
      expect(ev?.text, tool).toBeUndefined();
    }
  });

  it('puts text on the start of a tool and on a permission request, not on the finish', () => {
    const input = { command: 'ls' };
    const mk = (hook: string) =>
      normalizeClaudeEvent({ ...base, hook_event_name: hook, tool_name: 'Bash', tool_input: input }, on);
    expect(mk('PreToolUse')?.text).toBe('ls');
    expect(mk('PermissionRequest')?.text).toBe('ls');
    expect(mk('PostToolUse')?.text).toBeUndefined();
    expect(mk('PostToolUseFailure')?.text).toBeUndefined();
  });

  it('masks secrets and caps length', () => {
    const ev = normalizeClaudeEvent(
      { ...base, hook_event_name: 'UserPromptSubmit', prompt: `use sk-abcdefghijklmnopqrstuvwx ${'x '.repeat(2000)}` },
      on,
    );
    expect(ev?.text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(ev?.text).toContain('[redacted]');
    expect(ev?.text?.length).toBeLessThanOrEqual(1000);
  });

  it('still never reads output, replies, transcripts or env', () => {
    const ev = normalizeClaudeEvent(
      noisyToolPayload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
      on,
    );
    expect(JSON.stringify(ev)).not.toContain(SECRET);
    expect(ev?.text).toBe('echo hi');
    const stop = normalizeClaudeEvent(noisyToolPayload({ hook_event_name: 'Stop' }), on);
    expect(JSON.stringify(stop)).not.toContain(SECRET);
  });
});

describe('OpenCode detail capture', () => {
  const start = { session_id: 'ses_1', cwd: '/p/app', event: 'tool_start', tool: 'bash', input_text: 'npm run build' };
  it('keeps input_text only when capture is on', () => {
    expect(normalizeOpencodeEvent(start, on)?.text).toBe('npm run build');
    expect(normalizeOpencodeEvent(start)?.text).toBeUndefined();
  });
  it('masks secrets and ignores it on other events', () => {
    expect(normalizeOpencodeEvent({ ...start, input_text: 'deploy --token abcd1234efgh' }, on)?.text).not.toContain('abcd1234efgh');
    expect(normalizeOpencodeEvent({ ...start, event: 'tool_end', input_text: 'x' }, on)?.text).toBeUndefined();
  });
});

describe('storage and read API', () => {
  let db: Db;
  let close: () => void;
  beforeEach(() => {
    ({ db, close } = openDatabase(':memory:'));
  });
  afterEach(() => close());

  it('stores text next to the summary', () => {
    const ev = normalizeClaudeEvent(
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'make' } },
      on,
    )!;
    ingestEvent(db, ev, { deviceName: 'laptop-a', isDemo: false, now: 1000, extraRoots: [] });
    const [row] = listEvents(db, { demo: false, limit: 10 });
    expect(row).toMatchObject({ summary: 'Bash tool started', text: 'make' });
  });

  it('keeps text null when there is none', () => {
    const ev = normalizeClaudeEvent({ ...base, hook_event_name: 'Stop' }, on)!;
    ingestEvent(db, ev, { deviceName: 'laptop-a', isDemo: false, now: 1000, extraRoots: [] });
    expect(listEvents(db, { demo: false, limit: 10 })[0]?.text).toBeNull();
  });
});

describe('over HTTP', () => {
  let hub: TestHub | undefined;
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });
  const payload = {
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_http',
    tool_input: { command: 'echo http-visible' },
  };

  it('returns the command when CAPTURE_DETAIL is on', async () => {
    hub = await startTestHub({ captureDetail: true });
    expect((await hub.ingest(payload)).status).toBe(204);
    const cookie = await hub.login();
    const res = await fetch(`${hub.url}/api/events`, { headers: { cookie } });
    expect(JSON.stringify(await res.json())).toContain('echo http-visible');
  });

  it('stores nothing of it when CAPTURE_DETAIL is off', async () => {
    hub = await startTestHub({ captureDetail: false });
    expect((await hub.ingest(payload)).status).toBe(204);
    const cookie = await hub.login();
    const res = await fetch(`${hub.url}/api/events`, { headers: { cookie } });
    expect(JSON.stringify(await res.json())).not.toContain('http-visible');
  });
});
