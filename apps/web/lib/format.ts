import { DEFAULT_STALE_AFTER_MS, LIVE_STATUSES, type Agent } from "@ao/shared";

export function isStale(agent: Agent, hubNow: number): boolean {
  return (
    (LIVE_STATUSES as readonly string[]).includes(agent.status) &&
    hubNow - agent.lastEventAt > DEFAULT_STALE_AFTER_MS
  );
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

/** Display name for a provider id. Unknown ids are shown as they are. */
export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}
