"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "lucide-react";
import type { Agent, StoredEvent } from "@ao/shared";
import { EventText } from "@/components/event-text";
import { Button } from "@/components/ui/button";
import { ago, clock, isStale, providerName } from "@/lib/format";
import { layoutIslands } from "@/lib/island-layout";

// WebGL only exists in the browser, and three.js is large: load it on demand.
const IslandScene = dynamic(() => import("./island-scene"), {
  ssr: false,
  loading: () => <p className="px-4 py-10 text-center text-sm text-muted-foreground">Loading 3D view…</p>,
});

const LEGEND = [
  { label: "Working", dot: "bg-violet" },
  { label: "Waiting for you", dot: "bg-orange" },
  { label: "Idle", dot: "bg-muted-foreground/60" },
  { label: "Failed", dot: "bg-destructive" },
];

const SHAPES = [
  { label: "Tall tower = lead agent", shape: "h-3 w-1.5 rounded-sm" },
  { label: "Small pillar = subagent", shape: "h-2 w-1.5 rounded-sm" },
  { label: "Person = agent, runs to its tool", shape: "size-2 rounded-full" },
  { label: "Beam = delegation", shape: "h-px w-3 border-t border-dashed" },
  { label: "Island = project", shape: "size-2.5 rotate-45 rounded-[2px]" },
];

const STATIONS = [
  { label: "Library = reading", shape: "h-1.5 w-2.5 rounded-[1px]" },
  { label: "Workbench = editing", shape: "h-1.5 w-2.5 rounded-[1px]" },
  { label: "Terminal = commands", shape: "h-1.5 w-2.5 rounded-[1px]" },
  { label: "Antenna = web", shape: "h-1.5 w-2.5 rounded-[1px]" },
];

export function IslandView({
  agents,
  events,
  hubNow,
  clockOffsetMs,
  emptyText,
}: {
  agents: Agent[];
  events: StoredEvent[];
  hubNow: number | null;
  clockOffsetMs: number;
  emptyText: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const layout = useMemo(() => layoutIslands(agents, hubNow), [agents, hubNow]);
  const selectedSpot = layout.nodes.find((n) => n.agent.id === selectedId) ?? null;
  const selected = selectedSpot?.agent ?? null;

  if (layout.nodes.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-muted-foreground">
        {agents.length > 0 ? "Every agent has ended. The list view still shows them." : emptyText}
      </p>
    );
  }

  const subagents = selected
    ? layout.nodes.filter((n) => n.parent?.agent.id === selected.id).map((n) => n.agent)
    : [];

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl" aria-label="3D map with one island per project">
      {/* Out of flow, so the canvas takes the panel's size and never sets it. */}
      <div className="absolute inset-0">
        <IslandScene
          layout={layout}
          events={events}
          hubNow={hubNow}
          clockOffsetMs={clockOffsetMs}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          resetKey={resetKey}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1 rounded-lg bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground">
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {SHAPES.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5">
                <span aria-hidden className={`inline-block bg-foreground/60 ${item.shape}`} />
                {item.label}
              </li>
            ))}
          </ul>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {LEGEND.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5">
                <span aria-hidden className={`size-2 rounded-full ${item.dot}`} />
                {item.label}
              </li>
            ))}
          </ul>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {STATIONS.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5">
                <span aria-hidden className={`inline-block bg-foreground/60 ${item.shape}`} />
                {item.label}
              </li>
            ))}
          </ul>
        </div>
        <div className="pointer-events-auto flex items-center gap-2 text-xs text-muted-foreground">
          {layout.hidden > 0 ? <span>{layout.hidden} more in the list view</span> : null}
          <Button variant="secondary" size="xs" onClick={() => setResetKey((k) => k + 1)}>
            Reset view
          </Button>
        </div>
      </div>

      {selected ? (
        <AgentPanel
          agent={selected}
          parent={selectedSpot?.parent?.agent ?? null}
          subagents={subagents}
          events={events.filter((e) => e.agentId === selected.id).slice(0, 6)}
          hubNow={hubNow}
          onClose={() => setSelectedId(null)}
        />
      ) : (
        <p className="pointer-events-none absolute top-3 left-3 z-30 rounded-lg bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground">
          Drag to rotate · Scroll to zoom · Click a project banner to zoom in · Click an agent
        </p>
      )}
    </div>
  );
}

function AgentPanel({
  agent,
  parent,
  subagents,
  events,
  hubNow,
  onClose,
}: {
  agent: Agent;
  parent: Agent | null;
  subagents: Agent[];
  events: StoredEvent[];
  hubNow: number | null;
  onClose: () => void;
}) {
  const stale = hubNow !== null && isStale(agent, hubNow);
  const rows: [string, string][] = [
    ["Status", stale ? `${agent.status} (stale)` : agent.status],
    ["Role", agent.role === "subagent" ? `Subagent${agent.agentType ? ` · ${agent.agentType}` : ""}` : "Lead agent"],
  ];
  if (agent.role === "subagent") {
    rows.push(["Reports to", parent ? parent.name : "unknown"]);
  } else {
    const working = subagents.filter((s) => s.status === "working").length;
    rows.push([
      "Subagents",
      subagents.length === 0 ? "none (working solo)" : `${subagents.length} (${working} working)`,
    ]);
  }
  rows.push(
    ["Device", agent.deviceName],
    ["Project", agent.projectName ?? "unknown"],
    ["Tool", agent.currentTool ?? "none"],
    ["Provider", providerName(agent.providerId)],
    ["Model", agent.model ?? "unknown"],
    ["Last activity", hubNow === null ? "…" : ago(hubNow - agent.lastEventAt)],
  );
  return (
    <aside
      aria-label={`Details for ${agent.name}`}
      className="absolute top-3 right-3 z-30 flex max-h-[calc(100%-4.5rem)] w-72 max-w-[calc(100%-1.5rem)] flex-col rounded-xl border bg-popover/95 text-sm shadow-lg"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">{agent.role === "main" ? "Lead agent" : agent.name}</h3>
        <Button variant="ghost" size="icon-xs" aria-label="Close details" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2.5 text-xs text-muted-foreground">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="truncate text-foreground/90">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="border-t px-3 py-2.5">
          <h4 className="text-xs text-muted-foreground">Recent activity</h4>
          {events.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">Nothing recent.</p>
          ) : (
            <ol className="mt-1 space-y-1.5">
              {events.map((e) => (
                <li key={e.id} className="text-xs">
                  <div className="flex gap-2">
                    <time className="shrink-0 font-mono text-muted-foreground tabular-nums">{clock(e.receivedAt)}</time>
                    <span className={e.outcome === "failure" ? "text-destructive" : "text-foreground/90"}>{e.summary}</span>
                  </div>
                  <EventText event={e} compact />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </aside>
  );
}
