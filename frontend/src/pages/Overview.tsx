import { useRef, useState, type ReactNode } from "react";

import { STAGES, type Attempt, type RunCase, type RunDetail } from "../api";
import { OutcomeTag, TargetNotice, Technical, guardLine, useRuleName } from "../components/Explain";
import { OutcomeStrip } from "../components/Outcomes";
import { Pipeline } from "../components/Pipeline";
import { Note, RiskTag, SectionHead, VerdictTag, dateTime, groupHash, shortId, stagger } from "../components/ui";
import {
  OUTCOME_MEANING,
  PLAIN_STAGE,
  RISK_PLAIN,
  TONE_TEXT,
  caseOutcome,
  liveHost,
  outcomeCounts,
  refusedStage,
  riskTone,
  spotlightCase,
} from "../explain";
import { href, useReducedMotion } from "../hooks";
import { useLab } from "../lab";
import { SecurityCore } from "../scene/SecurityCore";
import type { SceneStage } from "../scene/model";

const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);
const stoppedAfter = (run: RunDetail) => (run.stage === "created" ? "the start" : `“${PLAIN_STAGE[run.stage].name}”`);
const textButton = "text-bone-200 underline decoration-ink-500 underline-offset-4 hover:decoration-bone-400";

/** What Bayora does, the two actions, and the environment notice. */
function Intro() {
  const { run, playing, busy, start, resume, skip, meta } = useLab();
  const paused = run && !run.report && !busy ? run : null;
  return (
    <div className="flex flex-col">
      <p className="label reveal">AI security testing lab</p>
      <h1 className="reveal mt-4 font-serif text-[46px] leading-[0.95] tracking-[-0.015em] text-bone-50 sm:text-[68px]" style={stagger(1)}>
        Can your AI withstand an attack?
      </h1>
      <p className="reveal mt-6 max-w-[32rem] text-[16px] leading-relaxed text-bone-400" style={stagger(2)}>
        Bayora runs controlled security tests against AI systems, evaluates their responses, tests configured defenses,
        and records evidence of what happened.
      </p>
      <div className="reveal mt-8 flex flex-wrap items-center gap-3" style={stagger(3)}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start()}>
          {busy ? "Test running…" : "Run a security test"} <span aria-hidden>→</span>
        </button>
        <a href={href("how")} className="btn">
          See how it works
        </a>
      </div>
      <p className="reveal mt-3 max-w-[32rem] text-[12.5px] leading-relaxed text-bone-500" style={stagger(3)} aria-live="polite">
        {busy && playing ? (
          <>
            Running now · step {STAGES.indexOf(playing) + 1} of 7 · {PLAIN_STAGE[playing].name}.{" "}
            <button type="button" className={textButton} onClick={skip}>
              Skip the animation
            </button>
          </>
        ) : busy ? (
          "Starting a new test session…"
        ) : paused ? (
          <>
            The latest run stopped after {stoppedAfter(paused)}.{" "}
            <button type="button" className={textButton} onClick={() => resume(paused.id)}>
              Resume it
            </button>{" "}
            to finish the remaining steps.
          </>
        ) : meta?.target?.kind === "live" && liveHost(meta.target.provider) === "groq" ? (
          "Sends every attack to the model hosted by Groq, a third party; a full run usually takes about a minute. Each run is saved with its audit record."
        ) : meta?.target?.kind === "live" ? (
          <>
            Sends every attack to the live model. A local reasoning model can take minutes per answer, so a full run may
            take 20 minutes or more; for a quick demo, choose one or two attacks in the{" "}
            <a href={href("attacks")} className={textButton}>
              Attack library
            </a>
            .
          </>
        ) : (
          "Sends every attack in the library, step by step, in about 15 seconds. Each run is saved with its audit record."
        )}
      </p>
      <TargetNotice className="reveal mt-7" />
    </div>
  );
}

function Stat({ label, value, tone = "text-bone-50", children }: { label: string; value: ReactNode; tone?: string; children: ReactNode }) {
  return (
    <div className="bg-ink-950 p-4 sm:p-5 lg:p-6">
      <dt className="label">{label}</dt>
      <dd className={`mt-3 font-serif text-[38px] leading-none sm:text-[44px] ${tone}`}>{value}</dd>
      <dd className="mt-2.5 text-[12.5px] leading-snug text-bone-500">{children}</dd>
    </div>
  );
}

/** Four numbers from the run's recorded verdicts and its report, each with one short, non-overlapping note. */
function Summary({ run }: { run: RunDetail }) {
  const report = run.report!;
  const counts = outcomeCounts(run.cases);
  const passed = counts.fromStart + counts.afterProtection;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-px bg-ink-700 lg:grid-cols-4">
        <Stat label="Attacks tested" value={counts.total}>
          {report.counts.baseline_failures} worked before any protection.
        </Stat>
        <Stat label="Passed on retest" value={passed} tone="text-moss-300">
          {counts.afterProtection
            ? `${counts.afterProtection} only after a protection${counts.masked ? `; ${counts.masked} hidden, not fixed` : ""}.`
            : "All of them passed from the start."}
        </Stat>
        <Stat label="Still vulnerable" value={counts.failing} tone={counts.failing ? "text-rust-300" : "text-bone-50"}>
          {counts.failing ? "Failed the retry with protections in place." : "None failed the retry."}
        </Stat>
        <Stat label="Highest remaining risk" value={capitalize(report.overall_risk)} tone={TONE_TEXT[riskTone(report.overall_risk)]}>
          {RISK_PLAIN[report.overall_risk]}
        </Stat>
      </dl>
      <p className="mt-3 text-[12.5px] leading-relaxed text-bone-500">
        Results of {counts.total} scripted test{counts.total === 1 ? "" : "s"} in a controlled lab. Passing them does not prove the AI is
        safe against attacks that were not tried.
      </p>
    </div>
  );
}

const LEGEND = (["stopped", "masked", "vulnerable"] as const).map((key) => OUTCOME_MEANING[key]);

const VERDICT_TEXT = { pass: "text-moss-300", fail: "text-rust-300" } as const;

/** First try, retry and remaining risk as text, from the run's recorded attempts and residual. */
function AttemptLine({ item }: { item: RunCase }) {
  const verdict = (attempt: RunCase["baseline"]) =>
    attempt?.verdict ? <span className={VERDICT_TEXT[attempt.verdict]}>{attempt.verdict}</span> : "pending";
  const risk = item.residual?.residual_risk;
  // Spans the name and outcome columns; each "label value" pair stays together if it has to wrap.
  return (
    <span className="col-span-2 col-start-2 -mt-1 flex flex-wrap gap-x-2 font-mono text-[10.5px] text-bone-500">
      <span className="whitespace-nowrap">first try {verdict(item.baseline)}</span>
      <span aria-hidden>·</span>
      <span className="whitespace-nowrap">retry {verdict(item.retest)}</span>
      <span aria-hidden>·</span>
      <span className="whitespace-nowrap">risk {risk ? <span className={TONE_TEXT[riskTone(risk)]}>{risk}</span> : "pending"}</span>
    </span>
  );
}

function CaseButton({ item, selected, onSelect, detail = false }: { item: RunCase; selected: boolean; onSelect: () => void; detail?: boolean }) {
  const outcome = caseOutcome(item, useRuleName());
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`hairline grid w-full grid-cols-[52px_1fr_auto] items-baseline gap-3 border-b py-2.5 pl-2 text-left transition-colors ${
        selected ? "bg-ink-850" : "hover:bg-ink-900"
      }`}
    >
      <span className="font-mono text-[11px] text-bone-500">{item.attack.id}</span>
      <span className="min-w-0 truncate text-[13.5px] text-bone-200">{item.attack.title}</span>
      <span className="pr-2">
        <OutcomeTag outcome={outcome} />
      </span>
      {detail && <AttemptLine item={item} />}
    </button>
  );
}

function RuleResult({ label, attempt, id }: { label: string; attempt: Attempt | null; id: string }) {
  const result = attempt?.criteria?.find((c) => c.id === id);
  if (!result) return <p>{label}: not recorded</p>;
  return (
    <p>
      {label}:{" "}
      <span className={result.passed ? "text-moss-300" : "text-rust-300"}>{result.passed ? "passed" : "failed"}</span>
      {result.evidence ? ` · ${result.evidence}` : ""}
    </p>
  );
}

/** The selected finding in plain words, with the recorded evidence behind it one click away. */
function Finding({ item }: { item: RunCase }) {
  const ruleName = useRuleName();
  const { meta } = useLab();
  const outcome = caseOutcome(item, ruleName);
  const broken = item.baseline?.criteria?.filter((c) => !c.passed) ?? [];
  const risk = item.residual?.residual_risk;
  const acted = item.retest ? guardLine(item.retest, ruleName) : null;
  const rows: [string, ReactNode][] = [
    ["What was tested", item.attack.technique],
    ["What the attack tried", item.attack.objective],
    [
      "What the AI did first",
      broken.length
        ? `It broke ${broken.length === 1 ? "a safety rule" : `${broken.length} safety rules`}: ${broken
            .map((c) => meta?.criteria[c.id]?.title ?? c.id)
            .join("; ")}.`
        : "It did not break any of the safety rules for this test.",
    ],
    ["Did the protection help?", outcome.sentence],
    ["What to do next", item.residual?.recommendation ?? (risk ? RISK_PLAIN[risk] : "No report yet.")],
  ];
  return (
    <article className="hairline border p-5 sm:p-8" aria-labelledby="finding-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="label">Selected finding · {item.attack.id}</p>
        <OutcomeTag outcome={outcome} />
      </div>
      <h3 id="finding-title" className="mt-3 font-serif text-[30px] leading-tight text-bone-50 sm:text-[34px]">
        {item.attack.title}
      </h3>
      <dl className="mt-5 space-y-4">
        {rows.map(([term, value]) => (
          <div key={term} className="grid gap-1 sm:grid-cols-[170px_1fr] sm:gap-6">
            <dt className="text-[12.5px] text-bone-500">{term}</dt>
            <dd className="text-[14px] leading-relaxed text-bone-200">{value}</dd>
          </div>
        ))}
      </dl>
      <Technical summary="Technical evidence">
        <dl className="space-y-2">
          <div>
            <dt className="text-bone-500">Verdicts</dt>
            <dd>
              First attempt <VerdictTag verdict={item.baseline?.verdict} /> · retry <VerdictTag verdict={item.retest?.verdict} /> ·
              remaining risk <RiskTag risk={risk} />
            </dd>
          </div>
          <div>
            <dt className="text-bone-500">Protection that acted on the retry</dt>
            <dd>{acted ?? "None recorded"}</dd>
          </div>
          <div>
            <dt className="text-bone-500">Recorded reason</dt>
            <dd>{item.residual?.rationale ?? "Not recorded"}</dd>
          </div>
        </dl>
        <p className="mt-4 text-bone-500">Rule results</p>
        <ul className="mt-1.5 space-y-3">
          {item.attack.criteria.map((id) => (
            <li key={id}>
              <p className="text-bone-200">
                {meta?.criteria[id]?.title ?? id} <span className="font-mono text-[10.5px] text-bone-500">{id}</span>
              </p>
              <RuleResult label="First attempt" attempt={item.baseline} id={id} />
              <RuleResult label="Retry" attempt={item.retest} id={id} />
            </li>
          ))}
        </ul>
      </Technical>
    </article>
  );
}

/** The report's audit snapshot as a historical fact, kept apart from the current record. */
function Evidence({ run }: { run: RunDetail }) {
  const report = run.report!;
  const audit = report.audit;
  const witness =
    audit.checkpoint === "ok"
      ? `witness checkpoints covered entries up to #${audit.anchored_seq}`
      : audit.checkpoint === "not-configured"
        ? "no witness was configured"
        : audit.checkpoint
          ? `witness status: ${audit.checkpoint}`
          : "witness status not recorded";
  return (
    <div className="space-y-2 text-[13.5px] leading-relaxed text-bone-400">
      <p className="label">Evidence record</p>
      <p>
        <span className="text-bone-200">When the report was made</span> ({dateTime(report.generated_at)}): the record was{" "}
        <span className={audit.ok ? "text-moss-300" : "text-rust-300"}>{audit.ok ? "intact" : "broken"}</span> across{" "}
        {audit.checked} entries; {witness}.
      </p>
      <p>
        <span className="text-bone-200">The current record</span> is not checked on this page.{" "}
        <a href={href("audit")} className={textButton}>
          Verify the current record →
        </a>
      </p>
      <Technical summary="Head hash at report time">
        <span className="font-mono text-[11px] break-words">{groupHash(audit.head_hash)}</span>
      </Technical>
    </div>
  );
}

/** A finished run: the numbers, what needs attention (selectable), every attack (secondary), and the selected finding. */
function CompletedRun({ run }: { run: RunDetail }) {
  const attention = run.cases.filter((c) => ["vulnerable", "regressed", "masked"].includes(caseOutcome(c).key));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = run.cases.find((c) => c.attack.id === selectedId) ?? spotlightCase(run);
  const panel = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const select = (item: RunCase) => () => {
    setSelectedId(item.attack.id);
    // Below lg the panel sits under the list; bring it into view so the selection visibly does something.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" }));
    }
  };

  return (
    <div className="space-y-10 pt-6 lg:space-y-12">
      <Summary run={run} />
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
        <div className="min-w-0 space-y-8 lg:col-span-5">
          <div>
            <p className="label">
              Needs attention · {attention.length}
              <span className="sr-only"> findings; select one to see it explained</span>
            </p>
            {attention.length === 0 ? (
              <p className="mt-3 text-[13.5px] text-moss-300">Nothing in this run: no attack still works and none is only hidden.</p>
            ) : (
              <ul className="mt-2">
                {attention.map((item) => (
                  <li key={item.attack.id}>
                    <CaseButton item={item} selected={selected?.attack.id === item.attack.id} onSelect={select(item)} />
                  </li>
                ))}
              </ul>
            )}
            <dl className="mt-4 space-y-1.5 text-[12.5px] leading-snug">
              {LEGEND.map((entry) => (
                <div key={entry.label}>
                  <dt className={`inline font-medium ${TONE_TEXT[entry.tone]}`}>{entry.label}:</dt>{" "}
                  <dd className="inline text-bone-500">{entry.meaning}</dd>
                </div>
              ))}
            </dl>
          </div>

          <details className="group">
            <summary className="label cursor-pointer list-none hover:text-bone-200">
              <span aria-hidden className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
              All {run.cases.length} attacks in this run
            </summary>
            <div className="mt-4 space-y-4">
              <OutcomeStrip run={run} />
              <ul>
                {run.cases.map((item) => (
                  <li key={item.attack.id}>
                    <CaseButton item={item} selected={selected?.attack.id === item.attack.id} onSelect={select(item)} detail />
                  </li>
                ))}
              </ul>
            </div>
          </details>

          <Evidence run={run} />

          <div className="flex flex-wrap gap-3">
            <a href={href("reports", run.id)} className="btn">
              Open the risk report
            </a>
            <a href={href("runs", run.id)} className="btn">
              Prompts and answers
            </a>
          </div>
        </div>
        <div ref={panel} className="min-w-0 scroll-mt-20 lg:col-span-7" aria-live="polite">
          {selected && <Finding item={selected} />}
        </div>
      </div>
    </div>
  );
}

function LatestRun() {
  const { run, runLoad, busy, playing, failed } = useLab();

  let body: ReactNode;
  if (!run && runLoad === "loading") {
    body = <p className="py-8 text-[14px] text-bone-500">Loading the latest run…</p>;
  } else if (!run && runLoad === "failed") {
    body = (
      <div className="pt-6">
        <Note tone="error">
          The latest run could not be loaded (the message at the top of the page says why). Saved runs are not lost: reload
          once the API answers, or open <a href={href("runs")} className="text-bone-50 underline underline-offset-4">Test runs</a>.
        </Note>
      </div>
    );
  } else if (!run) {
    body = (
      <p className="max-w-2xl py-8 text-[14px] leading-relaxed text-bone-400">
        No test has run yet. <span className="text-bone-50">Run a security test</span> sends every attack in the library to
        the target, checks each answer, lets the Blue Team add protections, tries again and records every step. To choose
        specific attacks, open the{" "}
        <a href={href("attacks")} className="text-bone-50 underline decoration-ink-500 underline-offset-4">
          Attack library
        </a>
        .
      </p>
    );
  } else if (!run.report) {
    const refused = refusedStage(failed, run);
    body = (
      <div className="space-y-6 pt-6">
        {!busy && (
          <Note tone={refused ? "error" : "warn"}>
            This run is not complete: it stopped after {stoppedAfter(run)}
            {refused ? `, because the backend refused the “${PLAIN_STAGE[refused].name}” step (the message at the top of the page says why)` : ""}.
            It has no report yet. Resume it from the link above; finished steps are not repeated.
          </Note>
        )}
        <Pipeline run={run} playing={playing} failedAt={refused} />
      </div>
    );
  } else {
    body = <CompletedRun key={run.id} run={run} />;
  }

  return (
    <section>
      <SectionHead
        index="01"
        title={run && !run.report ? "The latest run · not complete" : "The latest run"}
        aside={
          run && (
            <a href={href("runs", run.id)} className="label hover:text-bone-200">
              {shortId(run.id)} · {dateTime(run.created_at)} →
            </a>
          )
        }
      />
      {body}
    </section>
  );
}

export function Overview() {
  const { run, playing } = useLab();
  const stage: SceneStage = playing ?? run?.stage ?? "idle";
  const stageIndex = playing ? STAGES.indexOf(playing) + 1 : null;

  return (
    <div className="space-y-14 lg:space-y-20">
      <section className="grid gap-10 lg:grid-cols-12 lg:gap-12">
        <div className="min-w-0 lg:col-span-5 lg:pt-6">
          <Intro />
        </div>
        <figure
          className="ticks hairline reveal relative h-[380px] min-w-0 border sm:h-[500px] lg:col-span-7 lg:h-[600px]"
          style={stagger(1)}
          aria-label="Isolation lattice: Red Team, Target and Blue Team zones separated by gated walls"
        >
          <SecurityCore run={run} stage={stage} playing={Boolean(playing)} />
          <figcaption className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between gap-4">
            <span className="label whitespace-nowrap">
              Fig. 01<span className="hidden sm:inline"> · Tester, target and defender, kept apart</span>
            </span>
            {stageIndex ? (
              <span className="label text-right text-moss-300">
                Step 0{stageIndex} / 07<span className="hidden sm:inline"> · {PLAIN_STAGE[playing!].name}</span>
              </span>
            ) : (
              <span className="label hidden text-right sm:inline">{run?.report ? "Final state · latest run" : "Idle"}</span>
            )}
          </figcaption>
        </figure>
      </section>

      <LatestRun />
    </div>
  );
}
