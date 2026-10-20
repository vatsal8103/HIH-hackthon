import { api, type RunDetail } from "../api";
import { Empty, Note, PageHead, RiskTag, VerdictTag, dateTime, riskText, shortId } from "../components/ui";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";

function ReportDocument({ run }: { run: RunDetail }) {
  const report = run.report!;
  const recommendations = report.cases.filter((c) => c.recommendation);
  const stats: [string, number][] = [
    ["Cases", report.counts.cases],
    ["Failed at baseline", report.counts.baseline_failures],
    ["Mitigated", report.counts.mitigated],
    ["Still failing", report.counts.residual_failures],
  ];

  return (
    <article className="hairline fade-in border bg-ink-900 p-6 sm:p-10 lg:p-14 print:border-0 print:bg-white print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="label">Residual risk report · run {shortId(run.id)}</p>
          <p className="mt-1.5 font-mono text-[11px] text-bone-500">Generated {dateTime(report.generated_at)}</p>
        </div>
        <button type="button" className="btn no-print" onClick={() => window.print()}>
          Print
        </button>
      </header>

      <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:items-end">
        <div>
          <p className="label">Overall residual risk</p>
          <p className={`mt-3 font-serif text-[88px] leading-[0.8] capitalize ${riskText(report.overall_risk)}`}>
            {report.overall_risk}
          </p>
        </div>
        <p className="max-w-xl text-[15.5px] leading-relaxed text-bone-200">
          Of {report.counts.cases} controlled cases, {report.counts.baseline_failures} failed against the undefended
          target. After the Blue Team applied {report.defenses.length} rule{report.defenses.length === 1 ? "" : "s"} from
          redacted findings, {report.counts.mitigated} were mitigated and {report.counts.residual_failures} still fail.
        </p>
      </div>

      <dl className="hairline mt-12 grid grid-cols-2 border-y md:grid-cols-4">
        {stats.map(([label, value], i) => (
          <div
            key={label}
            className={`hairline py-5 ${i % 2 ? "border-l pl-5" : ""} ${i > 1 ? "border-t md:border-t-0" : ""} ${i ? "md:border-l md:pl-6" : ""}`}
          >
            <dt className="label">{label}</dt>
            <dd className="mt-2 font-serif text-[40px] leading-none">{value}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-14">
        <h2 className="label">Case outcomes</h2>
        <div className="-mx-6 mt-4 overflow-x-auto px-6 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[640px] text-left">
            <caption className="sr-only">Baseline, retest and residual risk for each case</caption>
            <thead className="label">
              <tr className="hairline border-b">
                <th scope="col" className="w-44 py-2.5 pr-4 font-normal">Case</th>
                <th scope="col" className="w-24 py-2.5 pr-4 font-normal">Baseline</th>
                <th scope="col" className="w-24 py-2.5 pr-4 font-normal">Retest</th>
                <th scope="col" className="w-24 py-2.5 pr-4 font-normal">Residual</th>
                <th scope="col" className="py-2.5 font-normal">Why</th>
              </tr>
            </thead>
            <tbody>
              {report.cases.map((c) => (
                <tr key={c.attack_id} className="hairline border-b align-top">
                  <th scope="row" className="py-3.5 pr-4 font-normal">
                    <span className="block font-mono text-[11.5px] text-bone-500">{c.attack_id}</span>
                    <span className="text-[13.5px]">{c.title}</span>
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

      {recommendations.length > 0 && (
        <section className="mt-14">
          <h2 className="label">Recommended next actions</h2>
          <ol className="mt-4 space-y-4">
            {recommendations.map((c, i) => (
              <li key={c.attack_id} className="grid grid-cols-[28px_1fr] gap-3">
                <span className="font-serif text-[22px] leading-none text-bone-500">{i + 1}</span>
                <p className="text-[14px] leading-relaxed text-bone-200">
                  <span className="font-mono text-[11.5px] text-bone-500">{c.attack_id} · </span>
                  {c.recommendation}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="hairline mt-14 grid gap-10 border-t pt-10 md:grid-cols-3">
        <div>
          <h2 className="label">Defenses applied</h2>
          <ul className="mt-3 space-y-1.5 font-mono text-[12px] text-moss-300">
            {report.defenses.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
            {report.defenses.length === 0 && <li className="text-bone-500">none</li>}
          </ul>
        </div>
        <div>
          <h2 className="label">Isolation checks</h2>
          <ul className="mt-3 space-y-1.5 text-[13px] text-bone-400">
            <li>
              <span className="text-moss-300">{report.isolation.enforced_pass}</span> application checks passed,{" "}
              <span className={report.isolation.enforced_fail ? "text-rust-300" : ""}>{report.isolation.enforced_fail}</span> failed
            </li>
            {(report.isolation.network_pass ?? 0) + (report.isolation.network_fail ?? 0) > 0 && (
              <li>
                <span className="text-moss-300">{report.isolation.network_pass}</span> network checks passed inside role
                containers, <span className={report.isolation.network_fail ? "text-rust-300" : ""}>{report.isolation.network_fail}</span> failed
              </li>
            )}
            {(report.isolation.configured_pass ?? 0) + (report.isolation.configured_fail ?? 0) > 0 && (
              <li>
                <span className="text-moss-300">{report.isolation.configured_pass}</span> container-control checks passed,{" "}
                <span className={report.isolation.configured_fail ? "text-rust-300" : ""}>{report.isolation.configured_fail}</span> failed
              </li>
            )}
            <li>{report.isolation.simulated} simulated (model only)</li>
            <li>{report.isolation.planned} planned, not implemented</li>
          </ul>
        </div>
        <div>
          <h2 className="label">Audit attestation</h2>
          <p className={`mt-3 text-[13px] ${report.audit.ok ? "text-moss-300" : "text-rust-300"}`}>
            {report.audit.ok ? "Chain intact" : "Chain broken"} · {report.audit.checked} events at report time
          </p>
          {report.audit.checkpoint && (
            <p className={`mt-1 text-[13px] ${report.audit.checkpoint === "ok" ? "text-moss-300" : "text-amber-300"}`}>
              {report.audit.checkpoint === "ok"
                ? `Matches the external witness through #${report.audit.anchored_seq}`
                : report.audit.checkpoint === "not-configured"
                  ? "No external witness in this deployment"
                  : `External witness: ${report.audit.checkpoint}`}
            </p>
          )}
          <p className="mt-2 font-mono text-[10.5px] break-all text-bone-400">{report.audit.head_hash}</p>
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
  const { data: runs } = useLoad(() => api.runs(), [version]);
  const completed = runs?.filter((r) => r.status === "completed") ?? [];
  const selectedId = id ?? completed[0]?.id;
  const { data: run, error } = useLoad(
    () => (selectedId ? api.run(selectedId) : Promise.resolve(null)),
    [selectedId, version],
  );

  return (
    <div className="space-y-12">
      <div className="no-print">
        <PageHead eyebrow="Risk reports" title="What is still exposed.">
          Each completed run produces a residual risk report from its recorded outcomes, with the audit head hash at
          the moment it was generated.
        </PageHead>
      </div>

      {runs && completed.length === 0 && <Empty>No completed runs yet.</Empty>}

      {completed.length > 0 && (
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
            {error && <Note tone="error">{error}</Note>}
            {run?.report ? <ReportDocument run={run} /> : run && <Empty>This run has not produced a report yet.</Empty>}
          </div>
        </div>
      )}
    </div>
  );
}
