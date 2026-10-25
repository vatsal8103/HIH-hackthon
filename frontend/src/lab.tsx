import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { api, type Meta, type RunDetail, type Stage } from "./api";
import { PLAIN_STAGE } from "./explain";
import { sleep, useReducedMotion } from "./hooks";

// How long each executed stage is shown before the next one is requested.
// The backend executes a stage in milliseconds; this pacing is presentational only.
export const STAGE_MS: Record<Stage, number> = {
  attack: 1900,
  respond: 1400,
  evaluate: 1700,
  defend: 2200,
  retest: 2300,
  isolation: 1800,
  report: 1100,
};
const REDUCED_MS = 280;

interface Lab {
  meta: Meta | null;
  online: boolean | null;
  run: RunDetail | null; // the latest run: shown on the overview, in the security core and the demo
  runLoad: "loading" | "ready" | "failed"; // whether `run === null` means "no runs" or "not known"
  playing: Stage | null; // stage whose animation is currently playing
  busy: boolean;
  error: string | null;
  failed: { runId: string; stage: Stage } | null; // the stage the backend refused; the run can resume there
  version: number; // bumps whenever backend state changes, so pages refetch
  start: (attackIds?: string[]) => Promise<void>;
  resume: (id: string) => Promise<void>;
  skip: () => void;
  dismiss: () => void;
}

const LabContext = createContext<Lab | null>(null);

export function useLab(): Lab {
  const lab = useContext(LabContext);
  if (!lab) throw new Error("useLab outside LabProvider");
  return lab;
}

export function LabProvider({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [runLoad, setRunLoad] = useState<Lab["runLoad"]>("loading");
  const [playing, setPlaying] = useState<Stage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Lab["failed"]>(null);
  const [version, setVersion] = useState(0);
  const fast = useRef(false);
  const busyRef = useRef(false);

  // Metadata includes the target's readiness, asked of the target: reread it after every run
  // so a provider that went down (or came back) is not reported from a stale answer.
  const loadMeta = useCallback(
    () =>
      api
        .meta()
        .then((value) => (setMeta(value), setOnline(true)))
        .catch((err: Error) => (setOnline(false), setError(err.message))),
    [],
  );

  useEffect(() => {
    void loadMeta();
    api
      .runs()
      .then((runs) => (runs[0] ? api.run(runs[0].id).then(setRun) : undefined))
      .then(() => setRunLoad("ready"))
      .catch((err: Error) => (setRunLoad("failed"), setError(`Could not load the latest run: ${err.message}`)));
  }, [loadMeta]);

  // Advance the session one real backend stage at a time, showing each result.
  const drive = useCallback(
    async (initial: RunDetail) => {
      let current = initial;
      setRun(current);
      setRunLoad("ready");
      try {
        while (current.next_stage) {
          const stage = current.next_stage;
          const { executed, run: next, checkpoint } = await api.advance(current.id, stage).catch((err: unknown) => {
            setFailed({ runId: current.id, stage });
            throw err;
          });
          if (checkpoint && (checkpoint.status === "failed" || checkpoint.status === "rejected")) {
            // The stage committed but its audit events are not externally anchored yet: say so.
            setError(
              `The step “${PLAIN_STAGE[executed].name}” was saved, but anchoring it with the witness ${checkpoint.status === "failed" ? "failed" : "was rejected"}: ${checkpoint.error ?? "witness error"}`,
            );
          }
          current = next;
          setRun(next);
          setPlaying(executed);
          setVersion((v) => v + 1);
          await sleep(fast.current || reducedMotion ? REDUCED_MS : STAGE_MS[executed]);
        }
      } finally {
        setPlaying(null);
        setVersion((v) => v + 1);
        void loadMeta();
      }
    },
    [reducedMotion, loadMeta],
  );

  const guarded = useCallback(async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    fast.current = false;
    setBusy(true);
    setError(null);
    setFailed(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const start = useCallback(
    (attackIds?: string[]) => guarded(async () => drive(await api.createRun(attackIds))),
    [drive, guarded],
  );
  const resume = useCallback((id: string) => guarded(async () => drive(await api.run(id))), [drive, guarded]);
  const skip = useCallback(() => {
    fast.current = true;
  }, []);
  const dismiss = useCallback(() => setError(null), []);

  return (
    <LabContext.Provider value={{ meta, online, run, runLoad, playing, busy, error, failed, version, start, resume, skip, dismiss }}>
      {children}
    </LabContext.Provider>
  );
}
