import { STAGES, type RunDetail, type Stage } from "../api";
import { PLAIN_STAGE, STATE_LABEL, TONE_TEXT, stageResult, stageState, type StageState } from "../explain";

const NODE: Record<StageState, string> = {
  running: "border-moss-300 bg-moss-400",
  completed: "border-bone-200 bg-bone-200",
  failed: "border-rust-300 bg-rust-500",
  waiting: "border-ink-500 bg-ink-950",
};

const STATE_TONE: Record<StageState, string> = {
  running: "text-moss-300",
  completed: "text-bone-400",
  failed: "text-rust-300",
  waiting: "text-bone-500",
};

/**
 * Progress of one run through the seven real backend stages: plain name, the technical
 * role behind it, its state and the result recorded for it. The stages are explained
 * once, on How it works. Rows below `lg`, a horizontal track from `lg` up.
 */
export function Pipeline({ run, playing, failedAt }: { run: RunDetail | null; playing: Stage | null; failedAt: Stage | null }) {
  return (
    <ol className="grid grid-cols-1 lg:grid-cols-7">
      {STAGES.map((stage, i) => {
        const state = stageState(run, playing, stage, failedAt);
        const result = run ? stageResult(run, stage) : null;
        const info = PLAIN_STAGE[stage];
        const last = i === STAGES.length - 1;
        const lit = state === "completed" || state === "running";
        return (
          <li key={stage} className="relative grid grid-cols-[11px_1fr] gap-x-4 pb-6 lg:block lg:pr-5 lg:pb-0">
            {!last && (
              <>
                <span aria-hidden className="absolute top-4 bottom-0 left-[5px] w-px bg-ink-600 lg:hidden" />
                <span aria-hidden className="absolute top-[5px] right-0 left-[18px] hidden h-px bg-ink-600 lg:block" />
                {lit && (
                  <>
                    <span key={`${run?.id}-v`} aria-hidden className="draw-down absolute top-4 bottom-0 left-[5px] w-px bg-bone-400 lg:hidden" />
                    <span key={`${run?.id}-h`} aria-hidden className="sweep absolute top-[5px] right-0 left-[18px] hidden h-px bg-bone-400 lg:block" />
                  </>
                )}
              </>
            )}
            <span aria-hidden className={`relative z-10 mt-1 block size-[11px] border transition-colors duration-500 lg:mt-0 ${NODE[state]}`} />
            <div className="min-w-0">
              <p className={`label flex items-center gap-2 lg:mt-4 ${STATE_TONE[state]}`}>
                <span className="text-bone-500">0{i + 1}</span>
                {state === "running" && <span className="live-dot size-1 bg-moss-300" aria-hidden />}
                {STATE_LABEL[state]}
              </p>
              <p className={`mt-1.5 text-[15px] font-medium tracking-tight ${state === "waiting" ? "text-bone-400" : "text-bone-50"}`}>
                {info.name}
              </p>
              <p className="font-mono text-[10.5px] tracking-[0.08em] text-bone-500 uppercase">{info.who}</p>
              {result ? (
                <p className={`mt-2 font-mono text-[11px] ${TONE_TEXT[result.tone]}`}>{result.text}</p>
              ) : state === "failed" ? (
                <p className="mt-2 font-mono text-[11px] text-rust-300">Refused by the backend · resume to retry</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
