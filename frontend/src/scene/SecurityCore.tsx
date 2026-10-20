import { Component, Suspense, lazy, useMemo, useRef, useState, type ReactNode } from "react";

import type { RunDetail } from "../api";
import { STAGE_INFO, stageMetric } from "../components/ui";
import { useReducedMotion } from "../hooks";
import { useLab } from "../lab";
import { LatticeFallback } from "./LatticeFallback";
import { ROLE_COPY, sceneData, type Role, type SceneStage } from "./model";

const LatticeCanvas = lazy(() => import("./LatticeCanvas"));

const ROLES = Object.keys(ROLE_COPY) as Role[];
const ROLE_SWATCH: Record<Role, string> = { red: "bg-rust-400", target: "bg-bone-200", blue: "bg-moss-400" };

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** One line describing what the lattice is showing, from recorded run data only. */
function readout(run: RunDetail | null, stage: SceneStage, playing: boolean): string {
  if (!run) return "No runs yet";
  if (playing && stage !== "idle" && stage !== "created") {
    return `${STAGE_INFO[stage].title} · ${stageMetric(run, stage) ?? STAGE_INFO[stage].actor}`;
  }
  if (run.report) {
    const { counts, audit } = run.report;
    return `${counts.residual_failures}/${counts.cases} residual · ${run.defenses.length} rules · chain ${audit.ok ? "intact" : "broken"}`;
  }
  return `Paused after ${run.stage}`;
}

export function SecurityCore({ run, stage, playing }: { run: RunDetail | null; stage: SceneStage; playing: boolean }) {
  const reducedMotion = useReducedMotion();
  const { meta } = useLab();
  const [webgl] = useState(hasWebGL);
  const [hovered, setHovered] = useState<Role | null>(null); // pointer over a cell or legend item
  const [selected, setSelected] = useState<Role | null>(null); // pinned by click, tap or keyboard
  const labels = useRef<Record<Role, HTMLElement | null>>({ red: null, target: null, blue: null });
  const data = useMemo(() => sceneData(run), [run]);
  const highlight = hovered ?? selected;
  const permissions = highlight ? meta?.permissions[highlight] : undefined;
  const fallback = <LatticeFallback stage={stage} data={data} highlight={highlight} />;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#121210]">
        {webgl ? (
          <SceneBoundary fallback={fallback}>
            <Suspense fallback={fallback}>
              <LatticeCanvas
                stage={stage}
                playing={playing}
                data={data}
                reducedMotion={reducedMotion}
                highlight={highlight}
                onHover={setHovered}
                labels={labels}
              />
            </Suspense>
          </SceneBoundary>
        ) : (
          fallback
        )}

        {webgl &&
          ROLES.map((role) => (
            <div
              key={role}
              ref={(element) => {
                labels.current[role] = element;
              }}
              className="pointer-events-none absolute top-0 left-0 flex flex-col items-center opacity-0 transition-opacity duration-500"
              aria-hidden
            >
              <span className={`label transition-colors ${highlight === role ? "text-bone-50" : ""}`}>{ROLE_COPY[role].name}</span>
              <span className="font-mono text-[9.5px] tracking-[0.14em] text-bone-500 uppercase">{ROLE_COPY[role].zone}</span>
              <span className={`mt-1.5 h-4 w-px transition-colors ${highlight === role ? "bg-bone-400" : "bg-ink-500"}`} />
            </div>
          ))}

        <div
          className={`pointer-events-none absolute bottom-3 left-3 max-w-[19rem] border border-ink-600 bg-ink-900/95 p-3.5 transition-[opacity,transform] duration-300 sm:bottom-4 sm:left-4 ${
            highlight ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
          }`}
          aria-live="polite"
        >
          {highlight && (
            <>
              <p className="label text-bone-200">{ROLE_COPY[highlight].name} · permissions</p>
              <p className="mt-2 text-[12.5px] leading-snug text-bone-400">{ROLE_COPY[highlight].summary}</p>
              {permissions && (
                <p className="mt-2.5 font-mono text-[10.5px] leading-relaxed text-moss-300">{permissions.join("  ")}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="hairline flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-3 py-2.5 sm:px-4">
        <div role="group" aria-label="Show a role's permissions" className="-ml-1.5 flex items-center">
          {ROLES.map((role) => (
            <button
              key={role}
              type="button"
              aria-pressed={selected === role}
              onClick={() => setSelected(selected === role ? null : role)}
              onMouseEnter={() => setHovered(role)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(role)}
              onBlur={() => setHovered(null)}
              className={`flex h-8 items-center gap-2 px-1.5 font-mono text-[10.5px] tracking-[0.12em] uppercase transition-colors ${
                highlight === role ? "text-bone-50" : "text-bone-500 hover:text-bone-200"
              }`}
            >
              <span className={`size-1.5 ${ROLE_SWATCH[role]}`} aria-hidden />
              {ROLE_COPY[role].name}
            </button>
          ))}
        </div>
        <p className="font-mono text-[10.5px] tracking-[0.1em] text-bone-400 uppercase">
          {readout(run, stage, playing)}
        </p>
      </div>
    </div>
  );
}
