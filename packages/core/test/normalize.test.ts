import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { NormalizedAgentEventSchema } from '@ao/shared';
import { CLAUDE_HOOK_EVENTS, normalizeClaudeEvent } from '../src/collectors/claude';
import { filterFilePath } from '../src/ingest/paths';
import { SECRET, noisyToolPayload } from './helpers';

const base = { session_id: 's1', cwd: '/p/app' };

describe('Claude normalization', () => {
  it('handles exactly the 13 hook events', () => {
    expect(CLAUDE_HOOK_EVENTS).toHaveLength(13);
    for (const name of CLAUDE_HOOK_EVENTS) {
      const ev = normalizeClaudeEvent({ ...base, hook_event_name: name });
      expect(ev, name).not.toBeNull();
      expect(ev?.provider).toBe('claude-code');
      expect(ev?.summary.length).toBeGreaterThan(0);
    }
  });

  it('maps hook names to event types with template summaries', () => {
    const cases: [string, string, string][] = [
      ['SessionStart', 'session_start', 'Session started'],
      ['SessionEnd', 'session_end', 'Session ended'],
      ['UserPromptSubmit', 'prompt_submitted', 'Prompt submitted'],
      ['PreToolUse', 'tool_started', 'Bash tool started'],
      ['PostToolUse', 'tool_finished', 'Bash tool finished'],
      ['PostToolUseFailure', 'tool_failed', 'Bash tool failed'],
      ['PermissionRequest', 'permission_requested', 'Permission requested for Bash'],
      ['Stop', 'turn_ended', 'Turn ended'],
    ];
    for (const [hook, type, summary] of cases) {
      const ev = normalizeClaudeEvent({ ...base, hook_event_name: hook, tool_name: 'Bash' });
      expect(ev?.eventType).toBe(type);
      expect(ev?.summary).toBe(summary);
    }
  });

  it('marks subagent events with agent id, type and role', () => {
    const ev = normalizeClaudeEvent({
      ...base,
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'Explore',
    });
    expect(ev).toMatchObject({ agentId: 'a1', agentType: 'Explore', role: 'subagent' });
    expect(ev?.summary).toBe('Explore subagent started');
    expect(normalizeClaudeEvent({ ...base, hook_event_name: 'Stop' })?.role).toBe('main');
  });

  it('builds dedup keys from tool, prompt and task ids', () => {
    const pre = normalizeClaudeEvent({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 't1' });
    const post = normalizeClaudeEvent({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 't1' });
    expect(pre?.dedupKey).toBe('tool_started:t1');
    expect(post?.dedupKey).toBe('tool_finished:t1');
    expect(normalizeClaudeEvent({ ...base, hook_event_name: 'TaskCreated', task_id: 'k1' })?.dedupKey).toBe(
      'task_created:k1',
    );
  });

  it('returns null for hook events it does not handle', () => {
    expect(normalizeClaudeEvent({ ...base, hook_event_name: 'PreCompact' })).toBeNull();
  });
});

describe('Zod validation', () => {
  it('rejects payloads without a session id or event name', () => {
    expect(() => normalizeClaudeEvent({ hook_event_name: 'Stop' })).toThrow(ZodError);
    expect(() => normalizeClaudeEvent({ session_id: 's1' })).toThrow(ZodError);
    expect(() => normalizeClaudeEvent('not json')).toThrow(ZodError);
    expect(() => normalizeClaudeEvent(null)).toThrow(ZodError);
    expect(() => normalizeClaudeEvent({ session_id: 5, hook_event_name: 'Stop' })).toThrow(ZodError);
  });

  it('refuses unknown keys on the normalized event', () => {
    const ok = { provider: 'claude-code', eventType: 'turn_ended', sessionId: 's', summary: 'Turn ended' };
    expect(NormalizedAgentEventSchema.safeParse(ok).success).toBe(true);
    expect(NormalizedAgentEventSchema.safeParse({ ...ok, prompt: 'hi' }).success).toBe(false);
    expect(NormalizedAgentEventSchema.safeParse({ ...ok, toolInput: {} }).success).toBe(false);
    expect(NormalizedAgentEventSchema.safeParse({ ...ok, eventType: 'made_up' }).success).toBe(false);
  });
});

describe('sensitive-data filtering', () => {
  it('drops prompts, commands, tool input and output, transcripts and env', () => {
    const ev = normalizeClaudeEvent(noisyToolPayload());
    expect(JSON.stringify(ev)).not.toContain(SECRET);
    expect(Object.keys(ev ?? {}).sort()).toEqual(
      ['dedupKey', 'eventType', 'filePath', 'projectPath', 'provider', 'role', 'sessionId', 'summary', 'toolName', 'toolUseId'].sort(),
    );
  });

  it('never copies free text into detail codes', () => {
    const ev = normalizeClaudeEvent({
      ...base,
      hook_event_name: 'Notification',
      notification_type: `please run ${SECRET}`,
      message: SECRET,
      title: SECRET,
    });
    expect(ev?.detail).toBeUndefined();
    expect(ev?.summary).toBe('Notification');
  });

  it('keeps file paths only inside the project or a configured root', () => {
    expect(filterFilePath('/p/app/src/a.ts', '/p/app', [])).toBe('src/a.ts');
    expect(filterFilePath('/etc/passwd', '/p/app', [])).toBeNull();
    expect(filterFilePath('/p/app/../secret.txt', '/p/app', [])).toBeNull();
    expect(filterFilePath('/p/application/a.ts', '/p/app', [])).toBeNull();
    expect(filterFilePath('relative/a.ts', '/p/app', [])).toBeNull();
    expect(filterFilePath('/shared/lib/x.ts', '/p/app', ['/shared'])).toBe('/shared/lib/x.ts');
    expect(filterFilePath('/Users/me/.ssh/id_rsa', null, [])).toBeNull();
  });
});
