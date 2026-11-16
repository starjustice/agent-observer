"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { LogOut } from "lucide-react";
import type { Agent, AgentStatus, StoredEvent } from "@ao/shared";
import { EventText } from "@/components/event-text";
import { IslandView } from "@/components/islands/island-view";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ago, clock, isStale, providerName } from "@/lib/format";
import { hardNavigate } from "@/lib/nav";
import { useLive, type Connection } from "@/lib/use-live";

const ALL = "all";
type View = "map" | "list";

const STATUS_STYLE: Record<AgentStatus, { dot: string; text: string }> = {
  starting: { dot: "bg-violet/60", text: "text-violet" },
  working: { dot: "bg-violet", text: "text-violet" },
  waiting: { dot: "bg-orange", text: "text-orange" },
  idle: { dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
  completed: { dot: "bg-foreground/50", text: "text-foreground/80" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  ended: { dot: "bg-muted-foreground/30", text: "text-muted-foreground" },
  unknown: { dot: "border border-muted-foreground/60", text: "text-muted-foreground" },
};

const CONNECTION_LABEL: Record<Connection, string> = {
  loading: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  error: "Hub not reachable. Retrying…",
};

// A shared ticking clock. It has no value during prerender, so the server
// never bakes a timestamp into the page.
let tick = 0;
const subscribeClock = (onChange: () => void) => {
  tick = Date.now();
  const t = setInterval(() => {
    tick = Date.now();
    onChange();
  }, 10_000);
  return () => clearInterval(t);
};
const useNow = (): number | null =>
  useSyncExternalStore(
    subscribeClock,
    () => tick || null,
    () => null,
  );

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  hardNavigate("/login");
}

export function Dashboard({ demo }: { demo: boolean }) {
  const { agents, events, devices, connection, clockOffsetMs } = useLive(demo);
  const [device, setDevice] = useState<string>(ALL);
  const [view, setView] = useState<View>("map");
  const now = useNow();
  const hubNow = now === null ? null : now + clockOffsetMs;

  const shownAgents = useMemo(
    () =>
      agents
        .filter((a) => device === ALL || a.deviceId === device)
        .sort((a, b) => b.lastEventAt - a.lastEventAt),
    [agents, device],
  );
  const shownEvents = useMemo(
    () => events.filter((e) => device === ALL || e.deviceId === device),
    [events, device],
  );
  const count = (status: AgentStatus) => shownAgents.filter((a) => a.status === status).length;
  const deviceItems = [
    { value: ALL, label: "All devices" },
    ...devices.map((d) => ({ value: d.id, label: d.name })),
  ];
  const loaded = connection !== "loading" && connection !== "error";
  const emptyText = loaded
    ? demo
      ? "No demo agents yet. Run pnpm simulate on the hub."
      : "No agents seen yet. They appear here once a hooked Claude Code session sends its first event."
    : "Loading…";
  const deviceFilter = (
    <Select items={deviceItems} value={device} onValueChange={(v) => setDevice(v ?? ALL)}>
      <SelectTrigger size="sm" aria-label="Filter by device">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        {deviceItems.map((d) => (
          <SelectItem key={d.value} value={d.value}>
            {d.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 lg:h-dvh lg:flex-none lg:p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <span className="size-2 rounded-full bg-violet" aria-hidden />
          Agent Observatory
        </h1>
        <span
          role="status"
          className={`flex items-center gap-1.5 text-xs ${
            connection === "live" ? "text-muted-foreground" : "text-orange"
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${connection === "live" ? "bg-violet" : "bg-orange"}`}
          />
          {CONNECTION_LABEL[connection]}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <div role="group" aria-label="View" className="mr-1 flex rounded-lg border p-0.5">
            {(["map", "list"] as const).map((v) => (
              <Button
                key={v}
                variant={view === v ? "secondary" : "ghost"}
                size="xs"
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === "map" ? "3D" : "List"}
              </Button>
            ))}
          </div>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={demo ? "/" : "/demo"} />}>
            {demo ? "Exit demo" : "Demo"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </header>

      {demo ? (
        <p className="rounded-lg border border-orange/40 bg-orange/10 px-3 py-2 text-sm text-orange">
          <strong className="font-semibold">DEMO mode.</strong> Everything below is simulated. Real
          agents are not shown here.
        </p>
      ) : null}

      <section aria-label="Agent counts" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Count label="Total" value={shownAgents.length} wide />
        <Count label="Working" value={count("working")} tone="text-violet" />
        <Count label="Waiting" value={count("waiting")} tone="text-orange" />
        <Count label="Idle" value={count("idle")} />
        <Count label="Failed" value={count("failed")} tone="text-destructive" />
      </section>

      <div
        className={`grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 ${
          view === "map"
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
            : "lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]"
        }`}
      >
        {view === "map" ? (
          <section
            aria-labelledby="agents-h"
            className="flex min-h-0 flex-col rounded-xl border bg-card max-lg:h-[30rem]"
          >
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
              <h2 id="agents-h" className="text-sm font-medium">
                Projects
              </h2>
              {deviceFilter}
            </div>
            <IslandView
              agents={shownAgents}
              events={shownEvents}
              hubNow={hubNow}
              clockOffsetMs={clockOffsetMs}
              emptyText={emptyText}
            />
          </section>
        ) : (
          <section aria-labelledby="agents-h" className="flex min-h-0 flex-col rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
              <h2 id="agents-h" className="text-sm font-medium">
                Agents
              </h2>
              {deviceFilter}
            </div>
            {shownAgents.length === 0 ? (
              <Empty>{emptyText}</Empty>
            ) : (
              <ul className="min-h-0 flex-1 divide-y overflow-y-auto max-lg:max-h-[26rem]">
                {shownAgents.map((a) => (
                  <AgentRow key={a.id} agent={a} hubNow={hubNow} />
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="feed-h" className="flex min-h-0 flex-col rounded-xl border bg-card max-lg:max-h-[30rem]">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <h2 id="feed-h" className="text-sm font-medium">
              Live activity
            </h2>
            <span className="text-xs text-muted-foreground">Newest first</span>
          </div>
          {shownEvents.length === 0 ? (
            <Empty>{loaded ? "No activity yet." : "Loading…"}</Empty>
          ) : (
            <ol className="min-h-0 flex-1 divide-y overflow-y-auto">
              {shownEvents.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function Count({
  label,
  value,
  tone = "text-foreground",
  wide = false,
}: {
  label: string;
  value: number;
  tone?: string;
  wide?: boolean;
}) {
  return (
    <div className={`rounded-xl border bg-card px-4 py-3 ${wide ? "col-span-2 sm:col-span-1" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${value > 0 ? tone : "text-muted-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function DemoTag() {
  return (
    <span className="rounded border border-orange/50 px-1 text-[10px] font-semibold tracking-wide text-orange">
      DEMO
    </span>
  );
}

function AgentRow({ agent, hubNow }: { agent: Agent; hubNow: number | null }) {
  const style = STATUS_STYLE[agent.status];
  const stale = hubNow !== null && isStale(agent, hubNow);
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${style.dot}`} />
        <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
        {agent.isDemo ? <DemoTag /> : null}
        <span className={`ml-auto shrink-0 text-xs font-medium ${style.text}`}>{agent.status}</span>
        {stale ? (
          <span
            className="shrink-0 rounded border border-orange/50 px-1 text-[10px] font-medium text-orange"
            title="No events for over 5 minutes. The status above is the last one reported."
          >
            stale
          </span>
        ) : null}
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pl-4 text-xs text-muted-foreground">
        <dt>Device</dt>
        <dd className="truncate text-foreground/80">{agent.deviceName}</dd>
        <dt>Project</dt>
        <dd className="truncate text-foreground/80">{agent.projectName ?? "unknown"}</dd>
        <dt>Provider</dt>
        <dd className="truncate text-foreground/80">{providerName(agent.providerId)}</dd>
        <dt>Model</dt>
        <dd className="truncate font-mono text-foreground/80">{agent.model ?? "unknown"}</dd>
        <dt>Tool</dt>
        <dd className="truncate font-mono text-foreground/80">{agent.currentTool ?? "none"}</dd>
        <dt>Last activity</dt>
        <dd className="text-foreground/80">{hubNow === null ? "…" : ago(hubNow - agent.lastEventAt)}</dd>
      </dl>
    </li>
  );
}

function EventRow({ event }: { event: StoredEvent }) {
  const failed = event.outcome === "failure";
  const waiting = event.eventType === "permission_requested";
  return (
    <li className="flex gap-3 px-4 py-2.5 text-sm">
      <time
        dateTime={new Date(event.receivedAt).toISOString()}
        className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground tabular-nums"
      >
        {clock(event.receivedAt)}
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={failed ? "text-destructive" : waiting ? "text-orange" : undefined}>
            {event.summary}
          </span>
          {event.isDemo ? <DemoTag /> : null}
        </div>
        {event.text ? <EventText event={event} /> : null}
        <div className="truncate text-xs text-muted-foreground">
          {event.agentName} · {event.deviceName}
          {event.projectName ? ` · ${event.projectName}` : ""}
          {event.filePath ? <span className="font-mono"> · {event.filePath}</span> : null}
        </div>
      </div>
    </li>
  );
}
