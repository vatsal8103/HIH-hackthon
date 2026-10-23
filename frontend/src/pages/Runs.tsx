import { useState } from "react";

import { STAGES, api, type Attempt, type RunCase, type RunDetail } from "../api";
import { Help, KindLegend, OutcomeTag, ResponseText, Technical, guardLine, useRuleName } from "../components/Explain";
import { Empty, KindTag, Note, PageHead, RiskTag, STAGE_ORDER, SectionHead, VerdictTag, dateTime, shortId, stagger } from "../components/ui";
import { OutcomeBar, OutcomeStrip } from "../components/Outcomes";
import { PLAIN_STAGE, TONE_TEXT, caseOutcome, isolationCounts, stageResult } from "../explain";
import { href, navigate, useLoad } from "../hooks";
import { useLab } from "../lab";

function AttemptBlock({ title, attempt }: { title: string; attempt: Attempt | null }) {
  const { meta } = useLab();
  const ruleName = useRuleName();
  if (!attempt) {
    return (
      <div>
        <p className="label">{title}</p>
        <p className="mt-2 text-[13px] text-bone-500">Not executed yet.</p>
      </div>
    );
  }
  const guard = guardLine(attempt, ruleName);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="label">{title}</p>
        <VerdictTag verdict={attempt.verdict} />
      </div>
      {guard && <p className="mt-2 font-mono text-[11px] text-moss-300">{guard}</p>}
      {attempt.response ? (
        <ResponseText text={attempt.response} />
      ) : (
        <p className="mt-2 text-[13px] text-bone-500">Waiting for the target to answer.</p>
      )}
      {attempt.criteria && (
        <ul className="mt-4 space-y-1.5">
          {attempt.criteria.map((result) => (
            <li key={result.id} className="flex gap-3 text-[12.5px]">
              <span className={`font-mono ${result.passed ? "text-moss-300" : "text-rust-300"}`}>{result.passed ? "✓" : "✕"}</span>
              <span className="text-bone-400">
                <span className="text-bone-200">{meta?.criteria[result.id]?.title ?? result.id}</span>
                <span className="sr-only">{result.passed ? " passed" : " failed"}</span> · {result.evidence}
                <span className="ml-1.5 font-mono text-[10.5px] text-bone-500">{result.id}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseRow({ item, open, onToggle, index }: { item: RunCase; open: boolean; onToggle: () => void; index: number }) {
  const outcome = caseOutcome(item, useRuleName());
  return (
    <li className="hairline reveal border-b" style={stagger(index)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[60px_1fr_auto] items-baseline gap-x-4 gap-y-1 py-4 text-left transition-colors hover:bg-ink-900 sm:grid-cols-[72px_1fr_88px_88px_96px] sm:px-2"
      >
        <span className="font-mono text-[12px] text-bone-200">{item.attack.id}</span>
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] font-medium tracking-tight">{item.attack.title}</span>
          <span className="block truncate text-[12px] text-bone-500">{item.attack.technique}</span>
          <span className="mt-1 block"><OutcomeTag outcome={outcome} /></span>
        </span>
        <span className="hidden sm:block"><VerdictTag verdict={item.baseline?.verdict} /></span>
        <span className="hidden sm:block"><VerdictTag verdict={item.retest?.verdict} /></span>
        <span className="text-right"><RiskTag risk={item.residual?.residual_risk} /></span>
      </button>
      {open && (
        <div className="fade-in grid gap-8 px-0 pt-2 pb-8 sm:px-2 md:grid-cols-2">
          <p className={`text-[14px] leading-relaxed md:col-span-2 ${TONE_TEXT[outcome.tone]}`}>
            <span className="label mr-2">In plain words</span>
            {outcome.sentence}
          </p>
          <div className="md:col-span-2">
            <p className="label">What the attack tried</p>
            <p className="mt-2 text-[13.5px] text-bone-400">{item.attack.objective}</p>
          </div>
          <div className="md:col-span-2">
            <p className="label">Prompt · submitted through the Red Team interface</p>
            <pre className="mt-2 border-l border-rust-500/60 pl-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-bone-200">
              {item.attack.prompt}
            </pre>
          </div>
          <AttemptBlock title="First attempt · baseline" attempt={item.baseline} />
          <AttemptBlock title="Retry with protections · retest" attempt={item.retest} />
          {item.residual && (
            <div className="md:col-span-2">
              <Note tone={item.residual.residual_risk === "high" || item.residual.residual_risk === "critical" ? "error" : item.residual.residual_risk === "medium" ? "warn" : "neutral"}>
                {item.residual.rationale}
                {item.residual.recommendation && <span className="mt-1 block text-bone-200">{item.residual.recommendation}</span>}
              </Note>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function StageRail({ run }: { run: RunDetail }) {
  const { playing } = useLab();
  return (
    <ol className="space-y-0">
      {STAGES.map((stage, i) => {
        const done = run.stage !== "created" && STAGE_ORDER[run.stage] >= STAGE_ORDER[stage];
        const active = playing === stage;
        const result = stageResult(run, stage);
        return (
          <li key={stage} className="relative grid grid-cols-[20px_1fr] gap-3 pb-5">
            {i < STAGES.length - 1 && <span className="absolute top-3 bottom-0 left-[5px] w-px bg-ink-600" />}
            <span className={`relative mt-1 size-[11px] border ${active ? "border-moss-300 bg-moss-400" : done ? "border-bone-200 bg-bone-200" : "border-ink-500 bg-ink-950"}`} />
            <div>
              <p className={`text-[14px] ${done ? "text-bone-50" : "text-bone-500"}`}>
                {PLAIN_STAGE[stage].name}
                <span className="sr-only">, {active ? "running" : done ? "completed" : "waiting"}</span>
              </p>
              <p className="font-mono text-[10.5px] tracking-[0.08em] text-bone-500 uppercase">{PLAIN_STAGE[stage].who}</p>
              {result && <p className={`mt-1 font-mono text-[11px] ${TONE_TEXT[result.tone]}`}>{result.text}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DefenseRow({ rule }: { rule: RunDetail["defenses"][number] }) {
  const { meta } = useLab();
  return (
    <li className="hairline grid gap-1 border-b py-4 sm:grid-cols-[220px_1fr] sm:gap-6">
      <span>
        <span className="block text-[14px] text-moss-300">{rule.title}</span>
        <span className="block font-mono text-[11px] text-bone-500">{rule.rule_id}</span>
      </span>
      <span className="text-[13.5px] leading-relaxed text-bone-400">
        {rule.description} {rule.stage === "input" ? "It checks the prompt before the AI sees it." : "It checks the AI's answer before it is returned."}
        <span className="mt-1 block text-[12.5px] text-bone-500">
          Added because “{meta?.criteria[rule.criterion]?.title ?? rule.criterion}” failed.
        </span>
      </span>
    </li>
  );
}

function IsolationSummary({ run }: { run: RunDetail }) {
  const { tested, failures, untested } = isolationCounts(run.isolation);
  return (
    <div className="pt-4">
      <p className={`text-[14px] ${failures ? "text-rust-300" : "text-bone-200"}`}>
        {failures ? `${failures} of ${tested} checks that ran failed` : `${tested} of ${tested} checks that ran passed`}
        {untested ? `; ${untested} not tested in this deployment (simulated or planned)` : ""}.
      </p>
      <Technical summary="Every check, with what enforced it">
        <ul>
          {run.isolation.map((check) => (
            <li key={check.check_id} className="hairline grid gap-2 border-b py-3 sm:grid-cols-[64px_1fr_120px] sm:gap-5">
              <span className="font-mono text-[11.5px] text-bone-500">{check.check_id}</span>
              <div>
                <p className="text-[13.5px] text-bone-200">{check.title}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-bone-500">{check.detail}</p>
              </div>
              <div className="flex flex-col items-start gap-1.5 sm:items-end">
                <KindTag kind={check.kind} />
                <span className={`font-mono text-[11px] uppercase ${check.status === "pass" ? "text-moss-300" : check.status === "fail" ? "text-rust-300" : "text-bone-500"}`}>{check.status}</span>
              </div>
            </li>
          ))}
        </ul>
        <KindLegend />
      </Technical>
    </div>
  );
}

function RunDetailView({ id }: { id: string }) {
  const lab = useLab();
  const loaded = useLoad(() => api.run(id), [id, lab.version]);
  const run = lab.run?.id === id ? lab.run : loaded.data;
  const [open, setOpen] = useState<string | null>(null);

  if (loaded.error && !run) {
    return (
      <div className="space-y-6">
        <a href={href("runs")} className="label hover:text-bone-200">← All runs</a>
        <Note tone="error">Could not open run {shortId(id)}: {loaded.error}</Note>
      </div>
    );
  }
  if (!run) return <Empty>Loading run {shortId(id)}…</Empty>;

  return (
    <div className="space-y-12">
      <div className="reveal">
        <a href={href("runs")} className="label hover:text-bone-200">← All runs</a>
        <div className="mt-6 grid gap-10 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-5">
            <p className="label">
              Test run · started {dateTime(run.created_at)}
              {run.report?.deployment?.target_provider &&
                ` · target ${run.report.deployment.target_provider}${run.report.deployment.target_kind === "live" ? " (live model)" : ""}`}
            </p>
            <h1 className="mt-3 font-mono text-[34px] tracking-tight text-bone-50 sm:text-[44px]">{shortId(run.id)}</h1>
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
              <p className="flex items-baseline gap-3">
                <span className="label">Remaining risk</span>
                <RiskTag risk={run.report?.overall_risk} />
              </p>
              {run.status === "running" && !lab.busy && (
                <button type="button" className="btn btn-primary" onClick={() => lab.resume(run.id)}>Resume run</button>
              )}
              {run.status === "running" && lab.busy && lab.run?.id === run.id && <span className="label text-moss-300">Running now</span>}
              {run.report && <a href={href("reports", run.id)} className="btn">Open report</a>}
            </div>
          </div>
          <div className="min-w-0 lg:col-span-6 lg:col-start-7">
            <OutcomeStrip run={run} />
          </div>
        </div>
      </div>

      <div className="grid gap-12 lg:grid-cols-12">
        <aside className="min-w-0 lg:sticky lg:top-10 lg:col-span-3 lg:self-start">
          <p className="label mb-5">Steps</p>
          <StageRail run={run} />
        </aside>

        <div className="min-w-0 space-y-14 lg:col-span-9">
          <section>
            <SectionHead index="01" title="Attacks in this run" aside={<span className="label hidden sm:inline">First try · Retry · Remaining risk</span>} />
            <p className="mt-3 text-[13px] text-bone-500">Open an attack to see the prompt, what the AI answered each time, and which rules it broke.</p>
            <ul>
              {run.cases.map((item, i) => (
                <CaseRow
                  key={item.attack.id}
                  item={item}
                  index={i}
                  open={open === item.attack.id}
                  onToggle={() => setOpen(open === item.attack.id ? null : item.attack.id)}
                />
              ))}
            </ul>
          </section>

          <section>
            <SectionHead index="02" title="Protections added by the Blue Team" />
            {run.defenses.length === 0 ? (
              <Empty>No protections added{run.report ? ": nothing in this run failed at first." : " yet."}</Empty>
            ) : (
              <ul>
                {run.defenses.map((rule) => (
                  <DefenseRow key={rule.rule_id} rule={rule} />
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHead index="03" title="Isolation checks for this run" aside={<a href={href("isolation")} className="label hover:text-bone-200">Isolation lab →</a>} />
            {run.isolation.length === 0 ? (
              <Empty>Isolation checks run after the retry step.</Empty>
            ) : (
              <IsolationSummary run={run} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function RunList() {
  const { version, busy, start, run: current } = useLab();
  const { data: runs, error } = useLoad(() => api.runs(), [version]);

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Test runs" title="Every test, step by step.">
        Each run sends attacks to the target, checks the answers, adds protections and tries again, in seven recorded steps.
        Open one to see the prompts, what the AI answered, and what the Blue Team changed.
        <Help term="a run">
          A run is one test session. It is saved permanently with its audit record, so older runs stay here for comparison.
        </Help>
      </PageHead>
      {error && <Note tone="error">Could not load the list of runs: {error}</Note>}
      <section>
        <SectionHead
          index="01"
          title="Sessions"
          aside={
            <button
              type="button"
              className="label hover:text-bone-200 disabled:opacity-40"
              disabled={busy}
              onClick={() => (navigate(), void start())}
            >
              {busy ? "A run is in progress" : "New run (watch on the overview) →"}
            </button>
          }
        />
        {!runs && !error && <Empty>Loading runs…</Empty>}
        {runs?.length === 0 && <Empty>No runs yet. Start one with “Run a security test” on the overview.</Empty>}
        {runs && runs.length > 0 && (
          <table className="w-full text-left">
            <caption className="sr-only">Test sessions, newest first</caption>
            <thead className="label">
              <tr className="hairline border-b">
                <th scope="col" className="py-3 pr-4 font-normal">Run</th>
                <th scope="col" className="hidden py-3 pr-4 font-normal sm:table-cell">Started</th>
                <th scope="col" className="hidden w-[38%] py-3 pr-4 font-normal md:table-cell">Result · passed at first / after protection / still failing</th>
                <th scope="col" className="py-3 pr-4 font-normal">Progress</th>
                <th scope="col" className="py-3 text-right font-normal">Remaining risk</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr
                  key={run.id}
                  className="hairline fade-in cursor-pointer border-b transition-colors hover:bg-ink-900"
                  style={stagger(i)}
                  // The run id link is the keyboard and screen-reader path; the whole row is a larger mouse target.
                  onClick={(event) => !(event.target as HTMLElement).closest("a") && navigate("runs", run.id)}
                >
                  <th scope="row" className="py-4 pr-4 font-normal">
                    <a href={href("runs", run.id)} className="font-mono text-[13px] text-bone-50 underline decoration-ink-600 underline-offset-4 hover:decoration-bone-400">
                      {shortId(run.id)}
                    </a>
                    <span className="mt-1 block text-[12px] text-bone-500 sm:hidden">{dateTime(run.created_at)}</span>
                  </th>
                  <td className="hidden py-4 pr-4 text-[13px] text-bone-400 sm:table-cell">{dateTime(run.created_at)}</td>
                  <td className="hidden py-4 pr-4 md:table-cell">
                    <div className="flex items-center gap-4">
                      <OutcomeBar counts={run.counts} />
                      <span className="shrink-0 font-mono text-[11px] text-bone-400">
                        {run.counts
                          ? `${run.counts.cases - run.counts.baseline_failures} / ${run.counts.mitigated} / ${run.counts.residual_failures}`
                          : `${run.attack_ids.length} cases`}
                      </span>
                    </div>
                  </td>
                  <td className="py-4 pr-4 text-[12.5px] text-bone-400">
                    {run.status === "completed"
                      ? "Complete"
                      : busy && current?.id === run.id
                        ? "Running"
                        : `Stopped after ${run.stage === "created" ? "start" : PLAIN_STAGE[run.stage].name}`}
                  </td>
                  <td className="py-4 text-right"><RiskTag risk={run.overall_risk} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function Runs({ id }: { id?: string }) {
  return id ? <RunDetailView id={id} /> : <RunList />;
}
