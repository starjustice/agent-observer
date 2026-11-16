import type { Agent } from "@ao/shared";

/**
 * One node on the map: a lead agent (a tower) or a subagent (a small pillar).
 * x and z are absolute, with the whole map centred on 0,0.
 */
export interface NodeSpot {
  agent: Agent;
  kind: "lead" | "sub";
  x: number;
  z: number;
  /** Hops from the lead: 0 for the lead, 1 for its direct subagents, and so on. */
  depth: number;
  /** The node that started this one, when it is on the map. */
  parent: { x: number; z: number; agent: Agent } | null;
}

/** One session on an island: a lead and everything it started. */
export interface Team {
  x: number;
  z: number;
  /** Radius of the circle that holds the lead and its subagents. */
  r: number;
  lead: NodeSpot;
  subs: NodeSpot[];
}

/** One project on one device, drawn as its own floating island. */
export interface Island {
  key: string;
  label: string;
  device: string;
  /** Project colour as hex. Stable for a project, and different between islands on screen. */
  color: string;
  x: number;
  z: number;
  radius: number;
  teams: Team[];
}

export interface IslandLayout {
  islands: Island[];
  nodes: NodeSpot[];
  /** Half the map's extent, used to frame the camera. */
  radius: number;
  /** Agents left off the map (ended, or over the cap). */
  hidden: number;
}

export const MAX_NODES = 60;
/** An ended agent stays on the map this long, so you can see it leave. */
const ENDED_LINGER_MS = 60_000;

const ISLAND_GAP = 3;
const ISLAND_PAD = 0.8;
const TEAM_GAP = 0.9;
const MIN_ISLAND = 2.4;

/** Kept apart from the status colours (violet, orange, red) on purpose. */
export const PROJECT_COLORS = [
  "#38bdf8",
  "#34d399",
  "#f472b6",
  "#facc15",
  "#6b8cff",
  "#2dd4bf",
  "#a3e635",
  "#e879f9",
] as const;

/** Oldest first, so a node keeps its place while its agent works. */
const bySeat = (a: Agent, b: Agent) => a.firstSeenAt - b.firstSeenAt || a.id.localeCompare(b.id);

function hashOf(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0;
  return h;
}

interface Local {
  agent: Agent;
  x: number;
  z: number;
  depth: number;
}

/** Places a lead at 0,0 with its subagents on rings around it. */
function layoutTeam(lead: Agent, members: Agent[], byId: Map<string, Agent>): { nodes: Local[]; r: number } {
  const depthOf = (agent: Agent): number => {
    let current = agent;
    for (let hops = 1; hops <= 9; hops += 1) {
      const parent = current.parentAgentId ? byId.get(current.parentAgentId) : undefined;
      if (!parent) return 1;
      if (parent.id === lead.id) return hops;
      current = parent;
    }
    return 1;
  };

  const ordered = members
    .map((agent) => ({ agent, depth: depthOf(agent) }))
    .sort((a, b) => a.depth - b.depth || bySeat(a.agent, b.agent));

  const pos = new Map<string, { x: number; z: number }>([[lead.id, { x: 0, z: 0 }]]);
  const nodes: Local[] = [{ agent: lead, x: 0, z: 0, depth: 0 }];

  const direct = ordered.filter((m) => m.depth === 1);
  const ringR = 1.3 + 0.25 * direct.length;
  direct.forEach((m, i) => {
    const angle = -Math.PI / 4 + (2 * Math.PI * i) / Math.max(1, direct.length);
    const at = { x: Math.cos(angle) * ringR, z: Math.sin(angle) * ringR };
    pos.set(m.agent.id, at);
    nodes.push({ agent: m.agent, ...at, depth: 1 });
  });

  // Deeper subagents fan out beyond the one that started them.
  const deeper = ordered.filter((m) => m.depth > 1);
  const byParent = new Map<string, typeof deeper>();
  for (const m of deeper) {
    const key = m.agent.parentAgentId ?? lead.id;
    byParent.set(key, [...(byParent.get(key) ?? []), m]);
  }
  for (let depth = 2; depth <= 9; depth += 1) {
    for (const [parentId, group] of byParent) {
      const children = group.filter((m) => m.depth === depth);
      if (children.length === 0) continue;
      const from = pos.get(parentId) ?? { x: 0, z: 0 };
      const base = Math.atan2(from.z, from.x);
      children.forEach((m, i) => {
        const spread = (i - (children.length - 1) / 2) * 0.8;
        const at = { x: from.x + Math.cos(base + spread) * 1.2, z: from.z + Math.sin(base + spread) * 1.2 };
        pos.set(m.agent.id, at);
        nodes.push({ agent: m.agent, ...at, depth });
      });
    }
  }

  const reach = nodes.reduce((max, n) => Math.max(max, Math.hypot(n.x, n.z)), 0);
  return { nodes, r: Math.max(1.1, reach + 0.65) };
}

export function layoutIslands(agents: Agent[], hubNow: number | null): IslandLayout {
  const present = agents.filter(
    (a) => a.status !== "ended" || (hubNow !== null && hubNow - a.lastEventAt < ENDED_LINGER_MS),
  );
  const shown = [...present].sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, MAX_NODES);
  const byId = new Map(shown.map((a) => [a.id, a]));

  /** The top agent of a chain of subagents, as far as it is on the map. */
  const rootOf = (agent: Agent): Agent => {
    let current = agent;
    for (let hops = 0; hops < 8; hops += 1) {
      const parent = current.parentAgentId ? byId.get(current.parentAgentId) : undefined;
      if (!parent || parent.id === current.id) break;
      current = parent;
    }
    return current;
  };

  const groups = new Map<string, { label: string; device: string; units: Map<string, Agent[]> }>();
  for (const agent of [...shown].sort(bySeat)) {
    const key = `${agent.deviceId}|${agent.projectId ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { label: agent.projectName ?? "No project", device: agent.deviceName, units: new Map() };
      groups.set(key, group);
    }
    const root = rootOf(agent);
    const unit = group.units.get(root.id) ?? [];
    if (agent.id !== root.id) unit.push(agent);
    group.units.set(root.id, unit);
  }

  // Colours: start from a hash of the project so it stays put, step on if taken.
  const keys = [...groups.keys()].sort();
  const colorOf = new Map<string, string>();
  const taken = new Set<number>();
  for (const key of keys) {
    let slot = hashOf(key) % PROJECT_COLORS.length;
    for (let tries = 0; tries < PROJECT_COLORS.length && taken.has(slot); tries += 1) {
      slot = (slot + 1) % PROJECT_COLORS.length;
    }
    taken.add(slot);
    colorOf.set(key, PROJECT_COLORS[slot]);
  }

  // Lay each island out on its own, centred on 0,0.
  interface LocalIsland {
    key: string;
    label: string;
    device: string;
    color: string;
    radius: number;
    teams: { x: number; z: number; r: number; nodes: Local[]; lead: Agent }[];
  }
  const local: LocalIsland[] = keys.map((key) => {
    const group = groups.get(key)!;
    const teams = [...group.units.entries()]
      .map(([rootId, subs]) => {
        const lead = byId.get(rootId)!;
        return { lead, ...layoutTeam(lead, subs, byId) };
      })
      .sort((a, b) => bySeat(a.lead, b.lead))
      .map((t) => ({ ...t, x: 0, z: 0 }));

    // Shelves of teams, left to right, wrapping near a square.
    const area = teams.reduce((sum, t) => sum + (2 * t.r + TEAM_GAP) ** 2, 0);
    const wrapAt = Math.max(5, Math.sqrt(area) * 1.1);
    let cursorX = 0;
    let rowZ = 0;
    let rowDepth = 0;
    for (const team of teams) {
      const w = 2 * team.r;
      if (cursorX > 0 && cursorX + w > wrapAt) {
        cursorX = 0;
        rowZ += rowDepth + TEAM_GAP;
        rowDepth = 0;
      }
      team.x = cursorX + team.r;
      team.z = rowZ + team.r;
      cursorX += w + TEAM_GAP;
      rowDepth = Math.max(rowDepth, w);
    }
    const minX = Math.min(...teams.map((t) => t.x - t.r));
    const maxX = Math.max(...teams.map((t) => t.x + t.r));
    const minZ = Math.min(...teams.map((t) => t.z - t.r));
    const maxZ = Math.max(...teams.map((t) => t.z + t.r));
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    for (const t of teams) {
      t.x -= cx;
      t.z -= cz;
    }
    const reach = teams.reduce((max, t) => Math.max(max, Math.hypot(t.x, t.z) + t.r), 0);
    return {
      key,
      label: group.label,
      device: group.device,
      color: colorOf.get(key)!,
      radius: Math.max(MIN_ISLAND, reach + ISLAND_PAD),
      teams,
    };
  });

  // Put the islands on shelves with a wide gap, so projects read as separate places.
  const area = local.reduce((sum, i) => sum + (2 * i.radius + ISLAND_GAP) ** 2, 0);
  const wrapAt = Math.max(14, Math.sqrt(area) * 1.3);
  const placed: { island: LocalIsland; x: number; z: number }[] = [];
  let x = 0;
  let z = 0;
  let shelf = 0;
  let maxX = 0;
  for (const island of local) {
    const w = 2 * island.radius;
    if (x > 0 && x + w > wrapAt) {
      x = 0;
      z += shelf + ISLAND_GAP;
      shelf = 0;
    }
    placed.push({ island, x: x + island.radius, z: z + island.radius });
    x += w + ISLAND_GAP;
    maxX = Math.max(maxX, x - ISLAND_GAP);
    shelf = Math.max(shelf, w);
  }
  const maxZ = z + shelf;
  const ox = maxX / 2;
  const oz = maxZ / 2;

  const islands: Island[] = [];
  const nodes: NodeSpot[] = [];
  for (const { island, x: ix, z: iz } of placed) {
    const centre = { x: ix - ox, z: iz - oz };
    const teams: Team[] = island.teams.map((t) => {
      const spots = new Map<string, NodeSpot>();
      for (const n of t.nodes) {
        spots.set(n.agent.id, {
          agent: n.agent,
          kind: n.depth === 0 ? "lead" : "sub",
          x: centre.x + t.x + n.x,
          z: centre.z + t.z + n.z,
          depth: n.depth,
          parent: null,
        });
      }
      for (const spot of spots.values()) {
        if (spot.depth === 0) continue;
        const parent = (spot.agent.parentAgentId && spots.get(spot.agent.parentAgentId)) || spots.get(t.lead.id);
        if (parent && parent !== spot) spot.parent = { x: parent.x, z: parent.z, agent: parent.agent };
      }
      const all = [...spots.values()];
      nodes.push(...all);
      return {
        x: centre.x + t.x,
        z: centre.z + t.z,
        r: t.r,
        lead: spots.get(t.lead.id)!,
        subs: all.filter((s) => s.depth > 0),
      };
    });
    islands.push({
      key: island.key,
      label: island.label,
      device: island.device,
      color: island.color,
      x: centre.x,
      z: centre.z,
      radius: island.radius,
      teams,
    });
  }

  const extent = islands.reduce((max, i) => Math.max(max, Math.hypot(i.x, i.z) + i.radius), 0);
  return {
    islands,
    nodes,
    radius: Math.max(5, extent),
    hidden: agents.length - shown.length,
  };
}

/** The chip on an island banner: tells a lone agent from an orchestrated session at a glance. */
export function islandSummary(island: Island): string {
  if (island.teams.length === 1) {
    const subs = island.teams[0].subs.length;
    return subs === 0 ? "Solo" : `Lead + ${subs} subagent${subs === 1 ? "" : "s"}`;
  }
  const subs = island.teams.reduce((n, t) => n + t.subs.length, 0);
  return `${island.teams.length} sessions${subs > 0 ? ` · ${subs} subagent${subs === 1 ? "" : "s"}` : ""}`;
}
