"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { AgentStatus } from "@ao/shared";
import { stationForTool, type NodeSpot, type StationKind } from "@/lib/island-layout";

interface Point {
  x: number;
  z: number;
}

type Pose = "stand" | "work" | "sit" | "wait" | "slump";

interface Plan {
  /** Where to go; null stays put. */
  target: Point | null;
  /** What to look at once there; null keeps the current heading. */
  face: Point | null;
  pose: Pose;
  fast: boolean;
}

interface RunState {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  cycle: number;
  shrink: number;
  world: THREE.Vector3 | null;
}

const RUN_SPEED = 2.2;
const WALK_SPEED = 0.8;
const ARRIVE = 0.06;
const TOWER_CLEAR = 0.25;
const DETOUR = 0.4;
const STATION_STAND = 0.28;
const DELEGATE_STAND = 0.3;
const HOP_SECONDS = 0.4;
/** Height of the rig at scale 1, to the top of the head. */
const HEIGHT = 0.5;
/** Rig scale per node kind. Big enough to read as a person beside a 1.35-tall tower. */
const SCALE = { lead: 1.5, sub: 1.05 } as const;
const HIP_Y = 0.2;
const RED = "#f2645a";

const seconds = () => performance.now() / 1000;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A point `gap` away from `from`, toward `toward`; straight ahead (+z) when they coincide. */
export function standOff(from: Point, toward: Point, gap: number): Point {
  const dx = toward.x - from.x;
  const dz = toward.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return { x: from.x, z: from.z + gap };
  return { x: from.x + (dx / d) * gap, z: from.z + (dz / d) * gap };
}

/** Where to head next: the goal, or a point beside the tower when the straight path runs through it. */
function aimFor(px: number, pz: number, goal: Point, tower: Point): Point {
  if (Math.hypot(px - tower.x, pz - tower.z) <= TOWER_CLEAR) return goal;
  const sx = goal.x - px;
  const sz = goal.z - pz;
  const len2 = sx * sx + sz * sz;
  if (len2 < 1e-9) return goal;
  const t = ((tower.x - px) * sx + (tower.z - pz) * sz) / len2;
  if (t <= 0 || t >= 1) return goal;
  let nx = px + sx * t - tower.x;
  let nz = pz + sz * t - tower.z;
  const d = Math.hypot(nx, nz);
  if (d >= TOWER_CLEAR) return goal;
  if (d < 1e-4) {
    nx = -sz;
    nz = sx;
  }
  const n = Math.hypot(nx, nz);
  const aim = { x: tower.x + (nx / n) * DETOUR, z: tower.z + (nz / n) * DETOUR };
  return Math.hypot(aim.x - px, aim.z - pz) < ARRIVE ? goal : aim;
}

const HOME_POSE: Partial<Record<AgentStatus, Pose>> = {
  idle: "sit",
  completed: "sit",
  waiting: "wait",
};

/** An arm or a leg, hung from a pivot at the shoulder or hip so rotation swings it. */
function Limb({
  limbRef,
  x,
  y,
  length,
  radius,
  color,
  glow = false,
}: {
  limbRef: RefObject<THREE.Group | null>;
  x: number;
  y: number;
  length: number;
  radius: number;
  color: string;
  glow?: boolean;
}) {
  return (
    <group ref={limbRef} position={[x, y, 0]}>
      <mesh position={[0, -length / 2, 0]}>
        <cylinderGeometry args={[radius, radius * 0.8, length, 6]} />
        <meshStandardMaterial
          color={color}
          emissive={glow ? color : "#000000"}
          emissiveIntensity={glow ? 0.2 : 0}
          flatShading
        />
      </mesh>
    </group>
  );
}

export interface RunnerProps {
  spot: NodeSpot;
  /** Island-local spot beside the tower where the person rests. */
  home: Point;
  /** Island-local centre of the team, which stations are approached from. */
  centre: Point;
  stations: Record<StationKind, Point>;
  /** Island-local pillar of the subagent this agent is delegating to. */
  delegateTo: Point | null;
  /** Island-local spot a newly mounted runner starts from. */
  spawnFrom: Point | null;
  color: string;
  statusColor: string;
  stale: boolean;
  still: boolean;
  pulses: RefObject<Map<string, { at: number; color: string }>>;
  /** Written each frame with the world position of the top of the head. */
  positions: RefObject<Map<string, THREE.Vector3>>;
  islandOffset: Point;
  onSelect: (id: string) => void;
}

/** A little person who runs between an agent's tower and the stations of its team. */
export function Runner({
  spot,
  home,
  centre,
  stations,
  delegateTo,
  spawnFrom,
  color,
  statusColor,
  stale,
  still,
  pulses,
  positions,
  islandOffset,
  onSelect,
}: RunnerProps) {
  const { agent } = spot;
  const tower = { x: spot.x - islandOffset.x, z: spot.z - islandOffset.z };
  const start = spawnFrom ?? tower;
  const scale = SCALE[spot.kind];

  const root = useRef<THREE.Group>(null);
  const rig = useRef<THREE.Group>(null);
  const upper = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Mesh>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const torsoMat = useRef<THREE.MeshStandardMaterial>(null);
  const headMat = useRef<THREE.MeshStandardMaterial>(null);
  const run = useRef<RunState>({ x: start.x, z: start.z, yaw: 0, speed: 0, cycle: 0, shrink: 1, world: null });
  const [hovered, setHovered] = useState(false);

  const plan = useMemo((): Plan => {
    const towerAt = { x: spot.x - islandOffset.x, z: spot.z - islandOffset.z };
    const awayFromTower = { x: 2 * home.x - towerAt.x, z: 2 * home.z - towerAt.z };
    const goHome = (pose: Pose, fast = false): Plan => ({ target: home, face: awayFromTower, pose, fast });
    switch (agent.status) {
      case "working": {
        const where = stationForTool(agent.currentTool, true);
        if (where === "delegate" && delegateTo) {
          return { target: standOff(delegateTo, towerAt, DELEGATE_STAND), face: delegateTo, pose: "work", fast: true };
        }
        if (where === "home") return goHome("stand", true);
        const station = stations[where === "delegate" ? "workbench" : where];
        return { target: standOff(station, centre, STATION_STAND), face: station, pose: "work", fast: true };
      }
      case "starting":
        return goHome("stand", true);
      case "failed":
        return { target: null, face: null, pose: "slump", fast: false };
      default:
        return goHome(HOME_POSE[agent.status] ?? "stand");
    }
  }, [agent.status, agent.currentTool, spot.x, spot.z, islandOffset.x, islandOffset.z, home, centre, stations, delegateTo]);

  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hovered]);

  useEffect(() => {
    const map = positions.current;
    return () => {
      map.delete(agent.id);
    };
  }, [positions, agent.id]);

  useFrame((state, rawDt) => {
    const g = root.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    const s = run.current;
    const t = state.clock.elapsedTime;
    const goal = plan.target ?? { x: s.x, z: s.z };
    let arrived = Math.hypot(goal.x - s.x, goal.z - s.z) <= ARRIVE;
    let yawGoal = s.yaw;

    if (still) {
      s.x = goal.x;
      s.z = goal.z;
      s.speed = 0;
      arrived = true;
    } else if (!stale) {
      if (!arrived) {
        const aim = aimFor(s.x, s.z, goal, tower);
        const max = plan.fast ? RUN_SPEED : WALK_SPEED;
        s.speed += (max - s.speed) * (1 - Math.exp(-6 * dt));
        const dx = aim.x - s.x;
        const dz = aim.z - s.z;
        const d = Math.hypot(dx, dz);
        const step = Math.min(s.speed * dt, d);
        if (d > 1e-6) {
          s.x += (dx / d) * step;
          s.z += (dz / d) * step;
          yawGoal = Math.atan2(dx, dz);
        }
      } else {
        s.speed *= Math.exp(-10 * dt);
      }
    }
    if (arrived && plan.face) yawGoal = Math.atan2(plan.face.x - s.x, plan.face.z - s.z);
    if (still) s.yaw = yawGoal;
    else if (!stale) s.yaw += wrap(yawGoal - s.yaw) * (1 - Math.exp(-10 * dt));

    if (agent.status === "ended" && arrived) s.shrink = still ? 0 : Math.max(0, s.shrink - dt);
    else if (agent.status !== "ended") s.shrink = still ? 1 : Math.min(1, s.shrink + dt * 2);

    g.position.set(s.x, 0, s.z);
    g.rotation.y = s.yaw;
    g.scale.setScalar(Math.max(scale * s.shrink, 0.001));
    g.visible = s.shrink > 0.01;

    // Limbs: stale freezes them where they are.
    let lift = 0;
    if (!stale || still) {
      const sf = s.speed / RUN_SPEED;
      if (!still) s.cycle += dt * 11 * sf;
      const swing = still ? 0 : Math.sin(s.cycle) * 0.9 * sf;
      const moving = !arrived && !still;
      const pose: Pose | "run" = moving ? "run" : plan.pose;
      const live = still ? 0 : 1;

      let leg = swing;
      let armLx = -swing;
      let armRx = swing;
      let armZ = 0;
      let tilt = moving ? 0.12 * sf : 0;
      let breathe = 1;
      if (moving) lift = Math.abs(Math.sin(s.cycle)) * 0.04;
      if (pose === "work") {
        leg = 0;
        armLx = -1.0 + Math.sin(t * 18) * 0.15 * live;
        armRx = -1.0 + Math.sin(t * 18 + Math.PI) * 0.15 * live;
        tilt = 0.08;
      } else if (pose === "sit") {
        leg = 0;
        armLx = -0.5;
        armRx = -0.5;
        lift = -0.12;
        breathe = 1 + Math.sin(t * 1.6) * 0.03 * live;
      } else if (pose === "wait") {
        leg = 0;
        armLx = -0.6;
        armRx = -0.6;
        armZ = 0.35;
        lift = Math.abs(Math.sin(t * 3)) * 0.02 * live;
      } else if (pose === "slump") {
        leg = 0;
        armLx = 0.2;
        armRx = 0.2;
        tilt = 0.5;
      } else if (pose === "stand") {
        leg = 0;
        armLx = 0;
        armRx = 0;
      }
      const sitting = pose === "sit";

      const k = still ? 1 : 1 - Math.exp(-20 * dt);
      const ease = (obj: THREE.Object3D | null, x: number, z = 0) => {
        if (!obj) return;
        obj.rotation.x += (x - obj.rotation.x) * k;
        obj.rotation.z += (z - obj.rotation.z) * k;
      };
      ease(legL.current, sitting ? -1.4 : leg);
      ease(legR.current, sitting ? -1.4 : -leg);
      ease(armL.current, armLx, -armZ);
      ease(armR.current, armRx, armZ);
      ease(upper.current, tilt);
      if (torso.current) torso.current.scale.setScalar(breathe);

      const pulse = pulses.current.get(agent.id);
      const age = pulse ? seconds() - pulse.at : HOP_SECONDS;
      if (!still && age >= 0 && age < HOP_SECONDS) lift += Math.sin((age / HOP_SECONDS) * Math.PI) * 0.12;
      if (rig.current) rig.current.position.y += (lift - rig.current.position.y) * (sitting ? k : 1);
    }

    const dim = stale ? 0.35 : 1;
    if (torsoMat.current) torsoMat.current.emissiveIntensity = 0.3 * dim;
    if (headMat.current) {
      let glow = agent.status === "working" ? 1.2 : 0.5;
      if (agent.status === "failed") glow = still ? 1.2 : 0.6 + 0.6 * (0.5 + 0.5 * Math.sin(t * 4));
      headMat.current.emissiveIntensity = glow * dim;
    }

    s.world ??= new THREE.Vector3();
    const top = (HEIGHT + (rig.current?.position.y ?? 0)) * scale * s.shrink;
    s.world.set(islandOffset.x + s.x, top, islandOffset.z + s.z);
    positions.current.set(agent.id, s.world);
  });

  return (
    <group
      ref={root}
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
      <group ref={rig}>
        <Limb limbRef={legL} x={-0.035} y={HIP_Y} length={0.19} radius={0.03} color="#2c2c3a" />
        <Limb limbRef={legR} x={0.035} y={HIP_Y} length={0.19} radius={0.03} color="#2c2c3a" />
        <group ref={upper} position={[0, HIP_Y, 0]}>
          <mesh ref={torso} position={[0, 0.1, 0]}>
            <capsuleGeometry args={[0.06, 0.1, 2, 6]} />
            <meshStandardMaterial
              ref={torsoMat}
              color={color}
              emissive={color}
              emissiveIntensity={0.3}
              flatShading
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.245, 0]}>
            <sphereGeometry args={[0.055, 8, 6]} />
            <meshStandardMaterial
              ref={headMat}
              color="#d8d8e0"
              emissive={agent.status === "failed" ? RED : statusColor}
              emissiveIntensity={0.5}
              flatShading
              toneMapped={false}
            />
          </mesh>
          <Limb limbRef={armL} x={-0.085} y={0.17} length={0.16} radius={0.022} color={color} glow />
          <Limb limbRef={armR} x={0.085} y={0.17} length={0.16} radius={0.022} color={color} glow />
        </group>
      </group>
    </group>
  );
}
