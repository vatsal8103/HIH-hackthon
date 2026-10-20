// The Bayora security lattice. Loaded lazily so three.js stays out of the main bundle.
//
// Topology: the Red Team zone (left) and Blue Team zone (right) are separated from the
// Target core by framed walls, each with a single iris gateway. There is no Red↔Blue
// channel. Every animated element is driven by the current backend stage and by the
// recorded run counts in `data`; nothing moves while no stage is playing.

import { Canvas, invalidate, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { STAGE_MS } from "../lab";
import { facetPlate, icosahedronFacets, irisBlade, probeLine, shadowTexture, wallPanel } from "./geometry";
import { PALETTE, SCENE_ORDER, type Role, type SceneData, type SceneStage } from "./model";

export interface LatticeProps {
  stage: SceneStage;
  playing: boolean;
  data: SceneData;
  reducedMotion: boolean;
  highlight: Role | null;
  onHover: (role: Role | null) => void;
  labels: RefObject<Record<Role, HTMLElement | null>>;
}

const CORE_Y = 0.15;
const CORE_R = 0.95;
const SHIELD_R = 1.34;
const WALL_X = 1.9;
const CELL_X = 3.45;
const FLOOR_Y = -1.56;
const GATE_R = 0.36;
const WALL_W = 2.7;
const WALL_H = 3.3;
const WALL_CY = FLOOR_Y + WALL_H / 2;
const ZONE_D = 5.2;
const PROBE_LINES = 8; // one per probed resource in the isolation matrix
const MAX_PACKETS = 7;
const MAX_RINGS = 5;

const v = (x: number, y = CORE_Y, z = 0) => new THREE.Vector3(x, y, z);
const PATH_RED_CORE = [v(-CELL_X + 0.45), v(-WALL_X), v(-CORE_R - 0.05)];
const PATH_RED_SHIELD = [v(-CELL_X + 0.45), v(-WALL_X), v(-SHIELD_R)];
const PATH_CORE_BLUE = [v(CORE_R + 0.05), v(WALL_X), v(CELL_X - 0.45)];
const LABEL_ANCHORS: [Role, THREE.Vector3][] = [
  ["red", v(-CELL_X, 1.3)],
  ["target", v(0, 2.0)],
  ["blue", v(CELL_X, 1.3)],
];
const RING_TILTS: [number, number, number][] = [
  [Math.PI / 2, 0, 0.4],
  [Math.PI / 2, 0.62, 1.9],
  [Math.PI / 2, -0.62, 3.1],
  [0.32, 0, Math.PI / 2],
  [-0.32, 0, Math.PI / 2 + 2],
];

// Camera framing per stage: x/y offset, distance multiplier and look-at point.
interface Framing {
  x: number;
  y: number;
  zoom: number;
  look: THREE.Vector3;
}
const HERO: Framing = { x: 2.6, y: 1.95, zoom: 1, look: v(0, 0.02) };
const FRAMING: Partial<Record<SceneStage, Framing>> = {
  attack: { x: 1.3, y: 1.7, zoom: 0.92, look: v(-0.85, 0.1) },
  respond: { x: 2.2, y: 1.55, zoom: 0.86, look: v(0, 0.15) },
  evaluate: { x: 2.2, y: 1.55, zoom: 0.86, look: v(0, 0.15) },
  defend: { x: 3.7, y: 1.8, zoom: 0.92, look: v(0.85, 0.1) },
  retest: { x: 1.3, y: 1.7, zoom: 0.92, look: v(-0.85, 0.1) },
  isolation: { x: 2.0, y: 3.4, zoom: 1.04, look: v(0, -0.25) },
};

// ---------------------------------------------------------------- math helpers

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Rises over [a, b], holds, falls over [c, d]. */
const window4 = (p: number, a: number, b: number, c: number, d: number) => smooth(a, b, p) * (1 - smooth(c, d, p));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** A 0→1→0 bump while p moves through [a, b]. */
const bump = (p: number, a: number, b: number) => (p <= a || p >= b ? 0 : Math.sin(((p - a) / (b - a)) * Math.PI));
/** Spread `count` marks evenly over `total` ordered slots (Bresenham). */
const marked = (order: number, count: number, total: number) =>
  Math.floor(((order + 1) * count) / total) > Math.floor((order * count) / total);

function along(path: THREE.Vector3[], t: number, out: THREE.Vector3) {
  const lengths = path.slice(1).map((point, i) => point.distanceTo(path[i]));
  let remaining = clamp01(t) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      return out.lerpVectors(path[i], path[i + 1], lengths[i] ? Math.min(1, remaining / lengths[i]) : 1);
    }
    remaining -= lengths[i];
  }
  return out;
}

function dashedLine(points: THREE.Vector3[], material: THREE.LineDashedMaterial) {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
  line.computeLineDistances();
  return line;
}

// ---------------------------------------------------------------- scene

function Environment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = texture;
    scene.environmentIntensity = 0.45;
    invalidate();
    return () => {
      scene.environment = null;
      texture.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

function Lattice({ stage, playing, data, reducedMotion, highlight, onHover, labels }: LatticeProps) {
  const startedAt = useRef(performance.now());

  useEffect(() => {
    startedAt.current = performance.now();
    invalidate();
  }, [stage, playing]);
  useEffect(() => void invalidate(), [data, reducedMotion, highlight]);

  const assets = useMemo(() => {
    const { facets, circumradius } = icosahedronFacets(CORE_R);
    const zone = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const hexFrame = new THREE.CylinderGeometry(0.8, 0.8, 1.75, 6, 1, true);
    const wall = wallPanel(WALL_W, WALL_H, WALL_CY, CORE_Y, GATE_R);
    return {
      colors: {
        bone: new THREE.Color(PALETTE.bone),
        rust: new THREE.Color(PALETTE.rust),
        moss: new THREE.Color(PALETTE.moss),
        amber: new THREE.Color(PALETTE.amber),
        graphite: new THREE.Color("#2b2a25"),
        failing: new THREE.Color("#743629"),
      },
      facets,
      plate: facetPlate(circumradius * 0.9, 0.075, 0.2),
      lattice: new THREE.EdgesGeometry(new THREE.DodecahedronGeometry(0.62, 0)),
      cage: new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.66, 1)),
      wall,
      wallEdges: new THREE.EdgesGeometry(wall, 30),
      blade: irisBlade(GATE_R),
      probes: Array.from({ length: PROBE_LINES }, (_, i) =>
        probeLine(WALL_W - 0.16, FLOOR_Y + 0.35 + (i * (WALL_H - 0.6)) / (PROBE_LINES - 1), CORE_Y, GATE_R),
      ),
      zone,
      zoneEdges: new THREE.EdgesGeometry(zone),
      cellFrame: new THREE.EdgesGeometry(hexFrame),
      cellLevel: new THREE.EdgesGeometry(new THREE.CircleGeometry(0.8, 6).rotateX(-Math.PI / 2)),
      cellBase: new THREE.CylinderGeometry(0.92, 0.92, 0.05, 6),
      shadow: shadowTexture(),
      packet: new THREE.SphereGeometry(0.055, 16, 12),
      finding: new THREE.BoxGeometry(0.1, 0.1, 0.1),
      node: new THREE.SphereGeometry(0.028, 10, 8),
      facetMaterial: new THREE.MeshPhysicalMaterial({
        color: "#ffffff",
        metalness: 0.68,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.18,
        side: THREE.DoubleSide,
      }),
      wallMaterial: new THREE.MeshPhysicalMaterial({
        color: "#2b2a25",
        metalness: 0.1,
        roughness: 0.42,
        clearcoat: 0.5,
        transparent: true,
        opacity: 0.38,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      metal: new THREE.MeshPhysicalMaterial({ color: "#3a3833", metalness: 0.8, roughness: 0.32, clearcoat: 0.6 }),
      bladeMaterial: new THREE.MeshPhysicalMaterial({
        color: "#4a4741",
        metalness: 0.85,
        roughness: 0.26,
        clearcoat: 0.8,
        side: THREE.DoubleSide,
      }),
      baseMaterial: new THREE.MeshPhysicalMaterial({
        color: "#161513",
        metalness: 0.4,
        roughness: 0.5,
        clearcoat: 0.4,
        envMapIntensity: 0.3,
      }),
      // Lambert (no specular): a standard material reflects the environment at this grazing
      // camera angle and the floor washes out to grey whatever its colour.
      zoneMaterials: {
        red: new THREE.MeshLambertMaterial({ color: "#1a1311" }),
        target: new THREE.MeshLambertMaterial({ color: "#151514" }),
        blue: new THREE.MeshLambertMaterial({ color: "#121611" }),
      },
      channelMaterial: new THREE.LineDashedMaterial({
        color: PALETTE.bone,
        dashSize: 0.07,
        gapSize: 0.09,
        transparent: true,
        opacity: 0.3,
      }),
      hitMaterial: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    };
  }, []);

  const channels = useMemo(
    () => [
      dashedLine([v(-CELL_X), v(-CORE_R)], assets.channelMaterial),
      dashedLine([v(CORE_R), v(CELL_X)], assets.channelMaterial),
    ],
    [assets],
  );

  // Per-instance materials that animate independently.
  const mats = useMemo(() => {
    const line = (color: string, opacity: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const role = (color: string) =>
      new THREE.MeshPhysicalMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.12,
        metalness: 0.4,
        roughness: 0.32,
        clearcoat: 0.9,
      });
    return {
      lattice: line(PALETTE.bone, 0.22),
      cage: line(PALETTE.bone, 0.1),
      wallEdges: [line(PALETTE.bone, 0.22), line(PALETTE.bone, 0.22)],
      probes: [0, 1].map(() => Array.from({ length: PROBE_LINES }, () => line(PALETTE.bone, 0.06))),
      gateways: [0, 1].map(
        () => new THREE.MeshStandardMaterial({ color: PALETTE.bone, emissive: PALETTE.bone, emissiveIntensity: 0.1 }),
      ),
      zoneEdges: { red: line(PALETTE.rust, 0.34), target: line(PALETTE.bone, 0.2), blue: line(PALETTE.moss, 0.34) },
      redFrame: line(PALETTE.rust, 0.5),
      blueFrame: line(PALETTE.moss, 0.5),
      redSolid: role("#8a4639"),
      blueSolid: role("#5d6b47"),
      nucleus: new THREE.MeshStandardMaterial({ color: PALETTE.boneBright, emissive: PALETTE.boneBright, emissiveIntensity: 0.5 }),
      evaluator: new THREE.MeshBasicMaterial({ color: PALETTE.bone, transparent: true, opacity: 0.3 }),
      scan: new THREE.MeshBasicMaterial({
        color: PALETTE.bone,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      rings: Array.from(
        { length: MAX_RINGS },
        () =>
          new THREE.MeshStandardMaterial({
            color: PALETTE.moss,
            emissive: PALETTE.moss,
            emissiveIntensity: 0.35,
            metalness: 0.4,
            roughness: 0.3,
            transparent: true,
          }),
      ),
      packets: Array.from(
        { length: MAX_PACKETS },
        () => new THREE.MeshBasicMaterial({ color: PALETTE.rust, transparent: true, toneMapped: false }),
      ),
      trails: Array.from(
        { length: MAX_PACKETS },
        () => new THREE.MeshBasicMaterial({ color: PALETTE.rust, transparent: true, opacity: 0.35, toneMapped: false }),
      ),
      findings: Array.from(
        { length: MAX_PACKETS },
        () => new THREE.MeshBasicMaterial({ color: PALETTE.bone, transparent: true, toneMapped: false }),
      ),
    };
  }, []);

  useEffect(
    () => () => {
      const dispose = (item: unknown): void => {
        if (item instanceof THREE.BufferGeometry || item instanceof THREE.Material || item instanceof THREE.Texture) {
          item.dispose();
        } else if (Array.isArray(item)) {
          item.forEach(dispose);
        } else if (item && typeof item === "object" && !(item instanceof THREE.Color)) {
          Object.values(item).forEach(dispose);
        }
      };
      dispose(assets);
      dispose(mats);
      channels.forEach((line) => line.geometry.dispose());
    },
    [assets, mats, channels],
  );

  const facetsRef = useRef<THREE.InstancedMesh>(null);
  const latticeRef = useRef<THREE.LineSegments>(null);
  const cageRef = useRef<THREE.LineSegments>(null);
  const evaluatorRef = useRef<THREE.Group>(null);
  const coreLightRef = useRef<THREE.PointLight>(null);
  const roleLightRefs = useRef<Record<"red" | "blue", THREE.PointLight | null>>({ red: null, blue: null });
  const soloRefs = useRef<Record<"red" | "blue", THREE.Mesh | null>>({ red: null, blue: null });
  const ringRefs = useRef<(THREE.Mesh | null)[]>([]);
  const bladeRefs = useRef<(THREE.Mesh | null)[][]>([[], []]);
  const packetRefs = useRef<(THREE.Mesh | null)[]>([]);
  const trailRefs = useRef<(THREE.Mesh | null)[]>([]);
  const findingRefs = useRef<(THREE.Mesh | null)[]>([]);
  const scratch = useMemo(
    () => ({
      camera: new THREE.Vector3(),
      look: new THREE.Vector3(),
      currentLook: HERO.look.clone(),
      point: new THREE.Vector3(),
      color: new THREE.Color(),
      matrix: new THREE.Matrix4(),
    }),
    [],
  );

  useFrame((state, rawDelta) => {
    const { camera, size } = state;
    const delta = Math.min(rawDelta, 1 / 30);
    const animate = playing && !reducedMotion;
    const duration = stage in STAGE_MS ? (STAGE_MS[stage as keyof typeof STAGE_MS] / 1000) * 0.92 : 1;
    const p = animate ? clamp01((performance.now() - startedAt.current) / 1000 / duration) : 1;
    const index = SCENE_ORDER.indexOf(stage);
    const reached = (s: SceneStage) => index >= SCENE_ORDER.indexOf(s);
    const at = (s: SceneStage) => stage === s;
    // Activity (gates, probes, glows) shows only while that stage is playing; recorded
    // state (facet colours, rings, evaluator) shows whenever the run has reached it.
    const live = (s: SceneStage) => playing && stage === s;
    const { bone, rust, moss, amber, graphite, failing } = assets.colors;
    let needsFrame = animate && p < 1;

    // Camera: fitted to the panel width, moved to a framing per playing stage, damped.
    // Narrow panels get a smaller move so the role zones stay in frame.
    const aspect = size.width / size.height;
    const distance = Math.min(24, Math.max(10.8, 18.6 / aspect));
    const reach = clamp01((aspect - 0.8) / 0.7);
    const framing = (playing && !reducedMotion && FRAMING[stage]) || HERO;
    const px = reducedMotion ? 0 : state.pointer.x;
    const py = reducedMotion ? 0 : state.pointer.y;
    scratch.camera.set(
      THREE.MathUtils.lerp(HERO.x, framing.x, reach) + px * 0.6,
      THREE.MathUtils.lerp(HERO.y, framing.y, reach) + py * 0.35,
      distance * (1 + (framing.zoom - 1) * reach),
    );
    scratch.look.lerpVectors(HERO.look, framing.look, reach);
    const damping = reducedMotion ? 1 : 1 - Math.exp(-delta * 2.2);
    camera.position.lerp(scratch.camera, damping);
    scratch.currentLook.lerp(scratch.look, damping);
    camera.lookAt(scratch.currentLook);
    if (state.scene.fog instanceof THREE.Fog) {
      state.scene.fog.near = distance + 1.5;
      state.scene.fog.far = distance + 15;
    }
    if (camera.position.distanceToSquared(scratch.camera) > 1e-5 || scratch.currentLook.distanceToSquared(scratch.look) > 1e-6) {
      needsFrame = true;
    }

    // Core facets: they part while the target responds, and their colour carries the
    // real failure share: baseline failures sweep in with the evaluator, then cross-fade
    // to residual failures during retest.
    const respond = live("respond") ? (animate ? bump(p, 0, 1) : 0.5) : 0;
    const cases = Math.max(1, data.cases);
    const baselineCount = Math.round((20 * data.baselineFailures) / cases);
    const residualCount = Math.round((20 * data.retestFailures) / cases);
    const facets = facetsRef.current;
    if (facets) {
      assets.facets.forEach((facet, i) => {
        const baseline = marked(facet.order, baselineCount, 20) ? 1 : 0;
        const residual = marked(facet.order, residualCount, 20) ? 1 : 0;
        let tint = 0;
        if (at("evaluate")) tint = baseline * clamp01((p * 26 - facet.order) / 4);
        else if (at("defend")) tint = baseline;
        else if (at("retest")) tint = THREE.MathUtils.lerp(baseline, residual, smooth(0.55, 0.9, p));
        else if (reached("isolation")) tint = residual;
        const lift = 1 + 0.11 * respond + (highlight === "target" ? 0.025 : 0);
        scratch.point.copy(facet.centroid).multiplyScalar(lift);
        facets.setMatrixAt(i, scratch.matrix.copy(facet.basis).setPosition(scratch.point));
        facets.setColorAt(i, scratch.color.copy(graphite).lerp(failing, tint * 0.9));
      });
      facets.instanceMatrix.needsUpdate = true;
      if (facets.instanceColor) facets.instanceColor.needsUpdate = true;
    }
    mats.nucleus.emissiveIntensity = 0.5 + 1.8 * respond;
    const residualTint = reached("report") && data.retestFailures ? 0.45 : 0;
    mats.nucleus.emissive.copy(bone).lerp(rust, residualTint);
    if (coreLightRef.current) coreLightRef.current.intensity = 1.2 + 8 * respond;
    if (animate) {
      if (latticeRef.current) latticeRef.current.rotation.y -= delta * 0.25;
      if (cageRef.current) cageRef.current.rotation.y += delta * 0.08;
    }
    mats.lattice.opacity = 0.18 + 0.5 * respond + (highlight === "target" ? 0.25 : 0);

    // Evaluator: a ring and faint scan plane sweep the core top to bottom, then rest.
    const evaluator = evaluatorRef.current;
    if (evaluator) {
      evaluator.visible = reached("evaluate");
      const scanning = at("evaluate") && animate;
      evaluator.position.y = CORE_Y + (scanning ? 0.9 * Math.cos(Math.PI * p) : 0);
      mats.evaluator.opacity = at("evaluate") ? 0.85 : 0.28;
      mats.scan.opacity = scanning ? 0.07 * bump(p, 0, 1) : 0;
    }

    // Defense rings: one per applied rule, assembled while the Blue Team defends.
    const ringCount = Math.min(data.defenses, MAX_RINGS);
    const blockFlash = at("retest") && data.retestBlocked ? (animate ? bump(p, 0.32, 0.72) : 0) : 0;
    ringRefs.current.forEach((ring, i) => {
      if (!ring) return;
      let shown = 0;
      if (i < ringCount && reached("defend")) {
        shown = at("defend") && animate ? easeOut(clamp01((p - 0.5 - i * 0.09) / 0.32)) : 1;
      }
      ring.visible = shown > 0.001;
      ring.scale.setScalar(0.6 + 0.4 * shown);
      if (animate) ring.rotation.z += delta * (i % 2 ? 0.2 : -0.2);
      const material = mats.rings[i];
      material.opacity = 0.85 * shown;
      material.color.copy(moss).lerp(amber, blockFlash);
      material.emissive.copy(material.color);
    });

    // Gateways: iris shutters open only for the stage that uses them. The Red gate opens
    // for attack and retest traffic; the Blue gate opens part-way for redacted findings.
    const gates = [
      live("attack") || live("retest") ? (animate ? window4(p, 0, 0.1, 0.8, 0.94) : 1) : 0,
      live("defend") ? (animate ? 0.55 * window4(p, 0, 0.08, 0.42, 0.55) : 0.55) : 0,
    ];
    bladeRefs.current.forEach((blades, side) =>
      blades.forEach((blade) => blade?.scale.set(Math.max(0.02, 1 - gates[side]), 1, 1)),
    );

    // Walls: probe lines light in sequence while isolation probes run; the gateway ring
    // and wall edge follow. Colour comes from the recorded isolation result.
    const probeColor = data.isolationOk === false ? rust : moss;
    [0, 1].forEach((side) => {
      let wallGlow = 0;
      mats.probes[side].forEach((material, j) => {
        const start = side * 0.4 + j * 0.05;
        const k = live("isolation") ? (animate ? bump(p, start, start + 0.3) : 0.6) : 0;
        material.color.copy(bone).lerp(probeColor, k);
        material.opacity = 0.06 + 0.7 * k;
        wallGlow = Math.max(wallGlow, k);
      });
      mats.wallEdges[side].color.copy(bone).lerp(probeColor, wallGlow);
      mats.wallEdges[side].opacity = 0.22 + 0.4 * wallGlow;
      const gateActive = Math.max(gates[side], wallGlow);
      mats.gateways[side].emissive.copy(bone).lerp(gates[side] > wallGlow ? (side ? moss : rust) : probeColor, gateActive);
      mats.gateways[side].emissiveIntensity = 0.1 + 0.9 * gateActive;
    });

    // Role zones: a cell's light, solid and floor outline respond only to its own stage.
    const redPlaying = live("attack") || live("retest");
    const redActive = redPlaying ? (animate ? bump(p, 0, 0.7) : 0.5) : 0;
    const blueActive = live("defend") ? (animate ? bump(p, 0.2, 0.9) : 0.5) : 0;
    const roles = [
      ["red", redActive, mats.redSolid, mats.redFrame] as const,
      ["blue", blueActive, mats.blueSolid, mats.blueFrame] as const,
    ];
    for (const [role, active, solid, frame] of roles) {
      const lit = Math.max(active, highlight === role ? 0.45 : 0);
      solid.emissiveIntensity = 0.12 + 0.9 * active;
      frame.opacity = 0.45 + 0.55 * lit;
      mats.zoneEdges[role].opacity = 0.34 + 0.6 * lit;
      const light = roleLightRefs.current[role];
      if (light) light.intensity = 0.15 + 3.2 * lit;
      const solo = soloRefs.current[role];
      if (solo && animate && active > 0) solo.rotation.y += delta * 0.9 * active;
    }
    mats.zoneEdges.target.opacity = highlight === "target" ? 0.7 : 0.2 + 0.3 * respond;

    // Red Team packets with short trails: attack, then retest (blocked ones stop at the rings).
    const packetCount = Math.min(data.cases, MAX_PACKETS);
    packetRefs.current.forEach((packet, i) => {
      const trail = trailRefs.current[i];
      if (!packet || !trail) return;
      packet.visible = trail.visible = false;
      if (!animate || i >= packetCount || !(at("attack") || at("retest"))) return;
      const blocked = at("retest") && i < data.retestBlocked;
      const path = blocked ? PATH_RED_SHIELD : PATH_RED_CORE;
      const raw = (p - 0.08 - i * 0.06) / 0.48;
      const material = mats.packets[i];
      if (raw > 0 && raw < 1) {
        packet.visible = trail.visible = true;
        along(path, easeInOut(raw), packet.position);
        along(path, easeInOut(Math.max(0, raw - 0.07)), trail.position);
        packet.scale.setScalar(1);
        material.color.copy(rust);
        material.opacity = 1;
      } else if (blocked && raw >= 1 && raw < 1.3) {
        packet.visible = true;
        packet.position.copy(PATH_RED_SHIELD[2]);
        packet.scale.setScalar(1 + (raw - 1) * 7);
        material.color.copy(amber);
        material.opacity = 1 - (raw - 1) / 0.3;
      }
    });

    // Findings: leave the core, pass the narrowed Blue gateway (flattened, recoloured), reach Blue.
    const findings = Math.min(data.baselineFailures, MAX_PACKETS);
    findingRefs.current.forEach((finding, i) => {
      if (!finding) return;
      const raw = (p - 0.04 - i * 0.045) / 0.4;
      finding.visible = animate && at("defend") && i < findings && raw > 0 && raw < 1;
      if (!finding.visible) return;
      along(PATH_CORE_BLUE, easeInOut(raw), finding.position);
      const redacted = finding.position.x > WALL_X;
      finding.scale.set(1, redacted ? 0.22 : 1, redacted ? 1.4 : 1);
      mats.findings[i].color.copy(redacted ? moss : bone);
    });

    // Screen-space anchors for the HTML labels.
    for (const [role, anchor] of LABEL_ANCHORS) {
      const element = labels.current?.[role];
      if (!element) continue;
      const point = scratch.point.copy(anchor).project(camera);
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      element.style.opacity = "1";
    }

    if (needsFrame) invalidate();
  });

  const hover = (role: Role | null) => (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(role);
  };

  const zone = (role: Role, x: number, width: number) => (
    <group position={[x, FLOOR_Y + 0.004, 0]} scale={[width, 1, ZONE_D]}>
      <mesh geometry={assets.zone} material={assets.zoneMaterials[role]} receiveShadow />
      <lineSegments geometry={assets.zoneEdges} material={mats.zoneEdges[role]} position={[0, 0.003, 0]} />
    </group>
  );

  const cell = (role: "red" | "blue", x: number) => (
    <group position={[x, CORE_Y, 0]}>
      <lineSegments geometry={assets.cellFrame} material={role === "red" ? mats.redFrame : mats.blueFrame} />
      {[-0.875, -0.3, 0.3, 0.875].map((y) => (
        <lineSegments key={y} geometry={assets.cellLevel} material={role === "red" ? mats.redFrame : mats.blueFrame} position={[0, y, 0]} />
      ))}
      <mesh
        ref={(mesh) => {
          soloRefs.current[role] = mesh;
        }}
        material={role === "red" ? mats.redSolid : mats.blueSolid}
        rotation={[0.4, 0.5, 0]}
        castShadow
      >
        {role === "red" ? <octahedronGeometry args={[0.36, 0]} /> : <dodecahedronGeometry args={[0.32, 0]} />}
      </mesh>
      <pointLight
        ref={(light) => {
          roleLightRefs.current[role] = light;
        }}
        color={role === "red" ? PALETTE.rust : PALETTE.moss}
        position={[0, FLOOR_Y - CORE_Y + 0.35, 0]}
        distance={3.6}
        decay={2}
      />
      <mesh geometry={assets.cellBase} material={assets.baseMaterial} position={[0, FLOOR_Y - CORE_Y + 0.03, 0]} receiveShadow />
      <mesh material={assets.hitMaterial} onPointerOver={hover(role)} onPointerOut={hover(null)}>
        <boxGeometry args={[1.7, 1.9, 1.7]} />
      </mesh>
    </group>
  );

  return (
    <>
      <gridHelper args={[40, 80, "#22211e", "#181816"]} position={[0, FLOOR_Y - 0.002, 0]} />
      {zone("red", -(WALL_X + (CELL_X + 1.35 - WALL_X) / 2), CELL_X + 1.35 - WALL_X)}
      {zone("target", 0, WALL_X * 2)}
      {zone("blue", WALL_X + (CELL_X + 1.35 - WALL_X) / 2, CELL_X + 1.35 - WALL_X)}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y + 0.01, 0]}>
        <planeGeometry args={[3.4, 3.4]} />
        <meshBasicMaterial map={assets.shadow} transparent depthWrite={false} />
      </mesh>

      {channels.map((line, i) => (
        <primitive key={i} object={line} />
      ))}

      {/* Target core: instanced bevelled facets around an inner lattice and nucleus */}
      <group position={[0, CORE_Y, 0]}>
        <instancedMesh ref={facetsRef} args={[assets.plate, assets.facetMaterial, 20]} castShadow />
        <lineSegments ref={latticeRef} geometry={assets.lattice} material={mats.lattice} />
        <mesh material={mats.nucleus}>
          <icosahedronGeometry args={[0.26, 3]} />
        </mesh>
        <pointLight ref={coreLightRef} color={PALETTE.boneBright} distance={3.4} decay={2} />
        <lineSegments ref={cageRef} geometry={assets.cage} material={mats.cage} />
        <mesh material={assets.hitMaterial} onPointerOver={hover("target")} onPointerOut={hover(null)}>
          <sphereGeometry args={[1.3, 16, 12]} />
        </mesh>
      </group>

      <group ref={evaluatorRef} position={[0, CORE_Y, 0]} visible={false}>
        <mesh material={mats.evaluator} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.14, 0.007, 6, 160]} />
        </mesh>
        <mesh material={mats.scan} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.14, 64]} />
        </mesh>
      </group>

      {RING_TILTS.map((tilt, i) => (
        <mesh
          key={i}
          ref={(mesh) => {
            ringRefs.current[i] = mesh;
          }}
          material={mats.rings[i]}
          rotation={tilt}
          position={[0, CORE_Y, 0]}
          visible={false}
        >
          <torusGeometry args={[SHIELD_R + i * 0.035, 0.011, 8, 180, Math.PI * 2 * 0.9]} />
          <mesh
            geometry={assets.node}
            material={mats.rings[i]}
            position={[Math.cos(Math.PI * 1.8) * (SHIELD_R + i * 0.035), Math.sin(Math.PI * 1.8) * (SHIELD_R + i * 0.035), 0]}
          />
        </mesh>
      ))}

      {/* Isolation walls: framed translucent panels, probe lines and one iris gateway each */}
      {[-1, 1].map((side, i) => (
        <group key={side} position={[side * WALL_X, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <mesh geometry={assets.wall} material={assets.wallMaterial} renderOrder={2} />
          <lineSegments geometry={assets.wallEdges} material={mats.wallEdges[i]} />
          {assets.probes.map((geometry, j) => (
            <lineSegments key={j} geometry={geometry} material={mats.probes[i][j]} />
          ))}
          {/* frame */}
          <mesh material={assets.metal} position={[0, WALL_CY + WALL_H / 2, 0]} castShadow>
            <boxGeometry args={[WALL_W + 0.08, 0.06, 0.09]} />
          </mesh>
          <mesh material={assets.metal} position={[0, FLOOR_Y + 0.03, 0]} castShadow>
            <boxGeometry args={[WALL_W + 0.08, 0.06, 0.12]} />
          </mesh>
          {[-1, 1].map((edge) => (
            <mesh key={edge} material={assets.metal} position={[(edge * (WALL_W + 0.02)) / 2, WALL_CY, 0]} castShadow>
              <boxGeometry args={[0.06, WALL_H, 0.09]} />
            </mesh>
          ))}
          {/* gateway */}
          <mesh material={mats.gateways[i]} position={[0, CORE_Y, 0]}>
            <torusGeometry args={[GATE_R, 0.018, 10, 72]} />
          </mesh>
          {Array.from({ length: 6 }, (_, b) => {
            const angle = (b * Math.PI) / 3;
            const h = GATE_R * Math.cos(Math.PI / 6);
            return (
              <mesh
                key={b}
                ref={(mesh) => {
                  bladeRefs.current[i][b] = mesh;
                }}
                geometry={assets.blade}
                material={assets.bladeMaterial}
                position={[Math.cos(angle) * h, CORE_Y + Math.sin(angle) * h, 0]}
                rotation={[0, 0, angle]}
                castShadow
              />
            );
          })}
        </group>
      ))}

      {cell("red", -CELL_X)}
      {cell("blue", CELL_X)}

      {mats.packets.map((material, i) => (
        <mesh
          key={i}
          ref={(mesh) => {
            packetRefs.current[i] = mesh;
          }}
          geometry={assets.packet}
          material={material}
          visible={false}
        />
      ))}
      {mats.trails.map((material, i) => (
        <mesh
          key={i}
          ref={(mesh) => {
            trailRefs.current[i] = mesh;
          }}
          geometry={assets.packet}
          material={material}
          scale={0.6}
          visible={false}
        />
      ))}
      {mats.findings.map((material, i) => (
        <mesh
          key={i}
          ref={(mesh) => {
            findingRefs.current[i] = mesh;
          }}
          geometry={assets.finding}
          material={material}
          visible={false}
        />
      ))}
    </>
  );
}

export default function LatticeCanvas(props: LatticeProps) {
  return (
    <Canvas
      frameloop="demand"
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 30, position: [HERO.x, HERO.y, 15], near: 0.1, far: 60 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onPointerMove={() => invalidate()}
      onPointerLeave={() => {
        props.onHover(null);
        invalidate();
      }}
      aria-hidden
    >
      <color attach="background" args={[PALETTE.background]} />
      <fog attach="fog" args={[PALETTE.background, 12, 26]} />
      <Environment />
      <ambientLight intensity={0.28} color="#e9e2d2" />
      <directionalLight
        position={[-5, 8, 6]}
        intensity={2.3}
        color="#fff1dc"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={1}
        shadow-camera-far={25}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[6, 3, -5]} intensity={1.0} color="#c8d0bd" />
      <directionalLight position={[0, -4, 3]} intensity={0.2} color="#8c8677" />
      <Lattice {...props} />
    </Canvas>
  );
}
