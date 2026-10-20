import { STAGES, type RunDetail, type Stage } from "../api";
import { STAGE_INFO, STAGE_ORDER, stageMetric } from "./ui";

type NodeState = "done" | "active" | "pending";

const STATE_TEXT: Record<NodeState, string> = { done: "completed", active: "running", pending: "pending" };

function nodeState(run: RunDetail | null, playing: Stage | null, stage: Stage): NodeState {
  if (!run || run.stage === "created") return "pending";
  if (playing === stage) return "active";
  return STAGE_ORDER[run.stage] >= STAGE_ORDER[stage] ? "done" : "pending";
}

/**
 * Execution pipeline. Each node reflects a stage the backend has actually executed.
 * Compact one-line rows below `lg`, a horizontal track from `lg` up.
 */
export function Pipeline({ run, playing }: { run: RunDetail | null; playing: Stage | null }) {
  return (
    <ol className="grid grid-cols-1 lg:grid-cols-7">
      {STAGES.map((stage, i) => {
        const state = nodeState(run, playing, stage);
        const metric = run ? stageMetric(run, stage) : null;
        const info = STAGE_INFO[stage];
        const last = i === STAGES.length - 1;
        return (
          <li
            key={stage}
            className="relative grid grid-cols-[11px_26px_1fr_auto] items-center gap-x-3 py-3 lg:block lg:py-0 lg:pr-4"
          >
            {!last && (
              <>
                <span aria-hidden className="absolute top-[calc(50%+8px)] left-[5px] h-[calc(100%-16px)] w-px bg-ink-600 lg:hidden" />
                <span aria-hidden className="absolute top-[5px] right-0 left-[18px] hidden h-px bg-ink-600 lg:block" />
                {state !== "pending" && (
                  <>
                    <span
                      key={`${run?.id}-v`}
                      aria-hidden
                      className="draw-down absolute top-[calc(50%+8px)] left-[5px] h-[calc(100%-16px)] w-px bg-bone-400 lg:hidden"
                    />
                    <span
                      key={`${run?.id}-h`}
                      aria-hidden
                      className="sweep absolute top-[5px] right-0 left-[18px] hidden h-px bg-bone-400 lg:block"
                    />
                  </>
                )}
              </>
            )}
            <span
              aria-hidden
              className={`relative z-10 block size-[11px] border transition-colors duration-500 ${
                state === "active"
                  ? "border-moss-300 bg-moss-400"
                  : state === "done"
                    ? "border-bone-200 bg-bone-200"
                    : "border-ink-500 bg-ink-950"
              }`}
            />
            <p className="label flex items-center gap-2 lg:mt-4">
              0{i + 1}
              {state === "active" && <span className="live-dot size-1 bg-moss-300" aria-hidden />}
            </p>
            <div className="flex min-w-0 items-baseline gap-2.5 lg:mt-1.5 lg:block">
              <p
                className={`text-[15px] font-medium tracking-tight transition-colors duration-500 ${
                  state === "pending" ? "text-bone-500" : "text-bone-50"
                }`}
              >
                {info.title}
                <span className="sr-only">, {STATE_TEXT[state]}</span>
              </p>
              <p className="truncate text-[12px] text-bone-500 lg:mt-0.5">{info.actor}</p>
            </div>
            <p
              className={`text-right font-mono text-[11px] transition-opacity duration-500 lg:mt-2 lg:text-left ${
                metric ? "text-bone-200 opacity-100" : "opacity-0"
              }`}
            >
              {metric ?? <span aria-hidden>·</span>}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
