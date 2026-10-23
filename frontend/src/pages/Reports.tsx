import { api, type RunDetail } from "../api";
import { Help, OutcomeTag, Technical, useRuleName } from "../components/Explain";
import { Empty, Note, PageHead, RiskTag, VerdictTag, dateTime, groupHash, riskText, shortId } from "../components/ui";
import { RISK_PLAIN, caseOutcome } from "../explain";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";

const WITNESS_TEXT = {
  ok: "text-moss-300",
  "not-configured": "text-amber-300",
  mismatch: "text-rust-300",
  unavailable: "text-rust-300",
} as const;

/** The selected run's report: remaining issues first, then every attack, then supporting evidence. */
function ReportDocument({ run }: { run: RunDetail }) {
  const report = run.report!;
  const { meta } = useLab();
  const ruleName = useRuleName();
  const recorded = new Map(run.cases.map((c) => [c.attack.id, c]));
  // A retry that still fails is always an issue, even at low severity (for example a protection blocking a harmless request).
  const issues = report.cases.filter((c) => c.retest_verdict === "fail" || ["medium", "high", "critical"].includes(c.residual_risk));
  const lowRisk = report.cases.filter((c) => c.residual_risk === "low" && c.retest_verdict === "pass");

  return (
    <article className="hairline fade-in border bg-ink-900 p-6 sm:p-10 lg:p-14 print:border-0 print:bg-white print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="label">
            Risk report ·{" "}
            <a href={href("runs", run.id)} className="hover:text-bone-200">
              run {shortId(run.id)}
            </a>
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-bone-500">
            Run started {dateTime(run.created_at)} · report made {dateTime(report.generated_at)}
          </p>
          {report.deployment?.target_provider && (
            <p className="mt-1 font-mono text-[11px] text-bone-500">
              Target in this run:{" "}
              <span className={report.deployment.target_kind === "live" ? "text-bone-200" : "text-amber-300"}>
                {report.deployment.target_provider} ({report.deployment.target_kind === "live" ? "live model" : report.deployment.target_kind})
              </span>
            </p>
          )}
        </div>
        <button type="button" className="btn no-print" onClick={() => window.print()}>
          Print
        </button>
      </header>

      <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:items-end">
        <div>
          <p className="label">
            Highest remaining risk
            <Help term="remaining (residual) risk">
              How serious the worst problem still left after the retry is. It is set by the most serious safety rule an
              attack still breaks: confidential data is critical; personal data, instructions and refusals are high; a
              problem only hidden by the output filter is medium.
            </Help>
          </p>
          <p className={`mt-3 font-serif text-[88px] leading-[0.8] capitalize ${riskText(report.overall_risk)}`}>{report.overall_risk}</p>
        </div>
        <div className="max-w-xl space-y-3">
          <p className="text-[15.5px] leading-relaxed text-bone-200">
            Of {report.counts.cases} scripted attack{report.counts.cases === 1 ? "" : "s"}, {report.counts.baseline_failures} worked
            against the unprotected target. After the Blue Team added {report.defenses.length} protection
            {report.defenses.length === 1 ? "" : "s"} from a redacted summary, {report.counts.mitigated} passed the retry and{" "}
            {report.counts.residual_failures} still worked.
          </p>
          <p className="text-[14px] leading-relaxed text-bone-400">{RISK_PLAIN[report.overall_risk]}</p>
        </div>
      </div>

      <section className="mt-14">
        <h2 className="label">Remaining issues and what to do</h2>
        {issues.length === 0 ? (
          <p className="mt-4 text-[14px] text-moss-300">No attack still works, and none is only hidden.</p>
        ) : (
          <ol className="mt-4">
            {issues.map((c) => {
              const item = recorded.get(c.attack_id);
              return (
                <li key={c.attack_id} className="hairline grid gap-3 border-t py-5 sm:grid-cols-[150px_1fr] sm:gap-8">
                  <div>
                    <RiskTag risk={c.residual_risk} />
                    <p className="mt-2 font-mono text-[11.5px] text-bone-500">{c.attack_id}</p>
                    <p className="text-[13.5px] text-bone-50">{c.title}</p>
                  </div>
                  <div className="space-y-2 text-[14px] leading-relaxed">
                    {item && (
                      <p className="text-bone-200">
                        <OutcomeTag outcome={caseOutcome(item, ruleName)} /> · {caseOutcome(item, ruleName).sentence}
                      </p>
                    )}
                    <p className="text-bone-400">Why it matters: {RISK_PLAIN[c.residual_risk]}</p>
                    {c.recommendation && <p className="text-bone-200">Next action: {c.recommendation}</p>}
                    <p className="text-[12.5px] text-bone-500">
                      Evidence: {c.rationale}{" "}
                      <a href={href("runs", run.id)} className="no-print underline decoration-ink-500 underline-offset-4 hover:text-bone-200">
                        prompts and answers →
                      </a>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {lowRisk.length > 0 && (
          <p className="hairline border-t pt-4 text-[13.5px] leading-relaxed text-bone-400">
            Low risk: {lowRisk.map((c) => `${c.attack_id} ${c.title}`).join(", ")}. A protection stopped{" "}
            {lowRisk.length === 1 ? "it" : "them"} on the retry, so keep that protection in place. Details are in the table below.
          </p>
        )}
      </section>

      <section className="mt-14">
        <h2 className="label">Every attack in this run</h2>
        <div className="-mx-6 mt-4 overflow-x-auto px-6 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[640px] text-left">
            <caption className="sr-only">First attempt, retry and remaining risk for each attack</caption>
            <thead className="label">
              <tr className="hairline border-b">
                <th scope="col" className="w-48 py-2.5 pr-4 font-normal">Attack</th>
                <th scope="col" className="w-24 py-2.5 pr-4 font-normal">First try</th>
                <th scope="col" className="w-24 py-2.5 pr-4 font-normal">Retry</th>
                <th scope="col" className="w-28 py-2.5 pr-4 font-normal">Remaining risk</th>
                <th scope="col" className="py-2.5 font-normal">Recorded reason</th>
              </tr>
            </thead>
            <tbody>
              {report.cases.map((c) => (
                <tr key={c.attack_id} className="hairline border-b align-top">
                  <th scope="row" className="py-3.5 pr-4 font-normal">
                    <span className="block font-mono text-[11.5px] text-bone-500">{c.attack_id}</span>
                    <span className="text-[13.5px]">{c.title}</span>
                    {recorded.get(c.attack_id) && (
                      <span className="mt-1 block">
                        <OutcomeTag outcome={caseOutcome(recorded.get(c.attack_id)!, ruleName)} />
                      </span>
                    )}
                  </th>
                  <td className="py-3.5 pr-4"><VerdictTag verdict={c.baseline_verdict} /></td>
                  <td className="py-3.5 pr-4"><VerdictTag verdict={c.retest_verdict} /></td>
                  <td className="py-3.5 pr-4"><RiskTag risk={c.residual_risk} /></td>
                  <td className="py-3.5 text-[13px] leading-relaxed text-bone-400">{c.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="hairline mt-14 grid gap-10 border-t pt-10 md:grid-cols-3">
        <div>
          <h2 className="label">Protections added</h2>
          <ul className="mt-3 space-y-1.5 text-[13px] text-moss-300">
            {report.defenses.map((rule) => (
              <li key={rule}>{meta?.rules[rule]?.title ?? rule}</li>
            ))}
            {report.defenses.length === 0 && <li className="text-bone-500">None</li>}
          </ul>
        </div>
        <div>
          <h2 className="label">Isolation checks</h2>
          <ul className="mt-3 space-y-1.5 text-[13px] text-bone-400">
            <li>
              Application level: <span className="text-moss-300">{report.isolation.enforced_pass} passed</span>,{" "}
              <span className={report.isolation.enforced_fail ? "text-rust-300" : ""}>{report.isolation.enforced_fail} failed</span>
            </li>
            {(report.isolation.network_pass ?? 0) + (report.isolation.network_fail ?? 0) > 0 && (
              <li>
                Network, inside role containers: <span className="text-moss-300">{report.isolation.network_pass} passed</span>,{" "}
                <span className={report.isolation.network_fail ? "text-rust-300" : ""}>{report.isolation.network_fail} failed</span>
              </li>
            )}
            {(report.isolation.configured_pass ?? 0) + (report.isolation.configured_fail ?? 0) > 0 && (
              <li>
                Container controls: <span className="text-moss-300">{report.isolation.configured_pass} passed</span>,{" "}
                <span className={report.isolation.configured_fail ? "text-rust-300" : ""}>{report.isolation.configured_fail} failed</span>
              </li>
            )}
            {report.isolation.simulated > 0 && <li>{report.isolation.simulated} simulated: declared only, not tested</li>}
            {report.isolation.planned > 0 && <li>{report.isolation.planned} planned: not active in this deployment</li>}
          </ul>
        </div>
        <div>
          <h2 className="label">Evidence record</h2>
          <p className={`mt-3 text-[13px] ${report.audit.ok ? "text-moss-300" : "text-rust-300"}`}>
            {report.audit.ok ? "Intact" : "Broken"} when the report was made ({report.audit.checked} entries)
          </p>
          {report.audit.checkpoint && (
            <p className={`mt-1 text-[13px] ${WITNESS_TEXT[report.audit.checkpoint]}`}>
              {report.audit.checkpoint === "ok"
                ? `Matched the witness through #${report.audit.anchored_seq}`
                : report.audit.checkpoint === "not-configured"
                  ? "No witness in this deployment"
                  : `Witness: ${report.audit.checkpoint}`}
            </p>
          )}
          <p className="no-print mt-2 text-[12.5px]">
            <a href={href("audit")} className="text-bone-400 underline decoration-ink-500 underline-offset-4 hover:text-bone-200">
              Verify the record as it is now →
            </a>
          </p>
          <Technical summary="Head hash at report time">
            <span className="font-mono text-[10.5px] break-words">{groupHash(report.audit.head_hash)}</span>
          </Technical>
        </div>
      </section>

      <div className="mt-12">
        <Note tone="warn">{report.disclaimer}</Note>
      </div>
    </article>
  );
}

export function Reports({ id }: { id?: string }) {
  const { version } = useLab();
  const { data: runs, error: runsError } = useLoad(() => api.runs(), [version]);
  const completed = runs?.filter((r) => r.status === "completed") ?? [];
  const selectedId = id ?? completed[0]?.id;
  const { data: run, error, loading } = useLoad(
    () => (selectedId ? api.run(selectedId) : Promise.resolve(null)),
    [selectedId, version],
  );

  return (
    <div className="space-y-12">
      <div className="no-print">
        <PageHead eyebrow="Risk reports" title="What is still exposed.">
          Each finished run has a report: what still works after the protections, why it matters, and what to do next.
        </PageHead>
      </div>

      {runsError && <Note tone="error">Could not load the list of runs: {runsError}</Note>}
      {runs && completed.length === 0 && !id && <Empty>No completed runs yet. A report appears when a run finishes its last step.</Empty>}

      {(completed.length > 0 || id) && (
        <div className="grid gap-10 lg:grid-cols-12">
          <nav className="min-w-0 no-print lg:col-span-3" aria-label="Completed runs">
            <p className="label mb-3">Completed runs</p>
            <ul className="flex gap-2 overflow-x-auto lg:block">
              {completed.map((r) => (
                <li key={r.id} className="shrink-0">
                  <a
                    href={href("reports", r.id)}
                    aria-current={r.id === selectedId ? "page" : undefined}
                    className={`hairline flex items-center justify-between gap-4 border-l py-2.5 pr-2 pl-4 transition-colors ${
                      r.id === selectedId ? "border-bone-50 text-bone-50" : "text-bone-400 hover:text-bone-50"
                    }`}
                  >
                    <span>
                      <span className="block font-mono text-[12px]">{shortId(r.id)}</span>
                      <span className="block text-[11.5px] text-bone-500">{dateTime(r.created_at)}</span>
                    </span>
                    <RiskTag risk={r.overall_risk} />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0 lg:col-span-9">
            {error ? (
              <Note tone="error">Could not load this run's report: {error}</Note>
            ) : run?.id === selectedId && run?.report ? (
              <ReportDocument run={run} />
            ) : run?.id === selectedId ? (
              <Empty>
                Run {shortId(run.id)} has no report yet: it stopped before its last step.{" "}
                <a href={href("runs", run.id)} className="text-bone-50 underline underline-offset-4">
                  Open the run to resume it
                </a>
                .
              </Empty>
            ) : loading ? (
              <Empty>Loading the report…</Empty>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
