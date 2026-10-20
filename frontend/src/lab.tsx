import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { api, type Meta, type RunDetail, type Stage } from "./api";
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
  run: RunDetail | null; // the run shown in the security core
  playing: Stage | null; // stage whose animation is currently playing
  busy: boolean;
  error: string | null;
  version: number; // bumps whenever backend state changes, so pages refetch
  start: (attackIds?: string[]) => Promise<void>;
  resume: (id: string) => Promise<void>;
  skip: () => void;
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
  const [playing, setPlaying] = useState<Stage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const fast = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    api
      .meta()
      .then((value) => (setMeta(value), setOnline(true)))
      .catch((err: Error) => (setOnline(false), setError(err.message)));
    api
      .runs()
      .then((runs) => (runs[0] ? api.run(runs[0].id).then(setRun) : undefined))
      .catch(() => undefined);
  }, []);

  // Advance the session one real backend stage at a time, showing each result.
  const drive = useCallback(
    async (initial: RunDetail) => {
      let current = initial;
      setRun(current);
      try {
        while (current.next_stage) {
          const { executed, run: next, checkpoint } = await api.advance(current.id);
          if (checkpoint && (checkpoint.status === "failed" || checkpoint.status === "rejected")) {
            // The stage committed but its audit events are not externally anchored yet: say so.
            setError(`Audit checkpoint ${checkpoint.status} after ${executed}: ${checkpoint.error ?? "witness error"}`);
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
      }
    },
    [reducedMotion],
  );

  const guarded = useCallback(async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    fast.current = false;
    setBusy(true);
    setError(null);
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

  return (
    <LabContext.Provider value={{ meta, online, run, playing, busy, error, version, start, resume, skip }}>
      {children}
    </LabContext.Provider>
  );
}
