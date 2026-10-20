import { useCallback, useEffect, useRef, useState } from "react";

import { api, type TamperMode, type TamperResult, type Verification } from "../api";
import { Help, Technical } from "../components/Explain";
import { Note, PageHead, SectionHead, groupHash, time } from "../components/ui";
import { TONE_TEXT, checkpointPlain, eventPlain } from "../explain";
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

const SHOWN_ERRORS = 12;

/** What a verifier response says, in order of importance: verdict, discrepancies, witness, head. */
function VerificationResult({ result, title }: { result: Verification; title: string }) {
  const anchor = result.checkpoint ? checkpointPlain(result.checkpoint) : null;
  return (
    <div className="fade-in space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="label">{title}</p>
        <p className={`text-[15px] font-medium ${result.ok ? "text-moss-300" : "text-rust-300"}`}>
          {result.ok ? "Intact" : `${result.errors.length} problem${result.errors.length === 1 ? "" : "s"} found`}
        </p>
      </div>
      <p className="text-[13.5px] text-bone-400">
        {result.ok
          ? `${result.checked} entries checked in order: every link and fingerprint matches.`
          : `${result.checked} entries checked in order: something was changed, removed or moved. The list below says where.`}
      </p>
      {anchor && (
        <p className={`text-[13.5px] leading-relaxed ${TONE_TEXT[anchor.tone]}`}>
          Witness: {anchor.label}. <span className="text-bone-400">{anchor.sentence}</span>
        </p>
      )}
      {result.errors.length > 0 && (
        <ul className="space-y-1.5">
          {result.errors.slice(0, SHOWN_ERRORS).map((error, i) => (
            <li key={i} className="font-mono text-[11.5px] leading-relaxed text-rust-300">
              {error.seq !== null && `#${error.seq} · `}
              {error.kind} · <span className="text-bone-400">{error.message}</span>
            </li>
          ))}
          {result.errors.length > SHOWN_ERRORS && (
            <li className="font-mono text-[11.5px] text-bone-500">…and {result.errors.length - SHOWN_ERRORS} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function AuditTrail() {
  const { version } = useLab();
  const reducedMotion = useReducedMotion();
  const { data: events, error } = useLoad(() => api.audit(60), [version]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [walked, setWalked] = useState(-1);
  const [verifying, setVerifying] = useState(false);
  const [tamper, setTamper] = useState<TamperResult | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState<TamperMode | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const tamperRef = useRef<HTMLDivElement>(null);

  // Verification is read-only, so the page shows the real status as soon as it opens and after every run.
  const verify = useCallback(
    async (walk: number) => {
      setVerifying(true);
      setVerifyError(null);
      setWalked(-1);
      try {
        setVerification(await api.verify());
        // The server verified the whole chain; on request, walk the visible window to show each link being checked.
        if (walk && !reducedMotion) {
          const step = Math.min(45, 2200 / walk);
          for (let i = 0; i < walk; i++) {
            setWalked(i);
            await sleep(step);
          }
        }
        setWalked(Number.MAX_SAFE_INTEGER);
      } catch (err) {
        setVerification(null); // never leave an earlier "intact" on screen after a failed check
        setVerifyError(err instanceof Error ? err.message : String(err));
      } finally {
        setVerifying(false);
      }
    },
    [reducedMotion],
  );

  useEffect(() => {
    void verify(0);
  }, [verify, version]);

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

  const simulate = async (mode: TamperMode) => {
    setSimulating(mode);
    setTamperError(null);
    try {
      // Target the middle of the visible window so the affected block can be highlighted.
      setTamper(await api.tamper(mode, events?.[Math.floor(events.length / 2)]?.seq));
    } catch (err) {
      setTamper(null);
      setTamperError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimulating(null);
    }
  };

  // Only the stored chain's own verification marks blocks; simulations run on a copy.
  const errorSeqs = new Set(verification?.errors.map((e) => e.seq));

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Audit trail" title="A record that shows if it was changed.">
        Every step of every test is written here in order. Each entry links to the one before it, so an unexpected edit,
        deletion or reordering breaks the chain and verification says so. This is tamper detection, not tamper-proofing.
        <Help term="a hash chain">
          Each entry stores the previous entry's fingerprint (its SHA-256 hash) and a fingerprint of its own fields. Target
          and evaluator entries also carry fingerprints of the stored prompt, answer and verdict, so changing the evidence
          itself is caught too. Where a witness service is configured, it keeps checkpoints of the latest fingerprint, which
          catch even a complete rewrite of anything checkpointed.
        </Help>
      </PageHead>

      <section aria-live="polite">
        <SectionHead
          index="01"
          title="Verification status"
          aside={
            <button
              type="button"
              className="label hover:text-bone-200 disabled:opacity-40"
              disabled={verifying}
              onClick={() => verify(events?.length ?? 0)}
            >
              {verifying ? "Verifying…" : "Verify again →"}
            </button>
          }
        />
        <div className="pt-5">
          {verifyError ? (
            <Note tone="error">
              Verification could not run: {verifyError}. Nothing is known about the record's state until it does.
            </Note>
          ) : verification ? (
            <div className="grid gap-8 lg:grid-cols-12">
              <div className="lg:col-span-8">
                <VerificationResult result={verification} title="Stored record" />
              </div>
              <div className="lg:col-span-4">
                <p className="label">Latest fingerprint (head hash)</p>
                <p className="mt-2 font-mono text-[11.5px] leading-relaxed break-words text-bone-200">{groupHash(verification.head_hash)}</p>
                <p className="mt-2 text-[12px] text-bone-500">This is the value the witness checkpoints.</p>
              </div>
            </div>
          ) : (
            <p className="text-[13.5px] text-bone-500">Verifying the stored record…</p>
          )}
        </div>
      </section>

      {error && <Note tone="error">{error}</Note>}

      <div className="grid gap-12 lg:grid-cols-12">
        <section className="min-w-0 lg:col-span-7">
          <SectionHead
            index="02"
            title="The record · technical evidence"
            aside={<span className="label">{events ? `latest ${events.length} entries` : "…"}</span>}
          />
          {events?.length === 0 && <p className="py-8 text-[14px] text-bone-500">No entries yet. Run a test to build the record.</p>}
          <ol ref={listRef} aria-label="Audit entries, oldest first" className="max-h-[680px] overflow-y-auto pt-4 pr-1">
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
                        {eventPlain(event.event_type)}
                        <span className="ml-2 font-mono text-[10.5px] text-bone-500">{event.event_type}</span>
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

        <aside className="min-w-0 lg:sticky lg:top-10 lg:col-span-5 lg:self-start">
          <SectionHead index="03" title="Tamper simulation" />
          <p className="pt-4 text-[13px] leading-relaxed text-bone-400">
            See what verification does when someone tampers with the record. Each simulation changes a temporary copy on the
            server and verifies that copy. The stored record is never modified.
          </p>
          <div className="mt-5 grid grid-cols-1 gap-px bg-ink-700 sm:grid-cols-2">
            {TAMPER_MODES.map(({ mode, label, description }) => (
              <button
                key={mode}
                type="button"
                onClick={() => simulate(mode)}
                disabled={!events?.length || simulating !== null}
                aria-busy={simulating === mode}
                className={`bg-ink-950 p-4 text-left transition-colors hover:bg-ink-850 disabled:opacity-40 ${tamper?.mode === mode ? "bg-ink-850" : ""}`}
              >
                <span className="block text-[14px] text-bone-50">{simulating === mode ? "Simulating…" : label}</span>
                <span className="mt-1 block text-[12px] leading-snug text-bone-500">{description}</span>
              </button>
            ))}
          </div>
          {tamperError && <p className="mt-4 text-[13px] text-rust-300">Simulation failed: {tamperError}</p>}
          {tamper && (
            <div key={`${tamper.mode}-${tamper.seq}`} ref={tamperRef} className="mt-6 scroll-mb-8 space-y-4">
              <p className="text-[13.5px] leading-relaxed text-bone-200">{tamper.summary}</p>
              <VerificationResult result={tamper.verification} title="Tampered copy" />
              {tamper.checkpoint && (
                <p className={`text-[13px] ${tamper.checkpoint.detected ? "text-moss-300" : "text-rust-300"}`}>
                  Witness checkpoints:{" "}
                  {tamper.checkpoint.detected
                    ? `caught it (${tamper.checkpoint.errors.length} checkpointed entries differ).`
                    : "no checkpointed entry was affected."}
                </p>
              )}
              {tamper.mode === "rewrite" && (
                <Note tone={tamper.checkpoint?.detected ? "neutral" : "warn"}>
                  The record's own links still verify; only the latest fingerprint changed.{" "}
                  {tamper.checkpoint
                    ? "The external witness is what detects a full rewrite; entries after its latest checkpoint stay unprotected until the next one."
                    : "No witness is configured here, so a full rewrite by someone with database control is undetectable."}
                  <Technical summary="Fingerprints">
                    <span className="font-mono text-[11px]">
                      {tamper.original_head.slice(0, 16)} → <span className="text-amber-300">{tamper.tampered_head.slice(0, 16)}</span>
                    </span>
                  </Technical>
                </Note>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
