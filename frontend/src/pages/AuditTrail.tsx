import { useEffect, useRef, useState } from "react";

import { api, type CheckpointVerification, type TamperMode, type TamperResult, type Verification } from "../api";
import { Note, PageHead, SectionHead, groupHash, time } from "../components/ui";
import { sleep, useLoad, useReducedMotion } from "../hooks";
import { useLab } from "../lab";

// Actor colours follow the role palette so boundaries stay legible in the evidence itself.
const ACTOR_TEXT: Record<string, string> = { red: "text-rust-300", blue: "text-moss-300", target: "text-bone-200" };

const TAMPER_MODES: { mode: TamperMode; label: string; description: string }[] = [
  { mode: "modify", label: "Edit an event", description: "Change a recorded verdict without updating its hash." },
  { mode: "delete", label: "Delete an event", description: "Remove one event from the middle of the chain." },
  { mode: "reorder", label: "Swap two events", description: "Exchange the positions of adjacent events." },
  { mode: "rewrite", label: "Rewrite the chain", description: "Edit an event and recompute every later hash." },
];

function VerificationResult({ result, title }: { result: Verification; title: string }) {
  return (
    <div className="fade-in">
      <div className="flex items-baseline justify-between gap-4">
        <p className="label">{title}</p>
        <p className={`font-mono text-[12px] uppercase ${result.ok ? "text-moss-300" : "text-rust-300"}`}>
          {result.ok ? "intact" : `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`}
        </p>
      </div>
      <p className="mt-2 text-[13px] text-bone-400">{result.checked} events checked in stored order.</p>
      {result.checkpoint && <CheckpointLine checkpoint={result.checkpoint} />}
      {result.errors.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {result.errors.slice(0, 6).map((error, i) => (
            <li key={i} className="font-mono text-[11.5px] leading-relaxed text-rust-300">
              {error.seq !== null && `#${error.seq} · `}
              {error.kind} · <span className="text-bone-400">{error.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** External checkpoint status, stated plainly: anchored, broken, unreachable or absent. */
function CheckpointLine({ checkpoint }: { checkpoint: CheckpointVerification }) {
  const text: Record<CheckpointVerification["status"], string> = {
    ok: `Witness: chain matches all ${checkpoint.checkpoints} checkpoints, anchored through #${checkpoint.anchored_seq}${
      checkpoint.unanchored_events ? ` (${checkpoint.unanchored_events} newer events not yet anchored)` : ""
    }.`,
    mismatch: "Witness: the stored chain disagrees with external checkpoints.",
    unavailable: "Witness unreachable: external verification could not run.",
    "not-configured": "No witness in this deployment: a full rewrite of the local chain would go undetected.",
  };
  const tone = checkpoint.status === "ok" ? "text-moss-300" : checkpoint.status === "not-configured" ? "text-amber-300" : "text-rust-300";
  return <p className={`mt-2 text-[13px] leading-relaxed ${tone}`}>{text[checkpoint.status]}</p>;
}

export function AuditTrail() {
  const { version } = useLab();
  const reducedMotion = useReducedMotion();
  const { data: events, error } = useLoad(() => api.audit(60), [version]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [walked, setWalked] = useState(-1);
  const [verifying, setVerifying] = useState(false);
  const [tamper, setTamper] = useState<TamperResult | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const tamperRef = useRef<HTMLDivElement>(null);

  // Keep the newest link in view as the chain grows during a run.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [events, reducedMotion]);

  // Bring the simulated target block and the simulation result into view.
  useEffect(() => {
    const list = listRef.current;
    const block = list?.querySelector<HTMLElement>(`[data-seq="${tamper?.seq}"]`);
    const behavior = reducedMotion ? "auto" : "smooth";
    if (list && block) list.scrollTo({ top: block.offsetTop - list.offsetTop - 24, behavior });
    tamperRef.current?.scrollIntoView({ block: "nearest", behavior });
  }, [tamper, reducedMotion]);

  const verify = async () => {
    if (!events) return;
    setVerifying(true);
    setTamper(null);
    setWalked(-1);
    try {
      const result = await api.verify();
      setVerification(result);
      // The server verified the whole chain; walk the visible window to show each link being checked.
      if (!reducedMotion) {
        const step = Math.min(45, 2200 / Math.max(events.length, 1));
        for (let i = 0; i < events.length; i++) {
          setWalked(i);
          await sleep(step);
        }
      }
      setWalked(events.length);
    } finally {
      setVerifying(false);
    }
  };

  const simulate = async (mode: TamperMode) => {
    setTamperError(null);
    try {
      // Target the middle of the visible window so the affected block can be highlighted.
      setTamper(await api.tamper(mode, events?.[Math.floor(events.length / 2)]?.seq));
    } catch (err) {
      setTamperError(err instanceof Error ? err.message : String(err));
    }
  };

  // Only the stored chain's own verification marks blocks; simulations run on a copy.
  const errorSeqs = new Set(verification?.errors.map((e) => e.seq));

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Audit trail" title="Evidence, chained.">
        Every action is appended with the previous event's hash and a SHA-256 of its own fields. Target and evaluator
        events also carry digests of the stored prompt, response and verdict they refer to.
      </PageHead>

      {error && <Note tone="error">{error}</Note>}

      <div className="grid gap-12 lg:grid-cols-12">
        <section className="min-w-0 lg:col-span-7">
          <SectionHead
            index="01"
            title="Chain"
            aside={<span className="label">{events ? `latest ${events.length} events` : "…"}</span>}
          />
          {events?.length === 0 && <p className="py-8 text-[14px] text-bone-500">No events yet. Run a test to build the chain.</p>}
          <ol ref={listRef} aria-label="Audit events, oldest first" className="max-h-[760px] overflow-y-auto pt-4 pr-1">
            {events?.map((event, i) => {
              const checked = walked >= i;
              const broken = errorSeqs.has(event.seq);
              const targeted = tamper?.seq === event.seq;
              const previous = events[i - 1];
              return (
                <li key={event.seq} data-seq={event.seq} className="grid grid-cols-[52px_1fr] gap-3">
                  <div className="flex flex-col items-center">
                    <span className="font-mono text-[11px] text-bone-500">#{event.seq}</span>
                    {i < events.length - 1 && (
                      <span
                        aria-hidden
                        className={`draw-down mt-1 w-px flex-1 transition-colors duration-300 ${checked && verification && !broken ? "bg-moss-500" : "bg-ink-600"}`}
                      />
                    )}
                  </div>
                  <div
                    className={`fade-in mb-3 border p-3 transition-colors duration-300 ${
                      targeted ? "border-amber-400" : broken && checked ? "border-rust-500" : checked && verification ? "border-moss-800" : "hairline"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate text-[13.5px] text-bone-50">
                        {event.event_type}
                        <span className={`ml-2 font-mono text-[10.5px] tracking-[0.1em] uppercase ${ACTOR_TEXT[event.actor] ?? "text-bone-500"}`}>
                          {event.actor}
                        </span>
                      </p>
                      {targeted ? (
                        <span className="font-mono text-[11px] text-amber-300">simulated {tamper.mode}</span>
                      ) : (
                        <span className={`font-mono text-[11px] ${!checked || !verification ? "text-bone-500" : broken ? "text-rust-300" : "text-moss-300"}`}>
                          {!checked || !verification ? time(event.ts) : broken ? "✕ broken" : "✓ linked"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 truncate font-mono text-[10.5px] text-bone-500">
                      prev{" "}
                      <span className={previous && previous.hash === event.prev_hash ? "text-bone-200" : "text-bone-400"}>
                        {event.prev_hash.slice(0, 12)}
                      </span>{" "}
                      → hash <span className="text-bone-200">{event.hash.slice(0, 12)}</span>
                      {event.evidence_ref && <span className="ml-2 text-bone-500">{event.evidence_ref.split(":")[0]}</span>}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <aside className="min-w-0 space-y-12 lg:sticky lg:top-10 lg:col-span-5 lg:self-start">
          <section>
            <SectionHead index="02" title="Verify the stored chain" />
            <div className="space-y-5 pt-5">
              <button type="button" className="btn btn-primary" onClick={verify} disabled={verifying || !events?.length}>
                {verifying ? "Verifying…" : "Verify chain"}
              </button>
              {verification && <VerificationResult result={verification} title="Stored chain" />}
              {verification && (
                <div>
                  <p className="label">Head hash · record this externally to anchor the chain</p>
                  <p className="mt-2 max-w-sm font-mono text-[11.5px] leading-relaxed text-bone-200">{groupHash(verification.head_hash)}</p>
                </div>
              )}
            </div>
          </section>

          <section>
            <SectionHead index="03" title="Tamper simulation" />
            <p className="pt-4 text-[13px] leading-relaxed text-bone-400">
              Each simulation mutates an in-memory copy of the chain on the server and verifies it. The stored chain is
              never modified.
            </p>
            <div className="mt-5 grid grid-cols-1 gap-px bg-ink-700 sm:grid-cols-2">
              {TAMPER_MODES.map(({ mode, label, description }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => simulate(mode)}
                  disabled={!events?.length}
                  className={`bg-ink-950 p-4 text-left transition-colors hover:bg-ink-850 disabled:opacity-40 ${tamper?.mode === mode ? "bg-ink-850" : ""}`}
                >
                  <span className="block text-[14px] text-bone-50">{label}</span>
                  <span className="mt-1 block text-[12px] leading-snug text-bone-500">{description}</span>
                </button>
              ))}
            </div>
            {tamperError && <p className="mt-4 text-[13px] text-rust-300">{tamperError}</p>}
            {tamper && (
              <div key={`${tamper.mode}-${tamper.seq}`} ref={tamperRef} className="mt-6 scroll-mb-8 space-y-4">
                <p className="text-[13.5px] leading-relaxed text-bone-200">{tamper.summary}</p>
                <VerificationResult result={tamper.verification} title="Tampered copy" />
                {tamper.checkpoint && (
                  <p className={`text-[13px] ${tamper.checkpoint.detected ? "text-moss-300" : "text-rust-300"}`}>
                    Witness checkpoints:{" "}
                    {tamper.checkpoint.detected
                      ? `caught it (${tamper.checkpoint.errors.length} checkpointed events differ).`
                      : "no checkpointed event was affected."}
                  </p>
                )}
                {tamper.mode === "rewrite" && (
                  <Note tone={tamper.checkpoint?.detected ? "neutral" : "warn"}>
                    Local verification passes. Only the head hash changed:{" "}
                    <span className="font-mono text-[11px] text-bone-200">{tamper.original_head.slice(0, 12)}</span> →{" "}
                    <span className="font-mono text-[11px] text-amber-300">{tamper.tampered_head.slice(0, 12)}</span>.{" "}
                    {tamper.checkpoint
                      ? "The external witness is what detects a full rewrite; events after its latest checkpoint stay unprotected until the next one."
                      : "No witness is configured here, so a full rewrite by someone with database control is undetectable."}
                  </Note>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
