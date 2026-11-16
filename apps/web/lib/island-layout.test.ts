import { describe, expect, it } from "vitest";
import type { Agent } from "@ao/shared";
import { STATION_KINDS, layoutIslands, stationForTool } from "./island-layout";

let nextId = 1;

function agent(over: Partial<Agent> = {}): Agent {
  const id = over.id ?? `agent-${nextId++}`;
  return {
    id,
    providerId: "claude-code",
    providerAgentId: id,
    sessionId: "session-1",
    deviceId: "device-1",
    deviceName: "laptop",
    projectId: "project-1",
    projectName: "beluga",
    parentAgentId: null,
    role: "main",
    name: id,
    agentType: null,
    model: "model-1",
    status: "working",
    currentTool: null,
    isDemo: false,
    firstSeenAt: 1000,
    lastEventAt: 2000,
    ...over,
  };
}

describe("stationForTool", () => {
  it("maps reading tools to the library", () => {
    for (const tool of ["read", "grep", "glob", "ls", "list", "notebookread", "view"]) {
      expect(stationForTool(tool, true)).toBe("library");
    }
  });

  it("maps editing tools to the workbench", () => {
    for (const tool of ["edit", "write", "multiedit", "patch", "notebookedit", "todowrite", "apply_patch"]) {
      expect(stationForTool(tool, true)).toBe("workbench");
    }
  });

  it("maps command tools to the terminal", () => {
    for (const tool of ["bash", "shell", "run", "terminal"]) {
      expect(stationForTool(tool, true)).toBe("terminal");
    }
  });

  it("maps web tools to the antenna", () => {
    for (const tool of ["webfetch", "websearch", "fetch"]) {
      expect(stationForTool(tool, true)).toBe("web");
    }
  });

  it("maps delegation tools off the station ring", () => {
    for (const tool of ["task", "agent"]) {
      expect(stationForTool(tool, true)).toBe("delegate");
    }
  });

  it("ignores case and surrounding whitespace", () => {
    expect(stationForTool("Read", true)).toBe("library");
    expect(stationForTool("Bash", true)).toBe("terminal");
    expect(stationForTool("  WebFetch  ", true)).toBe("web");
    expect(stationForTool("TASK", true)).toBe("delegate");
    expect(stationForTool("Edit", false)).toBe("workbench");
  });

  it("sends idle agents home, and busy unknowns to the workbench", () => {
    expect(stationForTool(null, true)).toBe("workbench");
    expect(stationForTool(null, false)).toBe("home");
    expect(stationForTool("unknown-tool", true)).toBe("workbench");
    expect(stationForTool("unknown-tool", false)).toBe("home");
    expect(stationForTool("", false)).toBe("home");
  });
});

describe("team stations", () => {
  const lead = agent({ id: "lead", name: "lead" });
  const subs = [1, 2, 3].map((n) =>
    agent({
      id: `sub-${n}`,
      name: `sub-${n}`,
      role: "subagent",
      parentAgentId: "lead",
      firstSeenAt: 1000 + n,
    }),
  );
  const layout = layoutIslands([lead, ...subs], 4000);

  it("places four distinct stations per team", () => {
    expect(layout.islands).toHaveLength(1);
    const team = layout.islands[0].teams[0];
    expect(team.stations).toHaveLength(4);
    expect(new Set(team.stations.map((s) => s.kind))).toEqual(new Set(STATION_KINDS));
  });

  it("keeps every station inside its island", () => {
    const island = layout.islands[0];
    for (const team of island.teams) {
      for (const station of team.stations) {
        expect(Math.hypot(station.x - island.x, station.z - island.z) + 0.35).toBeLessThanOrEqual(island.radius);
      }
    }
  });

  it("keeps stations clear of agent spots", () => {
    for (const team of layout.islands[0].teams) {
      for (const station of team.stations) {
        for (const node of layout.nodes) {
          expect(Math.hypot(station.x - node.x, station.z - node.z)).toBeGreaterThanOrEqual(0.5);
        }
      }
    }
  });

  it("puts stations on the outer ring, away from the subagent ring", () => {
    const team = layout.islands[0].teams[0];
    // 3 subs -> ringR 1.3 + 0.75 = 2.05, stations at 2.75.
    for (const station of team.stations) {
      expect(Math.hypot(station.x - team.x, station.z - team.z)).toBeCloseTo(2.75, 5);
    }
  });
});
