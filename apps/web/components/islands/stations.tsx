"use client";

import { useRef } from "react";
import type { JSX } from "react";
import { useFrame } from "@react-three/fiber";
import type { MeshBasicMaterial, MeshStandardMaterial } from "three";
import type { Station, StationKind } from "@/lib/island-layout";

/** How fast the glow eases toward its target, per second. */
const GLOW_EASE = 6;

/**
 * A project-coloured accent material that eases between idle and active.
 * `strength` scales the whole glow, so small details stay subtler than screens.
 */
function AccentMaterial({ color, active, strength = 1 }: { color: string; active: boolean; strength?: number }) {
  const material = useRef<MeshStandardMaterial>(null);
  useFrame((_, dt) => {
    const m = material.current;
    if (!m) return;
    const target = (active ? 1.6 : 0.35) * strength;
    m.emissiveIntensity += (target - m.emissiveIntensity) * Math.min(1, dt * GLOW_EASE);
  });
  return (
    <meshStandardMaterial
      ref={material}
      color={color}
      emissive={color}
      emissiveIntensity={(active ? 1.6 : 0.35) * strength}
      toneMapped={false}
    />
  );
}

/** A soft disc on the island floor: dim while the station is idle, brighter while in use. */
function GlowDisc({ color, active }: { color: string; active: boolean }) {
  const material = useRef<MeshBasicMaterial>(null);
  useFrame((_, dt) => {
    const m = material.current;
    if (!m) return;
    m.opacity += ((active ? 0.3 : 0.08) - m.opacity) * Math.min(1, dt * GLOW_EASE * 0.8);
  });
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
      <circleGeometry args={[0.21, 24]} />
      <meshBasicMaterial
        ref={material}
        color={color}
        transparent
        opacity={active ? 0.3 : 0.08}
        depthWrite={false}
      />
    </mesh>
  );
}

function LibraryProp({ color, active }: { color: string; active: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.22, 0]}>
        <boxGeometry args={[0.32, 0.42, 0.16]} />
        <meshStandardMaterial color="#2c2c3a" />
      </mesh>
      {[-0.09, 0, 0.09].map((x, i) => (
        <mesh key={x} position={[x, 0.22 + (i === 1 ? 0.03 : 0), 0.085]}>
          <boxGeometry args={[0.055, 0.16, 0.02]} />
          <AccentMaterial color={color} active={active} strength={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function WorkbenchProp({ color, active }: { color: string; active: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.26, 0]}>
        <boxGeometry args={[0.34, 0.035, 0.2]} />
        <meshStandardMaterial color="#3b3b49" />
      </mesh>
      {[
        [-0.14, -0.08],
        [-0.14, 0.08],
        [0.14, -0.08],
        [0.14, 0.08],
      ].map(([x, z]) => (
        <mesh key={`${x}:${z}`} position={[x, 0.13, z]}>
          <boxGeometry args={[0.022, 0.26, 0.022]} />
          <meshStandardMaterial color="#2c2c3a" />
        </mesh>
      ))}
      <mesh position={[0.03, 0.315, 0]}>
        <boxGeometry args={[0.1, 0.075, 0.08]} />
        <AccentMaterial color={color} active={active} />
      </mesh>
    </group>
  );
}

function TerminalProp({ color, active }: { color: string; active: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.012, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.024, 16]} />
        <meshStandardMaterial color="#2c2c3a" />
      </mesh>
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[0.02, 0.024, 0.16, 12]} />
        <meshStandardMaterial color="#3b3b49" />
      </mesh>
      <mesh position={[0, 0.27, 0]}>
        <boxGeometry args={[0.26, 0.17, 0.05]} />
        <meshStandardMaterial color="#2c2c3a" />
      </mesh>
      <mesh position={[0, 0.27, 0.027]}>
        <planeGeometry args={[0.21, 0.12]} />
        <AccentMaterial color={color} active={active} />
      </mesh>
    </group>
  );
}

function WebProp({ color, active }: { color: string; active: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.014, 0.018, 0.3, 8]} />
        <meshStandardMaterial color="#3b3b49" />
      </mesh>
      <mesh position={[0, 0.34, 0.02]} rotation={[0.55, 0, 0]}>
        <coneGeometry args={[0.11, 0.1, 12, 1, true]} />
        <AccentMaterial color={color} active={active} strength={0.8} />
      </mesh>
      <mesh position={[0, 0.4, 0]}>
        <sphereGeometry args={[0.03, 12, 8]} />
        <AccentMaterial color={color} active={active} />
      </mesh>
    </group>
  );
}

/**
 * One station on an island. x and z are island-local: the caller has already
 * subtracted the island centre.
 */
export function StationProp({
  kind,
  x,
  z,
  color,
  active,
}: {
  kind: StationKind;
  x: number;
  z: number;
  color: string;
  active: boolean;
}): JSX.Element {
  return (
    <group position={[x, 0, z]}>
      <GlowDisc color={color} active={active} />
      {kind === "library" ? <LibraryProp color={color} active={active} /> : null}
      {kind === "workbench" ? <WorkbenchProp color={color} active={active} /> : null}
      {kind === "terminal" ? <TerminalProp color={color} active={active} /> : null}
      {kind === "web" ? <WebProp color={color} active={active} /> : null}
    </group>
  );
}

/** All four stations of one team, converted from absolute to island-local coords. */
export function Stations({
  stations,
  originX,
  originZ,
  color,
  activeKinds,
}: {
  stations: Station[];
  originX: number;
  originZ: number;
  color: string;
  activeKinds: ReadonlySet<StationKind>;
}) {
  return (
    <group>
      {stations.map((s) => (
        <StationProp
          key={s.kind}
          kind={s.kind}
          x={s.x - originX}
          z={s.z - originZ}
          color={color}
          active={activeKinds.has(s.kind)}
        />
      ))}
    </group>
  );
}
