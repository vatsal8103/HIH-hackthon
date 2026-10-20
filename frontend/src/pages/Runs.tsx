import { Fragment, useState } from "react";

import { STAGES, api, type Attempt, type RunCase, type RunDetail } from "../api";
import { Empty, KindTag, Note, PageHead, RiskTag, STAGE_INFO, STAGE_ORDER, SectionHead, VerdictTag, dateTime, shortId, stageMetric, stagger } from "../components/ui";
import { OutcomeBar, OutcomeStrip } from "../components/Outcomes";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";

const SENSITIVE = /(BAYORA-CANARY-[A-Z0-9-]+|Mara Quell|MRN 00-4471|\[REDACTED\])/g;

/** Response text with leaked secrets and redactions marked. */
function ResponseText({ text }: { text: string }) {
  return (
    <pre className="mt-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-bone-200">
      {text.split(SENSITIVE).map((part, i) =>
        i % 2 ? (
          <mark key={i} className={part === "[REDACTED]" ? "bg-moss-900 text-moss-300" : "bg-rust-900 text-rust-300"}>
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </pre>
  );
}

function guardLine(attempt: Attempt): string | null {
  if (attempt.blocked_by) return `Blocked at input by ${attempt.blocked_by}`;
  const parts = [];
  if (attempt.transformed_by) parts.push(`input fenced by ${attempt.transformed_by}`);
  if (attempt.filtered_by) parts.push(`output rewritten by ${attempt.filtered_by}`);
  return parts.length ? parts.join(" · ") : null;
}

function AttemptBlock({ title, attempt }: { title: string; attempt: Attempt | null }) {
  if (!attempt) {
    return (
      <div>
        <p className="label">{title}</p>
        <p className="mt-2 text-[13px] text-bone-500">Not executed yet.</p>
      </div>
    );
  }
  const guard = guardLine(attempt);
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
        <p className="mt-2 text-[13px] text-bone-500">Queued for the target.</p>
      )}
      {attempt.criteria && (
        <ul className="mt-4 space-y-1.5">
          {attempt.criteria.map((result) => (
            <li key={result.id} className="flex gap-3 text-[12.5px]">
              <span className={`font-mono ${result.passed ? "text-moss-300" : "text-rust-300"}`}>{result.passed ? "✓" : "✕"}</span>
              <span className="text-bone-400">
                <span className="font-mono text-[11.5px] text-bone-200">{result.id}</span> · {result.evidence}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseRow({ item, open, onToggle, index }: { item: RunCase; open: boolean; onToggle: () => void; index: number }) {
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
        </span>
        <span className="hidden sm:block"><VerdictTag verdict={item.baseline?.verdict} /></span>
        <span className="hidden sm:block"><VerdictTag verdict={item.retest?.verdict} /></span>
        <span className="text-right"><RiskTag risk={item.residual?.residual_risk} /></span>
      </button>
      {open && (
        <div className="fade-in grid gap-8 px-0 pt-2 pb-8 sm:px-2 md:grid-cols-2">
          <div className="md:col-span-2">
            <p className="label">Prompt · submitted through the Red Team interface</p>
            <pre className="mt-2 border-l border-rust-500/60 pl-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-bone-200">
              {item.attack.prompt}
            </pre>
          </div>
          <AttemptBlock title="Baseline response" attempt={item.baseline} />
          <AttemptBlock title="Retest response" attempt={item.retest} />
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
        return (
          <li key={stage} className="relative grid grid-cols-[20px_1fr] gap-3 pb-5">
            {i < STAGES.length - 1 && <span className="absolute top-3 bottom-0 left-[5px] w-px bg-ink-600" />}
            <span className={`relative mt-1 size-[11px] border ${active ? "border-moss-300 bg-moss-400" : done ? "border-bone-200 bg-bone-200" : "border-ink-500 bg-ink-950"}`} />
            <div>
              <p className={`text-[14px] ${done ? "text-bone-50" : "text-bone-500"}`}>{STAGE_INFO[stage].title}</p>
              <p className="text-[11.5px] text-bone-500">{STAGE_INFO[stage].actor}</p>
              {done && <p className="mt-1 font-mono text-[11px] text-bone-200">{stageMetric(run, stage)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function RunDetailView({ id }: { id: string }) {
  const lab = useLab();
  const loaded = useLoad(() => api.run(id), [id, lab.version]);
  const run = lab.run?.id === id ? lab.run : loaded.data;
  const [open, setOpen] = useState<string | null>(null);

  if (loaded.error && !run) return <Note tone="error">{loaded.error}</Note>;
  if (!run) return <Empty>Loading run…</Empty>;

  return (
    <div className="space-y-12">
      <div className="reveal">
        <a href={href("runs")} className="label hover:text-bone-200">← All runs</a>
        <div className="mt-6 grid gap-10 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-5">
            <p className="label">Test run · started {dateTime(run.created_at)}</p>
            <h1 className="mt-3 font-mono text-[34px] tracking-tight text-bone-50 sm:text-[44px]">{shortId(run.id)}</h1>
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
              <p className="flex items-baseline gap-3">
                <span className="label">Residual</span>
                <RiskTag risk={run.report?.overall_risk} />
              </p>
              {run.status === "running" && !lab.busy && (
                <button type="button" className="btn btn-primary" onClick={() => lab.resume(run.id)}>Resume run</button>
              )}
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
          <p className="label mb-5">Stages</p>
          <StageRail run={run} />
        </aside>

        <div className="min-w-0 space-y-14 lg:col-span-9">
          <section>
            <SectionHead index="01" title="Cases" aside={<span className="label hidden sm:inline">Baseline · Retest · Residual</span>} />
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
            <SectionHead index="02" title="Defenses applied by the Blue Team" />
            {run.defenses.length === 0 ? (
              <Empty>No defensive rules applied yet.</Empty>
            ) : (
              <ul>
                {run.defenses.map((rule) => (
                  <li key={rule.rule_id} className="hairline grid gap-1 border-b py-4 sm:grid-cols-[220px_1fr_auto] sm:gap-6">
                    <span className="font-mono text-[12px] text-moss-300">{rule.rule_id}</span>
                    <span className="text-[13.5px] text-bone-400">{rule.description}</span>
                    <span className="label">{rule.stage} · for {rule.criterion}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHead index="03" title="Isolation checks" aside={<a href={href("isolation")} className="label hover:text-bone-200">Isolation lab →</a>} />
            {run.isolation.length === 0 ? (
              <Empty>Isolation checks run after the retest stage.</Empty>
            ) : (
              <ul>
                {run.isolation.map((check) => (
                  <li key={check.check_id} className="hairline grid gap-2 border-b py-4 sm:grid-cols-[72px_1fr_100px] sm:gap-6">
                    <span className="font-mono text-[12px] text-bone-500">{check.check_id}</span>
                    <div>
                      <p className="text-[14px]">{check.title}</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-bone-500">{check.detail}</p>
                    </div>
                    <div className="flex flex-col items-start gap-1.5 sm:items-end">
                      <KindTag kind={check.kind} />
                      <span className={`font-mono text-[11px] uppercase ${check.status === "pass" ? "text-moss-300" : check.status === "fail" ? "text-rust-300" : "text-bone-500"}`}>{check.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function RunList() {
  const { version, busy, start } = useLab();
  const { data: runs, error } = useLoad(() => api.runs(), [version]);

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Test runs" title="Every session, staged and recorded.">
        Each run moves through seven backend stages. Open one to inspect prompts, target responses, verdicts and what the Blue Team changed.
      </PageHead>
      {error && <Note tone="error">{error}</Note>}
      <section>
        <SectionHead index="01" title="Sessions" aside={<button type="button" className="label hover:text-bone-200 disabled:opacity-40" disabled={busy} onClick={() => start()}>New run →</button>} />
        {runs?.length === 0 && <Empty>No runs yet. Start one from the overview.</Empty>}
        {runs && runs.length > 0 && (
          <table className="w-full text-left">
            <caption className="sr-only">Test sessions, newest first</caption>
            <thead className="label">
              <tr className="hairline border-b">
                <th scope="col" className="py-3 pr-4 font-normal">Run</th>
                <th scope="col" className="hidden py-3 pr-4 font-normal sm:table-cell">Started</th>
                <th scope="col" className="hidden w-[38%] py-3 pr-4 font-normal md:table-cell">Outcome · passed / mitigated / failing</th>
                <th scope="col" className="py-3 pr-4 font-normal">Stage</th>
                <th scope="col" className="py-3 text-right font-normal">Residual</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr key={run.id} className="hairline fade-in border-b transition-colors hover:bg-ink-900" style={stagger(i)}>
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
                  <td className="py-4 pr-4 font-mono text-[12px] text-bone-400">{run.status === "completed" ? "complete" : run.stage}</td>
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
