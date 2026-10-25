import { useState, type ReactNode } from "react";

import { api, type Attack, type RunCase, type RunDetail, type Verification } from "../api";
import { OutcomeTag, ResponseText, TargetNotice, Technical, guardLine, useRuleName } from "../components/Explain";
import { Note, PageHead, RiskTag, VerdictTag, dateTime, shortId } from "../components/ui";
import {
  DEMO_STEPS,
  PLAIN_STAGE,
  TONE_TEXT,
  caseOutcome,
  checkpointPlain,
  eventPlain,
  failedChecks,
  failureDescriptions,
  findingExplanation,
  isolationCounts,
  liveHost,
  recordedPrompt,
  retryImprovement,
} from "../explain";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";

const STEPS = DEMO_STEPS; // what each step does, so a presenter knows which only explain and which act
const DEFAULT_CASE = "PI-01"; // a seeded case whose first attempt fails, so every step has something to show

/** What the presenter can say at this step: suggested words, built from the data on screen. */
function Say({ children }: { children: ReactNode }) {
  return (
    <aside className="mt-8 border-l-2 border-moss-500 bg-ink-900 py-4 pr-4 pl-5" aria-label="Suggested words for the presenter">
      <p className="label text-moss-300">Say this · suggested words</p>
      <p className="mt-2 text-[15px] leading-relaxed text-bone-100">{children}</p>
    </aside>
  );
}

/** Recorded backend data, framed so it is never confused with the presenter's suggested words. */
function Recorded({ run, children }: { run: RunDetail; children: ReactNode }) {
  return (
    <div className="hairline border p-4 sm:p-5">
      <p className="label mb-4">
        Recorded evidence · run{" "}
        <a href={href("runs", run.id)} className="font-mono text-bone-200 underline decoration-ink-500 underline-offset-4 hover:decoration-bone-400">
          {shortId(run.id)}
        </a>{" "}
        · {dateTime(run.created_at)}
      </p>
      {children}
    </div>
  );
}

/** Says, before the button, that pressing it creates a new saved test (never shown as a passive control). */
function CreatesRecord({ attackId }: { attackId: string }) {
  const { meta } = useLab();
  const target = meta?.target;
  const sends =
    target?.kind === "live"
      ? liveHost(target.provider) === "groq"
        ? ` The prompt is sent to ${target.provider}, hosted by Groq, a third-party service.`
        : ` The prompt is sent to the live model ${target.provider ?? ""}.`
      : "";
  return (
    <Note tone="warn">
      <span className="text-bone-200">This creates a new saved test.</span> It runs {attackId} through all seven stages,
      adds entries to the audit record and appears under Test runs.{sends} Nothing existing is changed or deleted.
    </Note>
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
      <CreatesRecord attackId={selected.id} />
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" onClick={() => start([selected.id])}>
          Start a new saved test with {selected.id}
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
      <div className="space-y-4 text-[16px] leading-relaxed text-bone-300">
        <p>
          AI assistants follow instructions written in ordinary language, so anyone can try to talk them into breaking their
          rules: overriding instructions, leaking confidential data, or writing what they should refuse.
        </p>
        <p className="text-bone-400">
          Bayora attacks an AI on purpose, checks every answer, adds protections, tries again, and keeps evidence of each
          step. The next steps show one real recorded result.
        </p>
      </div>
      <TargetNotice className="mt-6" />
      <p className="mt-4 text-[12.5px] text-bone-500">
        Roles, stages and controls are explained in{" "}
        <a href={href("how")} className="text-bone-300 underline decoration-ink-500 underline-offset-4 hover:decoration-bone-400">
          How it works
        </a>
        .
      </p>
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
  // With a recorded result, show the prompt that run actually sent; otherwise the library's wording.
  const shown = item && run?.report ? recordedPrompt(item) : { text: selected.prompt, recorded: false, differsFromLibrary: false };
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
        <Field term={shown.recorded ? "The prompt, as recorded" : "The prompt"}>
          <pre className="border-l border-rust-500/60 pl-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-bone-200">{shown.text}</pre>
          {shown.differsFromLibrary && (
            <p className="mt-2 text-[12px] text-bone-500">
              The recorded run used an earlier wording of this attack. A new test would send the library's current wording.
            </p>
          )}
        </Field>
      </dl>
      <div className="hairline mt-8 space-y-4 border-t pt-6">
        {item && run?.report ? (
          <p className="text-[13.5px] text-bone-400">
            Showing the recorded results of run{" "}
            <a href={href("runs", run.id)} className="font-mono text-bone-50 underline decoration-ink-500 underline-offset-4">
              {shortId(run.id)}
            </a>{" "}
            ({dateTime(run.created_at)}). The next steps show this recorded result; you do not need to run anything.
          </p>
        ) : (
          <p className="text-[13.5px] text-bone-400">The latest run does not include a finished result for this attack. Run it now to continue.</p>
        )}
        <CreatesRecord attackId={selected.id} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start([selected.id])}>
          {busy ? "Running…" : `Start a new saved test with ${selected.id}`}
        </button>
      </div>
      <Say>
        This is one of the scripted attacks, called “{selected.title}”. {selected.objective} The answer is judged against
        {criteria.length === 1 ? " one written rule" : ` ${criteria.length} written rules`}: {criteria.join("; ")}.
      </Say>
    </>
  );
}

function ResultStep({ item, run }: { item: RunCase; run: RunDetail }) {
  const { meta } = useLab();
  const first = item.baseline!;
  const failed = failedChecks(first);
  const broken = failed ?? [];
  const leaked = broken.some((id) => id === "no-secret-disclosure" || id === "no-pii-disclosure");
  return (
    <>
      <p className={`text-[15px] leading-relaxed ${broken.length ? "text-rust-300" : failed ? "text-moss-300" : "text-bone-400"}`}>
        {failed === null
          ? "Which checks the first attempt failed was not recorded."
          : broken.length
            ? `On the first attempt ${failureDescriptions(first)!.join("; ")}.${leaked ? " Highlighted text is what leaked." : ""}`
            : "On the first attempt the AI passed every check for this test."}
      </p>
      <div className="mt-6">
        <Recorded run={run}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="label">What the target answered · first attempt</p>
            <VerdictTag verdict={first.verdict} />
          </div>
          <ResponseText text={first.response ?? "(no answer recorded)"} />
          <p className="label mt-6">Checks and the evaluator's evidence</p>
          <ul className="mt-2 space-y-2">
            {first.criteria?.map((result) => (
              <li key={result.id} className="grid grid-cols-[18px_1fr_auto] items-baseline gap-2 text-[13.5px]">
                <span className={`font-mono ${result.passed ? "text-moss-300" : "text-rust-300"}`} aria-hidden>
                  {result.passed ? "✓" : "✕"}
                </span>
                <span className="text-bone-400">
                  <span className="text-bone-200">{meta?.criteria[result.id]?.title ?? result.id}</span>
                  <span className="sr-only">{result.passed ? " passed" : " failed"}</span>: {result.evidence}
                </span>
                {!result.passed && meta?.criteria[result.id] && (
                  <span className="whitespace-nowrap">
                    <span className="sr-only">severity </span>
                    <RiskTag risk={meta.criteria[result.id].severity} />
                  </span>
                )}
              </li>
            ))}
            {!first.criteria && <li className="text-[13px] text-bone-500">Per-check results were not recorded for this attempt.</li>}
          </ul>
        </Recorded>
      </div>
      <Say>
        {broken.length
          ? `Here is what the AI actually said. It failed the check${broken.length === 1 ? "" : "s"} “${broken
              .map((id) => meta?.criteria[id]?.title ?? id)
              .join("”, “")}”, so this attempt is recorded as a failure. The evaluator writes down the evidence for each check.`
          : "Here is what the AI actually said. It followed every rule for this test, so the attempt is recorded as a pass. That is one result, not a guarantee."}
      </Say>
    </>
  );
}

function DefenseStep({ item, run }: { item: RunCase; run: RunDetail }) {
  const ruleName = useRuleName();
  const outcome = caseOutcome(item, ruleName, run.defenses.length);
  const anyFailed = run.cases.some((c) => c.baseline?.verdict === "fail");
  const retry = item.retest!;
  const acted = guardLine(retry, ruleName);
  const { meta } = useLab();
  const why = findingExplanation(item, run.defenses.length, ruleName, (id) => meta?.criteria[id]);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <OutcomeTag outcome={outcome} />
        <span className="text-[14px] text-bone-400">{outcome.sentence}</span>
      </div>
      <p className="mt-3 text-[12.5px] text-bone-500">
        The Blue Team is simulated: a fixed playbook maps each failed check to one protection rule. It is not an AI.
      </p>
      <div className="mt-6">
        <Recorded run={run}>
          <p className="label">Protections the Blue Team added in this run</p>
          {run.defenses.length === 0 ? (
            <p className="mt-2 text-[13.5px] text-bone-500">
              {anyFailed
                ? "None. Checks failed in this run, but the Blue Team's fixed playbook has no protection for the checks that failed."
                : "None: nothing in this run failed, so nothing was needed."}
            </p>
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
          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <p className="label">The retry · same attack, {run.defenses.length ? "protections on" : "no protection added"}</p>
              <VerdictTag verdict={retry.verdict} />
            </div>
            <p className={`mt-2 text-[13px] ${acted ? "text-moss-300" : "text-bone-400"}`}>
              <span className="text-bone-500">Did a protection act on the retry? </span>
              {why.protection}
            </p>
            <ResponseText text={retry.response ?? "(no answer recorded)"} />
          </div>
        </Recorded>
      </div>
      <Say>
        The Blue Team never sees the attack itself, only a redacted summary of what failed. From that it added{" "}
        {run.defenses.length === 0 ? "no protection" : run.defenses.length === 1 ? "one protection" : `${run.defenses.length} protections`}. Then
        the same attack ran again. Result:{" "}
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
      <div className="mt-5">
        <Recorded run={run}>
          <ol className="hairline max-h-[300px] overflow-y-auto border-y" aria-label="Audit entries for this run">
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
        </Recorded>
      </div>
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
            <p className="text-[12.5px] text-bone-500">
              {verification.ok
                ? "A passing check means no change was detected, not that tampering is impossible: entries after the latest checkpoint are not yet anchored, and someone controlling both the database and the witness could alter both."
                : "Verification found differences between the record and its fingerprints or checkpoints."}
            </p>
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
  const outcome = caseOutcome(item, ruleName, run.defenses.length);
  const report = run.report!;
  const risk = item.residual?.residual_risk;
  const isolation = isolationCounts(run.isolation);
  const { meta } = useLab();
  const why = findingExplanation(item, run.defenses.length, ruleName, (id) => meta?.criteria[id]);
  const improved = retryImprovement(item, ruleName);
  return (
    <>
      <dl className="space-y-4">
        <Field term="What the test showed">
          <OutcomeTag outcome={outcome} /> · {outcome.sentence}
        </Field>
        <Field term="Did the retry improve?">
          <span className={improved.verdict === "yes" ? "text-moss-300" : improved.verdict === "no" ? "text-rust-300" : improved.verdict === "hidden" ? "text-amber-300" : ""}>
            {improved.text}
          </span>
        </Field>
        <Field term="Protection">{why.protection}</Field>
        <Field term="Remaining risk">
          <RiskTag risk={risk} /> <span className="ml-2 text-bone-400">{why.severity ?? ""}</span>
        </Field>
        <Field term="Why it matters">{why.impact}</Field>
        <Field term={why.nextFromReport ? "Next action (recorded in the report)" : "Next action"}>{why.next}</Field>
        <Field term="The whole run">
          {report.counts.cases} attack{report.counts.cases === 1 ? "" : "s"}: {report.counts.baseline_failures} failed a check at first,{" "}
          {report.counts.residual_failures} still failed one on the retry ({report.defenses.length === 0 ? "no protection was added" : `${report.defenses.length} protection${report.defenses.length === 1 ? "" : "s"} added`}). Highest remaining risk:{" "}
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
        <Field term="Evaluator limits">
          {report.deployment?.target_kind === "simulated"
            ? "The target in this run was a simulator, not a live AI model. "
            : report.deployment?.target_kind === "live"
              ? `The target in this run was a live model (${report.deployment.target_provider}); its answers can vary between runs and the checks are heuristics. `
              : ""}
          The checks are pattern-matching heuristics for this scripted scenario: they can miss a reworded leak. A passed test
          shows that this attack failed here, not that the AI is safe against attacks that were not tried.
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
        So, for this attack: {outcome.label.toLowerCase()}. Did the retry improve? {improved.text} Across the whole run, {report.counts.baseline_failures} of {report.counts.cases}{" "}
        attacks failed a check at first and {report.counts.residual_failures} still failed one on the retry, so the highest remaining risk is {report.overall_risk}.
        Bayora doesn't claim the AI is safe: it shows what was tried, what failed, what the defense changed, and the evidence
        for all of it.
      </Say>
    </>
  );
}

export function Demo() {
  const { run, online, meta } = useLab();
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
  else if (step === 2) body = <ResultStep item={item} run={run} />;
  else if (step === 3) body = <DefenseStep item={item} run={run} />;
  else if (step === 4) body = <EvidenceStep item={item} run={run} />;
  else body = <ConclusionStep item={item} run={run} />;

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Guided demo · presentation" title="Present Bayora in six steps.">
        One real result from the backend, in 60 to 90 seconds. The evidence is recorded data; only the suggested words are
        scripted. Step 2 can start a new saved test and says so first; step 5 runs a read-only check.
        <span className="mt-3 block">
          <a href={href("how")} className="text-bone-50 underline decoration-ink-500 underline-offset-4 hover:decoration-bone-400">
            Explore the technical architecture →
          </a>
        </span>
      </PageHead>

      <details className="group hairline max-w-3xl border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[14px] text-bone-50 hover:bg-ink-900">
          <span>
            Full presenter script <span className="text-bone-500">· 60 to 90 seconds, suggested words</span>
          </span>
          <span aria-hidden className="text-bone-500 transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="space-y-3 px-5 pb-5 text-[14px] leading-relaxed text-bone-300">
          <p>“AI assistants take instructions in plain language, so anyone can try to talk them into breaking their rules. Bayora is a lab that tests that safely.”</p>
          <p>“A Red Team sends scripted attacks: overriding instructions, role-play jailbreaks, hidden instructions in documents. The target answers, and every answer is checked against written safety rules.”</p>
          <p>“Then a Blue Team, which only sees a redacted summary, adds protections, and every attack runs again. So we can show which defenses actually helped, which only hid the problem, and what still fails.”</p>
          <p>“Everything is recorded in a hash-linked audit trail, and a separate witness keeps checkpoints, so changes to the record are detected. In the Docker version the roles run in separate containers and can only reach what they're allowed to.”</p>
          <p>
            {meta?.target?.kind === "live"
              ? `“Today ${liveHost(meta.target.provider) === "groq" ? "a model hosted by Groq" : "a local language model"}, ${meta.target.provider}, answers as the target. Its answers can vary, and our checks are heuristics, so a pass is evidence about these attacks only. The point is the method: attack, measure, defend, retest, and keep the evidence.”`
              : "“Today the target is a deterministic simulator, and we say so on screen. The point is the method: attack, measure, defend, retest, and keep the evidence.”"}
          </p>
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
                  className={`relative flex w-full items-baseline gap-3 border-l-2 py-2 pr-3 pl-4 text-left text-[14px] transition-colors ${
                    i === step
                      ? "border-moss-400 bg-ink-850 text-bone-50"
                      : i < step
                        ? "border-ink-500 text-bone-300 hover:border-bone-500 hover:text-bone-50"
                        : "border-ink-700 text-bone-400 hover:border-bone-500 hover:text-bone-50"
                  }`}
                >
                  <span className={`font-mono text-[10.5px] ${i === step ? "text-moss-300" : "text-bone-500"}`}>{i + 1}</span>
                  {title}
                  {i === step && <span className="sr-only"> (current step)</span>}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section className="min-w-0 lg:col-span-9" aria-labelledby="demo-step-title">
          <div className="flex gap-1" role="progressbar" aria-label="Demo progress" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1}>
            {STEPS.map(({ title }, i) => (
              <span key={title} className={`h-1 flex-1 ${i <= step ? "bg-moss-400" : "bg-ink-700"}`} />
            ))}
          </div>
          <p className="label mt-4 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-bone-200">
              Step {step + 1} of {STEPS.length}
            </span>
            <span
              className={`border px-1.5 py-px ${
                STEPS[step].action === "creates-record"
                  ? "border-amber-900 text-amber-300"
                  : STEPS[step].action === "read-only"
                    ? "border-moss-800 text-moss-300"
                    : "border-ink-600 text-bone-400"
              }`}
            >
              {STEPS[step].kind}
            </span>
            {step > 0 ? <span>· {selected.id}</span> : null}
          </p>
          <h2 id="demo-step-title" className="mt-3 font-serif text-[38px] leading-none text-bone-50 sm:text-[46px]">
            {STEPS[step].title}
          </h2>
          <div key={`${step}-${selected.id}`} className="fade-in mt-8">
            {body}
          </div>
          <div className="hairline mt-10 flex flex-wrap items-center justify-between gap-3 border-t pt-6">
            <button type="button" className="btn" disabled={step === 0} onClick={() => go(step - 1)}>
              <span aria-hidden>←</span> Back
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={() => go(step + 1)}>
                Next: {STEPS[step + 1].title.toLowerCase()} <span aria-hidden>→</span>
              </button>
            ) : (
              <div className="flex flex-wrap justify-end gap-3">
                <a href={href("how")} className="btn">
                  Explore the technical architecture <span aria-hidden>→</span>
                </a>
                <a href={href()} className="btn btn-primary">
                  Back to the overview
                </a>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
