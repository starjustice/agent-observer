"use client";

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { AgentStatus, StoredEvent } from "@ao/shared";
import { isStale } from "@/lib/format";
import {
  islandSummary,
  stationForTool,
  type Island,
  type IslandLayout,
  type NodeSpot,
  type StationKind,
  type Team,
} from "@/lib/island-layout";
import { Runner, standOff } from "./runner";
import { Stations } from "./stations";

// Same accents as globals.css, as hex for WebGL.
const VIOLET = "#a68cf5";
const ORANGE = "#f59a3c";
const RED = "#f2645a";

interface Look {
  color: string;
  glow: number;
  /** Scale of the node body: 0 would hide it. An ended agent stays as a dark tower until it leaves the map. */
  present: number;
  marker: string | null;
}

const LOOKS: Record<AgentStatus, Look> = {
  starting: { color: VIOLET, glow: 0.8, present: 1, marker: null },
  working: { color: VIOLET, glow: 1.8, present: 1, marker: null },
  waiting: { color: ORANGE, glow: 1.5, present: 1, marker: ORANGE },
  idle: { color: "#6a6a78", glow: 0.35, present: 1, marker: null },
  completed: { color: "#e6e6ee", glow: 0.8, present: 1, marker: null },
  failed: { color: RED, glow: 1.3, present: 1, marker: RED },
  ended: { color: "#3a3a44", glow: 0, present: 1, marker: null },
  unknown: { color: "#6a6a78", glow: 0.2, present: 1, marker: null },
};

/** Heights of the parts of a lead tower and of a subagent pillar. */
const SHAPE = {
  lead: { plate: 0.5, column: 1.35, orb: 0.27, orbY: 1.72, markerY: 2.3, tagY: 2.75, ring: 0.95 },
  sub: { plate: 0.34, column: 0.55, orb: 0.17, orbY: 0.76, markerY: 1.3, tagY: 1.6, ring: 0.62 },
} as const;

interface Pulse {
  at: number;
  color: string;
}
type Pulses = RefObject<Map<string, Pulse>>;

const PULSE_SECONDS = 0.9;
/** Only events this fresh make a node pulse; the first page load does not. */
const PULSE_FRESH_MS = 5000;
const seconds = () => performance.now() / 1000;
const scratch = new THREE.Color();

/** A steady per-id offset so nodes do not move in step. */
function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 6283;
  return h / 1000;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(reducedMotionQuery);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  );
}

/** One floating island: a hexagonal slab with a glowing rim in the project colour. */
function IslandBody({ island, still, children }: { island: Island; still: boolean; children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const phase = useMemo(() => phaseOf(island.key), [island.key]);
  useFrame((state) => {
    if (group.current && !still) group.current.position.y = Math.sin(state.clock.elapsedTime * 0.7 + phase) * 0.05;
  });
  const r = island.radius;
  return (
    <group ref={group} position={[island.x, 0, island.z]}>
      <mesh position={[0, -0.02, 0]}>
        <cylinderGeometry args={[r + 0.08, r + 0.08, 0.05, 6]} />
        <meshStandardMaterial color={island.color} emissive={island.color} emissiveIntensity={0.9} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.16, 0]}>
        <cylinderGeometry args={[r, r * 0.94, 0.3, 6]} />
        <meshStandardMaterial color="#262633" />
      </mesh>
      <mesh position={[0, 0.006, 0]}>
        <cylinderGeometry args={[r * 0.985, r * 0.985, 0.01, 6]} />
        <meshBasicMaterial color={island.color} transparent opacity={0.1} depthWrite={false} />
      </mesh>
      <mesh position={[0, -0.3 - r * 0.28, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[r * 0.8, r * 0.56, 6]} />
        <meshStandardMaterial color="#1b1b25" />
      </mesh>
      {children}
    </group>
  );
}

/** A lead tower or a subagent pillar. The orb is the agent's status. */
function AgentNode({
  spot,
  local,
  color,
  selected,
  stale,
  still,
  pulses,
  onSelect,
}: {
  spot: NodeSpot;
  local: { x: number; z: number };
  color: string;
  selected: boolean;
  stale: boolean;
  still: boolean;
  pulses: Pulses;
  onSelect: (id: string) => void;
}) {
  const { agent } = spot;
  const shape = SHAPE[spot.kind];
  const look = LOOKS[agent.status];
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const marker = useRef<THREE.Mesh>(null);
  const orb = useRef<THREE.MeshStandardMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const placed = useRef(false);
  const [hovered, setHovered] = useState(false);
  const phase = useMemo(() => phaseOf(agent.id), [agent.id]);

  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hovered]);

  useFrame((state, dt) => {
    const g = root.current;
    if (!g) return;
    const k = still || !placed.current ? 1 : 1 - Math.exp(-7 * dt);
    g.position.x += (local.x - g.position.x) * k;
    g.position.z += (local.z - g.position.z) * k;
    placed.current = true;

    // Movement stops when motion is reduced, and when the agent has gone quiet.
    const live = still || stale ? 0 : 1;
    const t = state.clock.elapsedTime + phase;
    let glow = look.glow * (stale ? 0.35 : 1);
    if (agent.status === "starting") glow += Math.sin(t * 4) * 0.4 * live;
    else if (agent.status === "failed") glow *= live && Math.sin(t * 3) < 0 ? 0.35 : 1;

    if (body.current) {
      const s = body.current.scale.x + (look.present - body.current.scale.x) * k;
      body.current.scale.setScalar(Math.max(s, 0.001));
      body.current.visible = s > 0.02;
    }
    if (orb.current) {
      orb.current.emissive.lerp(scratch.set(look.color), k);
      orb.current.emissiveIntensity += (glow - orb.current.emissiveIntensity) * k;
    }
    if (spinner.current) {
      spinner.current.visible = agent.status === "working" && !stale;
      spinner.current.rotation.y = t * 3 * live;
    }
    if (marker.current) {
      marker.current.position.y = shape.markerY + Math.sin(t * 3) * 0.06 * live;
      marker.current.rotation.y = t * 1.5 * live;
    }

    const pulse = pulses.current.get(agent.id);
    const age = pulse ? seconds() - pulse.at : PULSE_SECONDS;
    if (ring.current && ringMat.current) {
      const on = pulse !== undefined && age < PULSE_SECONDS;
      ring.current.visible = on;
      if (on) {
        ring.current.scale.setScalar(0.6 + age * 1.6);
        ringMat.current.opacity = (1 - age / PULSE_SECONDS) * 0.85;
        ringMat.current.color.set(pulse.color);
      }
    }
  });

  return (
    <group
      ref={root}
      position={[local.x, 0, local.z]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect(agent.id);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <group ref={body}>
        {/* Base plate in the project colour, so a node always shows which project it belongs to */}
        <mesh position={[0, 0.06, 0]}>
          <cylinderGeometry args={[shape.plate, shape.plate * 1.12, 0.12, 24]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.55} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.12 + shape.column / 2, 0]}>
          <cylinderGeometry args={[spot.kind === "lead" ? 0.13 : 0.09, spot.kind === "lead" ? 0.18 : 0.12, shape.column, 16]} />
          <meshStandardMaterial color="#3b3b49" />
        </mesh>
        <mesh position={[0, 0.12 + shape.column * 0.35, 0]}>
          <cylinderGeometry args={[spot.kind === "lead" ? 0.152 : 0.105, spot.kind === "lead" ? 0.152 : 0.105, 0.05, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
        <mesh position={[0, shape.orbY, 0]}>
          <sphereGeometry args={[shape.orb, 24, 16]} />
          <meshStandardMaterial ref={orb} color="#0c0c10" emissive="#000000" emissiveIntensity={0} toneMapped={false} />
        </mesh>
        {spot.kind === "lead" ? (
          <group ref={spinner} position={[0, shape.orbY, 0]} visible={false}>
            <mesh rotation={[1.1, 0, 0]}>
              <torusGeometry args={[0.46, 0.022, 8, 48]} />
              <meshBasicMaterial color={VIOLET} transparent opacity={0.85} />
            </mesh>
          </group>
        ) : null}
      </group>

      {/* Needs-attention marker: orange for waiting, red for failed */}
      {look.marker ? (
        <mesh ref={marker} position={[0, shape.markerY, 0]}>
          <octahedronGeometry args={[spot.kind === "lead" ? 0.12 : 0.09]} />
          <meshStandardMaterial color={look.marker} emissive={look.marker} emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
      ) : null}

      {/* Floor rings: hover or selection, and the pulse of a new event */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} visible={selected || hovered}>
        <ringGeometry args={[shape.ring, shape.ring + 0.06, 48]} />
        <meshBasicMaterial color={selected ? VIOLET : "#8a8a99"} transparent opacity={selected ? 0.95 : 0.6} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]} visible={false}>
        <ringGeometry args={[shape.ring - 0.1, shape.ring, 48]} />
        <meshBasicMaterial ref={ringMat} color={VIOLET} transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

interface Point {
  x: number;
  z: number;
}

/** The team's stations and one running person per agent, in island-local coords. */
function TeamRunners({
  team,
  island,
  hubNow,
  still,
  pulses,
  positions,
  onSelect,
}: {
  team: Team;
  island: Island;
  hubNow: number | null;
  still: boolean;
  pulses: Pulses;
  positions: Positions;
  onSelect: (id: string) => void;
}) {
  const plan = useMemo(() => {
    const local = (p: Point): Point => ({ x: p.x - island.x, z: p.z - island.z });
    const centre = local(team);
    const stations = Object.fromEntries(team.stations.map((s) => [s.kind, local(s)])) as Record<StationKind, Point>;
    const spots = [team.lead, ...team.subs];
    const runners = spots.map((spot) => {
      const { agent } = spot;
      const tower = local(spot);
      const home = spot.kind === "lead" ? { x: tower.x, z: tower.z + 0.45 } : standOff(tower, centre, 0.45);
      let delegateTo: Point | null = null;
      if (agent.status === "working" && stationForTool(agent.currentTool, true) === "delegate") {
        const children = team.subs
          .filter((s) => s.parent?.agent.id === agent.id)
          .sort((a, b) => b.agent.firstSeenAt - a.agent.firstSeenAt);
        const child = children.find((s) => s.agent.status === "working") ?? children[0];
        if (child) delegateTo = local(child);
      }
      return {
        spot,
        home,
        delegateTo,
        spawnFrom: spot.kind === "sub" && spot.parent ? local(spot.parent) : null,
      };
    });
    return { centre, stations, runners };
  }, [team, island.x, island.z]);

  const staleOf = (spot: NodeSpot) => hubNow !== null && isStale(spot.agent, hubNow);
  const activeKinds = new Set<StationKind>();
  for (const { spot, delegateTo } of plan.runners) {
    if (spot.agent.status !== "working" || staleOf(spot)) continue;
    const where = stationForTool(spot.agent.currentTool, true);
    if (where === "delegate") {
      if (!delegateTo) activeKinds.add("workbench");
    } else if (where !== "home") {
      activeKinds.add(where);
    }
  }

  return (
    <>
      <Stations
        stations={team.stations}
        originX={island.x}
        originZ={island.z}
        color={island.color}
        activeKinds={activeKinds}
      />
      {plan.runners.map(({ spot, home, delegateTo, spawnFrom }) => (
        <Runner
          key={`runner-${spot.agent.id}`}
          spot={spot}
          home={home}
          centre={plan.centre}
          stations={plan.stations}
          delegateTo={delegateTo}
          spawnFrom={spawnFrom}
          color={island.color}
          statusColor={LOOKS[spot.agent.status].color}
          stale={staleOf(spot)}
          still={still}
          pulses={pulses}
          positions={positions}
          islandOffset={island}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

interface FlowLine {
  material: { dashOffset: number; opacity: number };
}

/** A delegation beam from a lead to one of its subagents. It flows while that subagent works. */
function Beam({
  from,
  to,
  color,
  active,
  still,
}: {
  from: [number, number, number];
  to: [number, number, number];
  color: string;
  active: boolean;
  still: boolean;
}) {
  const line = useRef<FlowLine | null>(null);
  useFrame((_, dt) => {
    const m = line.current?.material;
    if (!m) return;
    if (active && !still) m.dashOffset -= dt * 1.4;
    m.opacity += ((active ? 0.95 : 0.35) - m.opacity) * Math.min(1, dt * 6);
  });
  return (
    <Line
      ref={line as never}
      points={[from, to]}
      color={color}
      lineWidth={2}
      transparent
      opacity={active ? 0.95 : 0.35}
      dashed
      dashSize={0.18}
      gapSize={0.12}
    />
  );
}

type LabelEls = RefObject<Map<string, HTMLElement>>;
type Positions = RefObject<Map<string, THREE.Vector3>>;
const point = new THREE.Vector3();

/**
 * Keeps the island banners and name tags, which are plain page elements drawn
 * over the canvas, on top of their islands and nodes as the camera moves.
 */
function LabelProjector({ layout, els, positions }: { layout: IslandLayout; els: LabelEls; positions: Positions }) {
  useFrame(({ camera, size }) => {
    const place = (key: string, x: number, y: number, z: number, anchor: string, min: number) => {
      const el = els.current.get(key);
      if (!el) return;
      const distance = camera.position.distanceTo(point.set(x, y, z));
      point.project(camera);
      if (point.z > 1) {
        el.style.visibility = "hidden";
        return;
      }
      const px = (point.x * 0.5 + 0.5) * size.width;
      const py = (-point.y * 0.5 + 0.5) * size.height;
      const scale = Math.min(1.1, Math.max(min, 14 / distance));
      el.style.visibility = "visible";
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) ${anchor} scale(${scale.toFixed(3)})`;
    };
    for (const island of layout.islands) {
      place(`island:${island.key}`, island.x, 0, island.z + island.radius + 0.3, "translate(-50%, 0)", 0.6);
    }
    for (const spot of layout.nodes) {
      const key = `node:${spot.agent.id}`;
      const runner = positions.current.get(spot.agent.id);
      if (runner) place(key, runner.x, runner.y + 0.35, runner.z, "translate(-50%, -100%)", 0.5);
      else place(key, spot.x, SHAPE[spot.kind].tagY, spot.z, "translate(-50%, -100%)", 0.5);
    }
  });
  return null;
}

interface Controls {
  target: THREE.Vector3;
  update: () => void;
  addEventListener: (type: "start", listener: () => void) => void;
  removeEventListener: (type: "start", listener: () => void) => void;
}

interface Focus {
  x: number;
  z: number;
  radius: number;
  /** The reset count it was made under; a reset makes it stale. */
  resetKey: number;
  nonce: number;
}

/**
 * Frames the whole map until the viewer moves the camera themself, and flies to
 * an island when its banner is clicked.
 */
function CameraRig({
  radius,
  resetKey,
  focus,
  still,
}: {
  radius: number;
  resetKey: number;
  focus: Focus | null;
  still: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const invalidate = useThree((s) => s.invalidate);
  const touched = useRef(false);
  const fitted = useRef(0);
  const goal = useRef<{ target: THREE.Vector3; position: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (!controls) return;
    const onStart = () => {
      touched.current = true;
      goal.current = null;
    };
    controls.addEventListener("start", onStart);
    return () => controls.removeEventListener("start", onStart);
  }, [controls]);

  useEffect(() => {
    touched.current = false;
    fitted.current = 0;
    goal.current = null;
  }, [resetKey]);

  useEffect(() => {
    if (!controls || touched.current) return;
    if (Math.abs(radius - fitted.current) / radius < 0.15) return;
    fitted.current = radius;
    camera.position.set(radius * 0.7, radius * 1.25 + 2, radius * 1.75);
    controls.target.set(0, 0.5, 0);
    controls.update();
    invalidate();
  }, [radius, resetKey, camera, controls, invalidate]);

  useEffect(() => {
    if (!controls || !focus) return;
    const d = Math.max(9, focus.radius * 3.2);
    const next = {
      target: new THREE.Vector3(focus.x, 0.5, focus.z),
      position: new THREE.Vector3(focus.x + d * 0.45, d * 0.75, focus.z + d * 0.95),
    };
    if (still) {
      camera.position.copy(next.position);
      controls.target.copy(next.target);
      controls.update();
      invalidate();
    } else {
      goal.current = next;
    }
  }, [focus, controls, camera, still, invalidate]);

  useFrame((_, dt) => {
    const g = goal.current;
    if (!g || !controls) return;
    const k = 1 - Math.exp(-5 * dt);
    camera.position.lerp(g.position, k);
    controls.target.lerp(g.target, k);
    controls.update();
    if (camera.position.distanceTo(g.position) < 0.05) goal.current = null;
  });

  return null;
}

/** With motion reduced the scene only draws when something changes. */
function RedrawOnChange({ signal }: { signal: unknown }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidate();
  }, [signal, invalidate]);
  return null;
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          The 3D view could not start in this browser. Switch to the list view.
        </p>
      );
    }
    return this.props.children;
  }
}

export interface IslandSceneProps {
  layout: IslandLayout;
  events: StoredEvent[];
  hubNow: number | null;
  clockOffsetMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Change it to put the camera back on the whole map. */
  resetKey: number;
}

export default function IslandScene({
  layout,
  events,
  hubNow,
  clockOffsetMs,
  selectedId,
  onSelect,
  resetKey,
}: IslandSceneProps) {
  const still = useReducedMotion();
  const pulses = useRef(new Map<string, Pulse>());
  const lastEventId = useRef(0);
  const labelEls = useRef(new Map<string, HTMLElement>());
  const runnerPositions = useRef(new Map<string, THREE.Vector3>());
  const [picked, setFocus] = useState<Focus | null>(null);
  const focus = picked && picked.resetKey === resetKey ? picked : null;
  const labelRef = (key: string) => (el: HTMLElement | null) => {
    if (el) labelEls.current.set(key, el);
    else labelEls.current.delete(key);
  };

  useEffect(() => {
    const now = Date.now() + clockOffsetMs;
    for (const event of events) {
      if (event.id <= lastEventId.current) break;
      if (now - event.receivedAt > PULSE_FRESH_MS) continue;
      if (pulses.current.has(event.agentId) && seconds() - pulses.current.get(event.agentId)!.at < 0.05) continue;
      const color =
        event.outcome === "failure" ? RED : event.eventType === "permission_requested" ? ORANGE : VIOLET;
      pulses.current.set(event.agentId, { at: seconds(), color });
    }
    lastEventId.current = Math.max(lastEventId.current, events[0]?.id ?? 0);
  }, [events, clockOffsetMs]);

  const subsOfLead = useMemo(() => {
    const map = new Map<string, number>();
    for (const island of layout.islands) for (const team of island.teams) map.set(team.lead.agent.id, team.subs.length);
    return map;
  }, [layout]);
  const colorOfNode = useMemo(() => {
    const map = new Map<string, string>();
    for (const island of layout.islands) for (const team of island.teams) {
      map.set(team.lead.agent.id, island.color);
      for (const sub of team.subs) map.set(sub.agent.id, island.color);
    }
    return map;
  }, [layout]);
  const focusIsland = (island: Island) =>
    setFocus((f) => ({ x: island.x, z: island.z, radius: island.radius, resetKey, nonce: (f?.nonce ?? 0) + 1 }));

  return (
    <SceneBoundary>
      <Canvas
        dpr={[1, 2]}
        frameloop={still ? "demand" : "always"}
        camera={{ fov: 38, position: [8, 9, 13], near: 0.1, far: 400 }}
        gl={{ antialias: true, alpha: true }}
        onPointerMissed={() => onSelect(null)}
      >
        <ambientLight intensity={1.0} />
        <directionalLight position={[6, 12, 8]} intensity={2.2} />
        <directionalLight position={[-8, 6, -6]} intensity={0.5} color={VIOLET} />

        {layout.islands.map((island) => (
          <IslandBody key={island.key} island={island} still={still}>
            {island.teams.map((team) => (
              <group key={team.lead.agent.id}>
                {team.subs.map((sub) => {
                  const parent = sub.parent;
                  if (!parent) return null;
                  const parentTop = parent.agent.id === team.lead.agent.id ? SHAPE.lead.orbY : SHAPE.sub.orbY;
                  return (
                    <Beam
                      key={`beam-${sub.agent.id}`}
                      from={[parent.x - island.x, parentTop, parent.z - island.z]}
                      to={[sub.x - island.x, SHAPE.sub.orbY, sub.z - island.z]}
                      color={island.color}
                      active={sub.agent.status === "working" && !(hubNow !== null && isStale(sub.agent, hubNow))}
                      still={still}
                    />
                  );
                })}
                <TeamRunners
                  team={team}
                  island={island}
                  hubNow={hubNow}
                  still={still}
                  pulses={pulses}
                  positions={runnerPositions}
                  onSelect={onSelect}
                />
                {[team.lead, ...team.subs].map((spot) => (
                  <AgentNode
                    key={spot.agent.id}
                    spot={spot}
                    local={{ x: spot.x - island.x, z: spot.z - island.z }}
                    color={island.color}
                    selected={spot.agent.id === selectedId}
                    stale={hubNow !== null && isStale(spot.agent, hubNow)}
                    still={still}
                    pulses={pulses}
                    onSelect={onSelect}
                  />
                ))}
              </group>
            ))}
          </IslandBody>
        ))}

        <OrbitControls
          makeDefault
          enableDamping
          maxPolarAngle={1.45}
          minDistance={3}
          maxDistance={layout.radius * 4 + 12}
        />
        <CameraRig radius={layout.radius} resetKey={resetKey} focus={focus} still={still} />
        <LabelProjector layout={layout} els={labelEls} positions={runnerPositions} />
        {still ? <RedrawOnChange signal={layout} /> : null}
      </Canvas>

      <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
        {layout.islands.map((island) => (
          <button
            key={island.key}
            type="button"
            ref={labelRef(`island:${island.key}`)}
            onClick={() => focusIsland(island)}
            title="Zoom to this project"
            style={{ borderColor: `${island.color}99` }}
            className="pointer-events-auto invisible absolute top-0 left-0 flex origin-top cursor-pointer items-center gap-2 rounded-lg border bg-background/85 px-2.5 py-1 text-xs whitespace-nowrap shadow-md"
          >
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: island.color }} />
            <span className="font-semibold" style={{ color: island.color }}>
              {island.label}
            </span>
            <span className="text-muted-foreground">· {island.device}</span>
            <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-foreground/90">
              {islandSummary(island)}
            </span>
          </button>
        ))}
        {layout.nodes.map(({ agent, kind }) => {
          const stale = hubNow !== null && isStale(agent, hubNow);
          const subs = subsOfLead.get(agent.id) ?? 0;
          const color = colorOfNode.get(agent.id);
          return (
            <div
              key={agent.id}
              ref={labelRef(`node:${agent.id}`)}
              className="invisible absolute top-0 left-0 flex origin-top-left flex-col items-center gap-0.5 whitespace-nowrap"
            >
              {agent.status === "working" && agent.currentTool !== null ? (
                <span className="rounded border border-violet/40 bg-background/85 px-1.5 py-px font-mono text-[11px] text-violet">
                  {agent.currentTool}
                </span>
              ) : null}
              <span
                className={`flex max-w-44 items-center gap-1 truncate rounded px-1.5 py-px text-xs font-medium ${
                  agent.id === selectedId ? "bg-violet text-background" : "bg-background/80 text-foreground"
                }`}
                style={color && agent.id !== selectedId ? { boxShadow: `inset 0 -2px 0 ${color}` } : undefined}
              >
                {kind === "lead" && subs > 0 ? (
                  <span className="rounded bg-violet/25 px-1 text-[10px] font-semibold text-violet">LEAD · {subs}</span>
                ) : null}
                <span className="truncate">{agent.role === "main" ? "Lead agent" : agent.name}</span>
                {stale ? <span className="font-normal text-orange">stale</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </SceneBoundary>
  );
}
