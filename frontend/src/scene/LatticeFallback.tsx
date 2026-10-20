// Static SVG schematic of the lattice for devices without WebGL, and while the 3D chunk loads.
// It shows the same topology and the same recorded state as the 3D scene, without motion.

import { PALETTE, SCENE_ORDER, type Role, type SceneData, type SceneStage } from "./model";

function hexagon(cx: number, cy: number, r: number, rotate = -Math.PI / 2) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i + rotate;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
  });
}

const points = (corners: readonly (readonly [number, number])[]) => corners.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

export function LatticeFallback({ stage, data, highlight }: { stage: SceneStage; data: SceneData; highlight: Role | null }) {
  const reached = (s: SceneStage) => SCENE_ORDER.indexOf(stage) >= SCENE_ORDER.indexOf(s);
  const rings = reached("defend") ? Math.min(data.defenses, 5) : 0;
  // Same rule as the 3D facets: baseline failure share until retest, residual share after.
  const failures = reached("retest") ? data.retestFailures : reached("evaluate") ? data.baselineFailures : 0;
  const failing = Math.round((6 * failures) / Math.max(1, data.cases));
  const core = hexagon(480, 210, 86);
  const zoneOpacity = (role: Role) => (highlight === role ? 0.75 : 0.3);

  return (
    <svg viewBox="0 0 960 440" className="h-full w-full" role="img" aria-label="Isolation lattice schematic">
      <rect width="960" height="440" fill={PALETTE.background} />
      {/* floor zones */}
      <rect x="40" y="340" width="290" height="24" fill="#1c1715" stroke={PALETTE.rust} strokeOpacity={zoneOpacity("red")} />
      <rect x="330" y="340" width="300" height="24" fill="#191917" stroke={PALETTE.bone} strokeOpacity={zoneOpacity("target") * 0.7} />
      <rect x="630" y="340" width="290" height="24" fill="#171a16" stroke={PALETTE.moss} strokeOpacity={zoneOpacity("blue")} />
      {/* channels: Red → gateway → core, core → gateway → Blue. No Red↔Blue path. */}
      <line x1="190" y1="210" x2="394" y2="210" stroke={PALETTE.bone} strokeOpacity="0.32" strokeDasharray="5 6" />
      <line x1="566" y1="210" x2="770" y2="210" stroke={PALETTE.bone} strokeOpacity="0.32" strokeDasharray="5 6" />
      {[330, 630].map((x) => (
        <g key={x}>
          <rect x={x - 3} y="78" width="6" height="262" fill="#2b2a25" stroke={PALETTE.bone} strokeOpacity="0.3" />
          <polygon points={points(hexagon(x, 210, 22, 0))} fill="#4a4741" stroke={PALETTE.bone} strokeOpacity="0.6" />
        </g>
      ))}
      {Array.from({ length: rings }, (_, i) => (
        <ellipse
          key={i}
          cx="480"
          cy="210"
          rx={132 - i * 4}
          ry={(132 - i * 4) * (i % 2 ? 0.42 : 1)}
          transform={`rotate(${i * 36} 480 210)`}
          fill="none"
          stroke={PALETTE.moss}
          strokeOpacity="0.7"
          strokeDasharray={i % 2 ? "2 5" : undefined}
        />
      ))}
      {reached("evaluate") && <ellipse cx="480" cy="210" rx="112" ry="20" fill="none" stroke={PALETTE.bone} strokeOpacity="0.4" />}
      {core.map((corner, i) => (
        <polygon
          key={i}
          points={points([[480, 210], corner, core[(i + 1) % 6]])}
          fill={i < failing ? "#743629" : PALETTE.graphite}
          stroke={PALETTE.bone}
          strokeOpacity={highlight === "target" ? 0.7 : 0.35}
        />
      ))}
      <circle cx="480" cy="210" r="15" fill={PALETTE.boneBright} fillOpacity="0.85" />
      <polygon points={points(hexagon(150, 210, 62))} fill="none" stroke={PALETTE.rust} strokeOpacity={highlight === "red" ? 1 : 0.7} />
      <polygon points={points(hexagon(150, 210, 22))} fill="#8a4639" />
      <polygon points={points(hexagon(810, 210, 62))} fill="none" stroke={PALETTE.moss} strokeOpacity={highlight === "blue" ? 1 : 0.7} />
      <polygon points={points(hexagon(810, 210, 22))} fill="#5d6b47" />
      <g fontFamily="JetBrains Mono, monospace" fontSize="11" letterSpacing="1.5" fill={PALETTE.bone}>
        <text x="150" y="122" textAnchor="middle">RED TEAM</text>
        <text x="480" y="100" textAnchor="middle">TARGET LLM</text>
        <text x="810" y="122" textAnchor="middle">BLUE TEAM</text>
      </g>
    </svg>
  );
}
