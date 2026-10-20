import { useState, type ReactNode } from "react";

import { api, type Attack, type RunCase, type RunDetail, type Verification } from "../api";
import { OutcomeTag, ResponseText, TargetNotice, Technical, guardLine, useRuleName } from "../components/Explain";
import { Note, PageHead, RiskTag, VerdictTag, dateTime, shortId } from "../components/ui";
import { PLAIN_STAGE, RISK_PLAIN, TONE_TEXT, caseOutcome, checkpointPlain, eventPlain, isolationCounts } from "../explain";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";

// What each step does, so a presenter knows which ones only explain and which act.
const STEPS = [
  { title: "The problem", kind: "Explains" },
  { title: "The test", kind: "Can start a test" },
  { title: "The result", kind: "Shows recorded data" },
  { title: "The defense", kind: "Shows recorded data" },
  { title: "The evidence", kind: "Read-only check" },
  { title: "The conclusion", kind: "Shows recorded data" },
];
const DEFAULT_CASE = "PI-01"; // a seeded case whose first attempt fails, so every step has something to show

/** What the presenter can say at this step, built from the data on screen. */
function Say({ children }: { children: ReactNode }) {
  return (
    <aside className="mt-8 border-l-2 border-moss-500 bg-ink-900 py-4 pr-4 pl-5">
      <p className="label text-moss-300">Say this</p>
      <p className="mt-2 text-[14.5px] leading-relaxed text-bone-200">{children}</p>
    </aside>
  );
}

function Field({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[150px_1fr] sm:gap-6">
      <dt className="text-[12.5px] text-bone-500">{term}</dt>
      <dd className="min-w-0 text-[14px] leading-relaxed text-bone-200">{children}</dd>
    </div>
  );
}

/** Why a data step has nothing to show yet, and the supported action that fixes it. */
function NeedsRun({ selected, onBack }: { selected: Attack; onBack: () => void }) {
  const { busy, playing, run, runLoad, start, resume } = useLab();
  if (busy) {
    return (
      <p className="text-[14px] text-moss-300">
        A test is running{playing ? ` · ${PLAIN_STAGE[playing].name}` : ""}. This step fills in when it finishes.
      </p>
    );
  }
  if (!run && runLoad === "loading") return <p className="text-[14px] text-bone-500">Loading the latest run…</p>;
  const reason = !run
    ? runLoad === "failed"
      ? "The latest run could not be loaded, so there is nothing to show. The message at the top of the page says why."
      : "No test has run yet, so there is no recorded result to show."
    : !run.report
      ? `The latest run (${shortId(run.id)}) has not finished, so it has no result for ${selected.id} yet.`
      : `The latest run (${shortId(run.id)}) tested other attacks and does not include ${selected.id}.`;
  return (
    <div className="space-y-4">
      <p className="text-[14px] text-bone-400">{reason}</p>
      <p className="text-[12.5px] text-bone-500">
        Running starts a new saved test session with only {selected.id}. It adds entries to the audit record; nothing is
        changed or deleted.
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" onClick={() => start([selected.id])}>
          Run {selected.id} now
        </button>
        {run && !run.report && (
          <button type="button" className="btn" onClick={() => resume(run.id)}>
            Resume the unfinished run
          </button>
        )}
        <button type="button" className="btn" onClick={onBack}>
          Back to step 2
        </button>
      </div>
    </div>
  );
}

function Problem() {
  return (
    <>
      <div className="space-y-4 text-[15px] leading-relaxed text-bone-400">
        <p>
          AI assistants follow instructions written in ordinary language. That makes them easy to talk into things: an
          attacker can write a message that tries to override the assistant's rules, leak confidential data or produce
          content it should refuse.
        </p>
        <p>
          Bayora tests for this in a controlled way. A <span className="text-rust-300">Red Team</span> sends scripted attacks
          to the <span className="text-bone-50">Target</span>, the answers are checked against written safety rules, a{" "}
          <span className="text-moss-300">Blue Team</span> adds protections, and the attacks run again. Every step is
          recorded as evidence.
        </p>
      </div>
      <TargetNotice className="mt-6" />
      <Say>
        Companies are putting AI assistants in front of customers. The risk is simple: someone types a message that tricks
        the assistant into breaking its rules. Bayora attacks an AI on purpose, in a controlled lab, checks whether the
        defenses work, and keeps tamper-evident records of everything that happened.
      </Say>
    </>
  );
}

function TestStep({ attacks, selected, onSelect, item, run }: { attacks: Attack[]; selected: Attack; onSelect: (id: string) => void; item: RunCase | null; run: RunDetail | null }) {
  const { meta, busy, start } = useLab();
  const criteria = selected.criteria.map((id) => meta?.criteria[id]?.title ?? id);
  return (
    <>
      <label className="block max-w-sm">
        <span className="label">Attack to present</span>
        <select
          value={selected.id}
          onChange={(event) => onSelect(event.target.value)}
          disabled={busy}
          className="mt-2 block h-10 w-full border border-ink-600 bg-ink-950 px-3 text-[14px] text-bone-50"
        >
          {attacks.map((attack) => (
            <option key={attack.id} value={attack.id}>
              {attack.id} · {attack.title}
            </option>
          ))}
        </select>
      </label>
      <dl className="mt-6 space-y-4">
        <Field term="Technique">{selected.technique}</Field>
        <Field term="What it tries">{selected.objective}</Field>
        <Field term="Judged by">{criteria.join("; ")}</Field>
        <Field term="The prompt">
          <pre className="border-l border-rust-500/60 pl-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-bone-200">{selected.prompt}</pre>
        </Field>
      </dl>
      <div className="hairline mt-8 space-y-4 border-t pt-6">
        {item && run?.report ? (
          <p className="text-[13.5px] text-bone-400">
            Showing the recorded results of run{" "}
            <a href={href("runs", run.id)} className="font-mono text-bone-50 underline decoration-ink-500 underline-offset-4">
              {shortId(run.id)}
            </a>{" "}
            ({dateTime(run.created_at)}). You can also run this attack again now.
          </p>
        ) : (
          <p className="text-[13.5px] text-bone-400">The latest run does not include a finished result for this attack. Run it now to continue.</p>
        )}
        <p className="text-[12.5px] leading-relaxed text-bone-500">
          Running starts a new saved test session with only this attack, using the normal test controls. It adds entries to
          the audit record and appears under Test runs. Nothing existing is changed or deleted.
        </p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start([selected.id])}>
          {busy ? "Running…" : item && run?.report ? "Run this attack again now" : "Run this attack now"}
        </button>
      </div>
      <Say>
        This is one of the scripted attacks, called “{selected.title}”. {selected.objective} The answer is judged against
        {criteria.length === 1 ? " one written rule" : ` ${criteria.length} written rules`}: {criteria.join("; ")}.
      </Say>
    </>
  );
}

function ResultStep({ item }: { item: RunCase }) {
  const { meta } = useLab();
  const first = item.baseline!;
  const broken = first.criteria?.filter((c) => !c.passed) ?? [];
  return (
    <>
      <p className={`text-[15px] leading-relaxed ${broken.length ? "text-rust-300" : "text-moss-300"}`}>
        {broken.length
          ? `On the first attempt the AI broke ${broken.length === 1 ? "a safety rule" : `${broken.length} safety rules`}. Highlighted text is what leaked.`
          : "On the first attempt the AI followed its rules for this test."}
      </p>
      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className="label">What the target answered · first attempt</p>
          <VerdictTag verdict={first.verdict} />
        </div>
        <ResponseText text={first.response ?? "(no answer recorded)"} />
      </div>
      <ul className="mt-6 space-y-2">
        {first.criteria?.map((result) => (
          <li key={result.id} className="grid grid-cols-[18px_1fr] gap-2 text-[13.5px]">
            <span className={`font-mono ${result.passed ? "text-moss-300" : "text-rust-300"}`} aria-hidden>
              {result.passed ? "✓" : "✕"}
            </span>
            <span className="text-bone-400">
              <span className="text-bone-200">{meta?.criteria[result.id]?.title ?? result.id}</span>
              <span className="sr-only">{result.passed ? " passed" : " failed"}</span>: {result.evidence}
            </span>
          </li>
        ))}
      </ul>
      <Say>
        {broken.length
          ? `Here is what the AI actually said. It broke the rule${broken.length === 1 ? "" : "s"} “${broken
              .map((c) => meta?.criteria[c.id]?.title ?? c.id)
              .join("”, “")}”, so this attempt is recorded as a failure. The evaluator writes down the evidence for each rule.`
          : "Here is what the AI actually said. It followed every rule for this test, so the attempt is recorded as a pass. That is one result, not a guarantee."}
      </Say>
    </>
  );
}

function DefenseStep({ item, run }: { item: RunCase; run: RunDetail }) {
  const ruleName = useRuleName();
  const outcome = caseOutcome(item, ruleName);
  const retry = item.retest!;
  const acted = guardLine(retry, ruleName);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <OutcomeTag outcome={outcome} />
        <span className="text-[14px] text-bone-400">{outcome.sentence}</span>
      </div>
      <div className="mt-6">
        <p className="label">Protections the Blue Team added in this run</p>
        {run.defenses.length === 0 ? (
          <p className="mt-2 text-[13.5px] text-bone-500">None: nothing in this run failed, so nothing was added.</p>
        ) : (
          <ul className="mt-2">
            {run.defenses.map((rule) => (
              <li key={rule.rule_id} className="hairline grid gap-1 border-b py-2.5 sm:grid-cols-[200px_1fr] sm:gap-5">
                <span className="text-[13.5px] text-moss-300">{rule.title}</span>
                <span className="text-[13px] text-bone-400">
                  {rule.description} <span className="text-bone-500">({rule.stage === "input" ? "checks the prompt" : "checks the answer"})</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className="label">The retry · same attack, protections on</p>
          <VerdictTag verdict={retry.verdict} />
        </div>
        {acted && <p className="mt-2 text-[13px] text-moss-300">{acted}.</p>}
        <ResponseText text={retry.response ?? "(no answer recorded)"} />
      </div>
      <Say>
        The Blue Team never sees the attack itself, only a redacted summary of what failed. From that it added{" "}
        {run.defenses.length === 1 ? "one protection" : `${run.defenses.length} protections`}. Then the same attack ran again. Result:{" "}
        {outcome.label.toLowerCase()}. {outcome.sentence}
      </Say>
    </>
  );
}

function EvidenceStep({ item, run }: { item: RunCase; run: RunDetail }) {
  const { meta } = useLab();
  const witnessed = meta?.deployment.checkpoint === "witness";
  const { data: events, error } = useLoad(() => api.audit(1000, run.id), [run.id]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const linked = new Set([item.baseline?.id, item.retest?.id].filter(Boolean).map((id) => `attempt:${id}`));
  const verify = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      setVerification(await api.verify());
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  };
  const anchor = verification?.checkpoint ? checkpointPlain(verification.checkpoint) : null;
  return (
    <>
      <p className="text-[15px] leading-relaxed text-bone-400">
        Every step of this run is in the audit record, in order. Entries marked with a dot belong to this attack.
      </p>
      {error && <Note tone="error">{error}</Note>}
      <ol className="hairline mt-5 max-h-[300px] overflow-y-auto border-y" aria-label="Audit entries for this run">
        {events?.map((event) => (
          <li key={event.seq} className="hairline grid grid-cols-[14px_52px_1fr] items-baseline gap-2 border-b py-2 last:border-b-0">
            <span aria-hidden className={`size-1.5 ${event.evidence_ref && linked.has(event.evidence_ref) ? "bg-moss-400" : ""}`} />
            <span className="font-mono text-[11px] text-bone-500">#{event.seq}</span>
            <span className="min-w-0 truncate text-[13px] text-bone-200">
              {eventPlain(event.event_type)}
              {event.evidence_ref && linked.has(event.evidence_ref) && <span className="sr-only"> (this attack)</span>}
              <span className="ml-2 font-mono text-[10.5px] text-bone-500">{event.event_type}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-6 space-y-3">
        <button type="button" className="btn btn-primary" disabled={verifying} onClick={verify}>
          {verifying ? "Verifying…" : "Verify the whole record now"}
        </button>
        <p className="text-[12.5px] text-bone-500">Read-only: verification recomputes every fingerprint and compares with the witness. It changes nothing.</p>
        {verifyError && <p className="text-[13px] text-rust-300">{verifyError}</p>}
        {verification && (
          <div className="fade-in space-y-1.5 text-[13.5px]">
            <p className={verification.ok ? "text-moss-300" : "text-rust-300"}>
              {verification.ok
                ? `All ${verification.checked} entries check out: every link and fingerprint matches.`
                : `${verification.errors.length} problem(s) found in ${verification.checked} entries.`}
            </p>
            {anchor && (
              <p className={TONE_TEXT[anchor.tone]}>
                Witness: {anchor.label}. {anchor.sentence}
              </p>
            )}
          </div>
        )}
        <a href={href("audit")} className="label inline-block hover:text-bone-200">
          Open the full audit trail and tamper simulation →
        </a>
      </div>
      <Say>
        Every step you just saw is written to an append-only record. Each entry carries a fingerprint of the one before it,
        so editing or deleting anything breaks the chain.{" "}
        {witnessed
          ? "A separate witness keeps checkpoints, so even a complete rewrite is caught for anything already checkpointed."
          : "In the Docker version a separate witness also keeps checkpoints; this setup has none, so a complete rewrite would not be caught here."}
        {verification ? (verification.ok ? " We just verified it: everything matches." : " We just verified it, and it reports problems: that is the system doing its job.") : ""}
      </Say>
    </>
  );
}

function ConclusionStep({ item, run }: { item: RunCase; run: RunDetail }) {
  const ruleName = useRuleName();
  const outcome = caseOutcome(item, ruleName);
  const report = run.report!;
  const risk = item.residual?.residual_risk;
  const isolation = isolationCounts(run.isolation);
  const { meta } = useLab();
  return (
    <>
      <dl className="space-y-4">
        <Field term="This attack">
          <OutcomeTag outcome={outcome} /> · {outcome.sentence}
        </Field>
        <Field term="Remaining risk">
          <RiskTag risk={risk} /> <span className="ml-2 text-bone-400">{risk ? RISK_PLAIN[risk] : ""}</span>
        </Field>
        {item.residual?.recommendation && <Field term="Next action">{item.residual.recommendation}</Field>}
        <Field term="The whole run">
          {report.counts.cases} attack{report.counts.cases === 1 ? "" : "s"}: {report.counts.baseline_failures} worked at first,{" "}
          {report.counts.residual_failures} still worked after the protections. Highest remaining risk:{" "}
          <span className={TONE_TEXT[report.overall_risk === "none" || report.overall_risk === "low" ? "good" : report.overall_risk === "medium" ? "warn" : "bad"]}>
            {report.overall_risk}
          </span>
          .
        </Field>
        <Field term="Isolation">
          {isolation.failures
            ? `${isolation.failures} of ${isolation.tested} isolation checks failed.`
            : `${isolation.tested} of ${isolation.tested} isolation checks passed`}
          {isolation.untested ? `; ${isolation.untested} not tested in this deployment.` : "."}
        </Field>
        <Field term="Caveats">
          {meta?.target?.kind === "simulated" ? "The target is a simulator, not a live AI model. " : ""}A passed test shows that
          this attack failed here, not that the AI is safe against attacks that were not tried.
        </Field>
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">
        <a href={href("reports", run.id)} className="btn">
          Open the risk report
        </a>
        <a href={href("runs", run.id)} className="btn">
          Inspect every attack in this run
        </a>
      </div>
      <Technical>
        Backend rationale: {item.residual?.rationale ?? "pending"} · verdicts {item.baseline?.verdict} → {item.retest?.verdict} · run{" "}
        {run.id}
      </Technical>
      <Say>
        So, for this attack: {outcome.label.toLowerCase()}. Across the whole run, {report.counts.baseline_failures} of {report.counts.cases}{" "}
        attacks worked at first and {report.counts.residual_failures} still work, so the highest remaining risk is {report.overall_risk}.
        Bayora doesn't claim the AI is safe: it shows what was tried, what failed, what the defense changed, and the evidence
        for all of it.
      </Say>
    </>
  );
}

export function Demo() {
  const { run, online } = useLab();
  const { data: attacks, error } = useLoad(() => api.attacks(), []);
  const [step, setStep] = useState(0);
  const [selectedId, setSelectedId] = useState(DEFAULT_CASE);

  if (error) return <Note tone="error">Could not load the attacks for the demo: {error}</Note>;
  if (!attacks) return <p className="py-10 text-[14px] text-bone-500">{online === false ? "The API is offline." : "Loading…"}</p>;

  const selected = attacks.find((a) => a.id === selectedId) ?? attacks[0];
  const item = run?.cases.find((c) => c.attack.id === selected.id) ?? null;
  const ready = Boolean(run?.report && item?.baseline && item.retest);
  const go = (next: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, next)));

  let body: ReactNode;
  if (step === 0) body = <Problem />;
  else if (step === 1) body = <TestStep attacks={attacks} selected={selected} onSelect={setSelectedId} item={item} run={run} />;
  else if (!ready || !run || !item) body = <NeedsRun selected={selected} onBack={() => go(1)} />;
  else if (step === 2) body = <ResultStep item={item} />;
  else if (step === 3) body = <DefenseStep item={item} run={run} />;
  else if (step === 4) body = <EvidenceStep item={item} run={run} />;
  else body = <ConclusionStep item={item} run={run} />;

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Guided demo" title="Present Bayora in six steps.">
        A walkthrough for presenting one real result from the backend; only the suggested words are scripted. Each step
        says what it does: most only explain or show recorded data, step 2 can start a new saved test, and step 5 runs a
        read-only check.
      </PageHead>

      <details className="hairline max-w-3xl border p-5">
        <summary className="cursor-pointer text-[14px] text-bone-50">Full presenter script · 60 to 90 seconds</summary>
        <div className="mt-4 space-y-3 text-[14px] leading-relaxed text-bone-400">
          <p>“AI assistants take instructions in plain language, so anyone can try to talk them into breaking their rules. Bayora is a lab that tests that safely.”</p>
          <p>“A Red Team sends scripted attacks: overriding instructions, role-play jailbreaks, hidden instructions in documents. The target answers, and every answer is checked against written safety rules.”</p>
          <p>“Then a Blue Team, which only sees a redacted summary, adds protections, and every attack runs again. So we can show which defenses actually helped, which only hid the problem, and what still fails.”</p>
          <p>“Everything is recorded in a hash-linked audit trail, and a separate witness keeps checkpoints, so changes to the record are detected. In the Docker version the roles run in separate containers and can only reach what they're allowed to.”</p>
          <p>“Today the target is a deterministic simulator, and we say so on screen. The point is the method: attack, measure, defend, retest, and keep the evidence.”</p>
        </div>
      </details>

      <div className="grid gap-10 lg:grid-cols-12">
        <nav aria-label="Demo steps" className="min-w-0 lg:col-span-3">
          <ol className="flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:pb-0">
            {STEPS.map(({ title }, i) => (
              <li key={title} className="shrink-0">
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={`flex w-full items-baseline gap-3 border-l py-2 pr-3 pl-4 text-left text-[14px] transition-colors ${
                    i === step ? "border-bone-50 text-bone-50" : "border-ink-700 text-bone-400 hover:border-bone-500 hover:text-bone-50"
                  }`}
                >
                  <span className="font-mono text-[10.5px] text-bone-500">{i + 1}</span>
                  {title}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section className="min-w-0 lg:col-span-9" aria-labelledby="demo-step-title">
          <p className="label">
            Step {step + 1} of {STEPS.length} · {STEPS[step].kind}
            {step > 0 ? ` · ${selected.id}` : ""}
          </p>
          <h2 id="demo-step-title" className="mt-3 font-serif text-[38px] leading-none text-bone-50 sm:text-[46px]">
            {STEPS[step].title}
          </h2>
          <div key={`${step}-${selected.id}`} className="fade-in mt-8">
            {body}
          </div>
          <div className="hairline mt-10 flex items-center justify-between gap-3 border-t pt-6">
            <button type="button" className="btn" disabled={step === 0} onClick={() => go(step - 1)}>
              <span aria-hidden>←</span> Back
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={() => go(step + 1)}>
                Next: {STEPS[step + 1].title.toLowerCase()} <span aria-hidden>→</span>
              </button>
            ) : (
              <a href={href()} className="btn">
                Back to the overview
              </a>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
