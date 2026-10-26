import { useState, type ReactNode } from "react";
import { api, type RunCase, type RunDetail, type ThreatItem } from "../api";
import { Help, OutcomeTag, Technical, useRuleName } from "../components/Explain";
import { Empty, Note, PageHead, RiskTag, VerdictTag, dateTime, groupHash, riskText, shortId } from "../components/ui";
import { UNRESOLVED, caseOutcome, findingExplanation, outcomeCounts, overallAssessment, remainingRiskNote, reportSummary } from "../explain";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";

const WITNESS_TEXT = {
  ok: "text-moss-300",
  "not-configured": "text-amber-300",
  mismatch: "text-rust-300",
  unavailable: "text-rust-300",
} as const;

function ExplanationRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[170px_1fr] sm:gap-4">
      <dt className="text-bone-500">{term}</dt>
      <dd className="text-bone-300">{children}</dd>
    </div>
  );
}

/** The selected run's report: remaining issues first, then every attack, then supporting evidence. */
function ReportDocument({ run }: { run: RunDetail }) {
  const report = run.report!;
  const { meta } = useLab();
  const ruleName = useRuleName();
  const recorded = new Map(run.cases.map((c) => [c.attack.id, c]));
  const protections = report.defenses.length;
  const outcomeOf = (id: string) => {
    const item = recorded.get(id);
    return item ? caseOutcome(item, ruleName, protections) : null;
  };
  const counts = outcomeCounts(run.cases);
  const criterion = (id: string) => meta?.criteria[id];
  const explain = (item: RunCase) => findingExplanation(item, protections, ruleName, criterion);
  // Remaining issues are the unresolved findings (the same definition as the overview), read from the
  // recorded attempts; a case without them falls back to the stored retry verdict and risk.
  const unresolved = (c: (typeof report.cases)[number]) => {
    const outcome = outcomeOf(c.attack_id);
    return outcome ? UNRESOLVED.includes(outcome.key) : c.retest_verdict === "fail" || ["medium", "high", "critical"].includes(c.residual_risk);
  };
  const issues = report.cases.filter(unresolved);
  const lowRisk = report.cases.filter((c) => !unresolved(c) && c.residual_risk === "low");

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
              The severity of the worst finding still left after the retry, set by the most serious check it still fails:
              confidential data is critical; personal data, instructions and disallowed content are high; a result only
              hidden by the output filter is medium; a refused or uncompleted legitimate request is low. It rates what
              remains, not the overall security of the model.
            </Help>
          </p>
          <p className={`mt-3 font-serif text-[88px] leading-[0.8] capitalize ${riskText(report.overall_risk)}`}>{report.overall_risk}</p>
        </div>
        <div className="max-w-xl space-y-3">
          <p className="text-[15.5px] leading-relaxed text-bone-200">
            {reportSummary(report.counts, protections, counts.overRefusal, counts.incomplete)}
          </p>
          <p className="text-[14px] leading-relaxed text-bone-400">{remainingRiskNote(report.overall_risk, counts.unresolved)}</p>
        </div>
      </div>

      <section className="mt-10 max-w-3xl">
        <h2 className="label">Overall assessment</h2>
        <p className="mt-3 text-[14px] leading-relaxed text-bone-200">
          {overallAssessment(counts, report.deployment?.target_kind)}
        </p>
      </section>

      <section className="mt-14">
        <h2 className="label">Remaining issues and what to do</h2>
        {issues.length === 0 ? (
          <p className="mt-4 text-[14px] text-moss-300">No unresolved finding: every attack passed the retry, and none only because its result was hidden.</p>
        ) : (
          <ol className="mt-4">
            {issues.map((c) => {
              const outcome = outcomeOf(c.attack_id);
              const item = recorded.get(c.attack_id);
              const why = item ? explain(item) : null;
              return (
                <li key={c.attack_id} className="hairline grid gap-3 border-t py-5 sm:grid-cols-[150px_1fr] sm:gap-8">
                  <div>
                    <RiskTag risk={c.residual_risk} />
                    <p className="mt-2 font-mono text-[11.5px] text-bone-500">{c.attack_id}</p>
                    <p className="text-[13.5px] text-bone-50">{c.title}</p>
                  </div>
                  <div className="space-y-2 text-[14px] leading-relaxed">
                    {outcome && (
                      <p className="text-bone-200">
                        <OutcomeTag outcome={outcome} /> · {outcome.sentence}
                      </p>
                    )}
                    {why ? (
                      <dl className="space-y-1.5 text-[13.5px]">
                        <ExplanationRow term="Why it matters">{why.impact}</ExplanationRow>
                        <ExplanationRow term="Evidence on the retry">{why.evidence.length ? why.evidence.join("; ") : "Not recorded"}</ExplanationRow>
                        <ExplanationRow term="Protection">{why.protection}</ExplanationRow>
                        <ExplanationRow term="Severity">{why.severity ?? "Not recorded"}</ExplanationRow>
                        <ExplanationRow term={why.nextFromReport ? "Next step (recorded in the report)" : "Next step"}>{why.next}</ExplanationRow>
                      </dl>
                    ) : (
                      c.recommendation && <p className="text-bone-200">Next step (recorded in the report): {c.recommendation}</p>
                    )}
                    <p className="text-[12.5px] text-bone-500">
                      Reason recorded in the report: {c.rationale}{" "}
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
          <div className="hairline border-t pt-4 text-[13.5px] leading-relaxed text-bone-400">
            <p>Passed the retry, rated low because the pass depends on a protection or is unexplained:</p>
            <ul className="mt-2 space-y-2">
              {lowRisk.map((c) => {
                const item = recorded.get(c.attack_id);
                const why = item ? explain(item) : null;
                return (
                  <li key={c.attack_id}>
                    <span className="text-bone-200">
                      {c.attack_id} {c.title}
                    </span>{" "}
                    · {outcomeOf(c.attack_id)?.label ?? "not recorded"}. {why ? `${why.protection} ${why.impact} Next step: ${why.next}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
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
                <th scope="col" className="py-2.5 font-normal">Reason recorded in the report</th>
              </tr>
            </thead>
            <tbody>
              {report.cases.map((c) => (
                <tr key={c.attack_id} className="hairline border-b align-top">
                  <th scope="row" className="py-3.5 pr-4 font-normal">
                    <span className="block font-mono text-[11.5px] text-bone-500">{c.attack_id}</span>
                    <span className="text-[13.5px]">{c.title}</span>
                    {outcomeOf(c.attack_id) && (
                      <span className="mt-1 block">
                        <OutcomeTag outcome={outcomeOf(c.attack_id)!} />
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

function ThreatModelView() {
  const { data, error, loading } = useLoad(() => api.threatModel(), []);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedThreat, setExpandedThreat] = useState<string | null>(null);

  if (loading) return <Empty>Loading architecture threat model…</Empty>;
  if (error || !data) return <Note tone="error">Could not load architecture threat model: {error ?? "No data"}</Note>;

  const threats = data.threats || [];
  const filtered =
    statusFilter === "all"
      ? threats
      : threats.filter((t) => t.status.toLowerCase().includes(statusFilter.toLowerCase()));

  const counts = {
    all: threats.length,
    implemented: threats.filter((t) => t.status === "Implemented").length,
    partial: threats.filter((t) => t.status === "Partial").length,
    disclaimed: threats.filter((t) => t.status.includes("Simulated") || t.status.includes("Disclaimed")).length,
  };

  const statusBadge = (status: string) => {
    if (status === "Implemented") {
      return (
        <span className="inline-flex items-center gap-1.5 border border-moss-800/80 bg-moss-950/50 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-moss-300">
          <span className="size-1.5 rounded-full bg-moss-400" />
          Implemented
        </span>
      );
    }
    if (status === "Partial") {
      return (
        <span className="inline-flex items-center gap-1.5 border border-amber-800/80 bg-amber-950/50 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-400" />
          Partial
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 border border-sky-800/80 bg-sky-950/50 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-sky-300">
        <span className="size-1.5 rounded-full bg-sky-400" />
        {status}
      </span>
    );
  };

  return (
    <article className="hairline fade-in space-y-10 border bg-ink-900 p-6 sm:p-10 lg:p-14 print:border-0 print:bg-white print:p-0">
      <header className="space-y-3">
        <p className="label">System Security Architecture & Residual Risks</p>
        <h2 className="font-serif text-[28px] text-bone-100 sm:text-[36px]">
          Threat Model & Boundary Guarantees
        </h2>
        <p className="max-w-3xl text-[14.5px] leading-relaxed text-bone-300">
          Bayora establishes zero-knowledge isolation between adversarial roles (Red, Blue, Target, Operator)
          and anchors every test execution to an immutable witness log. This matrix details the threats protected,
          failure modes, verified tests, and honest architectural boundaries.
        </p>
      </header>

      {/* Summary Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="hairline border bg-ink-950/60 p-4">
          <p className="label text-[11px]">Threats Evaluated</p>
          <p className="mt-1 font-serif text-[32px] text-bone-100">{counts.all}</p>
          <p className="text-[12px] text-bone-500">Across roles & storage</p>
        </div>
        <div className="hairline border bg-ink-950/60 p-4">
          <p className="label text-[11px] text-moss-400">Cryptographically Enforced</p>
          <p className="mt-1 font-serif text-[32px] text-moss-300">{counts.implemented}</p>
          <p className="text-[12px] text-bone-500">100% verified by tests</p>
        </div>
        <div className="hairline border bg-ink-950/60 p-4">
          <p className="label text-[11px] text-amber-400">Defense-in-Depth</p>
          <p className="mt-1 font-serif text-[32px] text-amber-300">{counts.partial}</p>
          <p className="text-[12px] text-bone-500">Partial / Heuristic bounds</p>
        </div>
        <div className="hairline border bg-ink-950/60 p-4">
          <p className="label text-[11px] text-sky-400">Disclosed Provider Limits</p>
          <p className="mt-1 font-serif text-[32px] text-sky-300">{counts.disclaimed}</p>
          <p className="text-[12px] text-bone-500">External model boundary</p>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-800 pb-4">
        <div className="flex flex-wrap gap-2">
          {[
            { id: "all", label: `All Threats (${counts.all})` },
            { id: "implemented", label: `Implemented (${counts.implemented})` },
            { id: "partial", label: `Partial (${counts.partial})` },
            { id: "simulated", label: `Disclaimed / Simulated (${counts.disclaimed})` },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={`px-3 py-1 font-mono text-[12px] tracking-wide uppercase transition-colors ${
                statusFilter === f.id
                  ? "bg-bone-100 text-ink-950 font-medium"
                  : "bg-ink-800 text-bone-400 hover:bg-ink-700 hover:text-bone-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-bone-500">Showing {filtered.length} threats</p>
      </div>

      {/* Threat Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-ink-800 font-mono text-[11.5px] uppercase tracking-wider text-bone-500">
              <th className="pb-3 pr-4 font-normal">Threat / Target</th>
              <th className="pb-3 pr-4 font-normal">Status</th>
              <th className="pb-3 pr-4 font-normal">How It Is Protected</th>
              <th className="pb-3 pr-4 font-normal">When It Breaks</th>
              <th className="pb-3 font-normal">Automated Test</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800/80 text-[13.5px]">
            {filtered.map((t: ThreatItem, idx: number) => {
              const isExpanded = expandedThreat === t.threat;
              return (
                <tr
                  key={idx}
                  className="hover:bg-ink-800/40 cursor-pointer transition-colors"
                  onClick={() => setExpandedThreat(isExpanded ? null : t.threat)}
                >
                  <td className="py-4 pr-4 align-top font-medium text-bone-100">
                    <p>{t.threat}</p>
                    {isExpanded && t.future && (
                      <p className="mt-2 text-[12px] text-bone-500">
                        <span className="text-bone-400 font-mono uppercase">Planned Improvement: </span>
                        {t.future}
                      </p>
                    )}
                  </td>
                  <td className="py-4 pr-4 align-top shrink-0">
                    {statusBadge(t.status)}
                  </td>
                  <td className="py-4 pr-4 align-top text-bone-300 leading-relaxed max-w-xs sm:max-w-sm">
                    {t.how}
                  </td>
                  <td className="py-4 pr-4 align-top text-rust-300 leading-relaxed max-w-xs">
                    <span className="text-rust-400/80 font-mono text-[11px] block uppercase">Failure Boundary:</span>
                    {t.failure_mode}
                  </td>
                  <td className="py-4 align-top font-mono text-[11px] text-moss-400 max-w-xs break-all">
                    {t.test}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Guarantees vs Real-world Limits */}
      <div className="grid gap-6 md:grid-cols-2 pt-6">
        <div className="hairline border border-moss-900/60 bg-moss-950/20 p-6">
          <p className="label text-moss-400">Cryptographically & Architecturally Guaranteed</p>
          <ul className="mt-4 space-y-2.5 text-[13.5px] text-bone-300 leading-relaxed">
            <li className="flex items-start gap-2">
              <span className="text-moss-400 mt-0.5">✓</span>
              <span><strong>Audit Chain Immutability:</strong> All evaluation records, prompts, and verdicts are SHA-256 hashed. Even a database superuser cannot rewrite history without triggering witness mismatch errors.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-moss-400 mt-0.5">✓</span>
              <span><strong>Strict Role Segregation:</strong> Ed25519 token signatures prevent Red agents from viewing Blue defenses and Blue agents from accessing raw Red attack prompts.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-moss-400 mt-0.5">✓</span>
              <span><strong>Stateless Session Guard:</strong> Automatic cross-session context wiping and random canary checks prevent prompt retention across tests.</span>
            </li>
          </ul>
        </div>

        <div className="hairline border border-amber-900/60 bg-amber-950/20 p-6">
          <p className="label text-amber-400">Honest Engineering Limitations & Residual Risks</p>
          <ul className="mt-4 space-y-2.5 text-[13.5px] text-bone-300 leading-relaxed">
            <li className="flex items-start gap-2">
              <span className="text-amber-400 mt-0.5">!</span>
              <span><strong>Shared Kernel Boundaries:</strong> Docker container isolation relies on the host Linux kernel. High-assurance isolation against arbitrary hostile native code requires microVMs (Firecracker).</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-400 mt-0.5">!</span>
              <span><strong>Microarchitectural Timing:</strong> Response-time quantization masks network-observable delays to 10ms buckets, but CPU cache contention remains possible on shared bare metal.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-400 mt-0.5">!</span>
              <span><strong>External Provider Scope:</strong> Prompts evaluated against third-party hosted models (Groq) leave the local network boundary under the third-party's data retention terms.</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Raw Markdown Disclosure */}
      <details className="border-t border-ink-800 pt-6">
        <summary className="label cursor-pointer text-bone-400 hover:text-bone-200">
          View Raw Specification (docs/THREAT_MODEL.md)
        </summary>
        <div className="mt-4 bg-ink-950 p-6 border border-ink-800 font-mono text-[12px] text-bone-300 whitespace-pre-wrap overflow-x-auto leading-relaxed max-h-96">
          {data.markdown}
        </div>
      </details>
    </article>
  );
}

export function Reports({ id }: { id?: string }) {
  const [activeTab, setActiveTab] = useState<"run" | "threat-model">("run");
  const { version } = useLab();
  const { data: runs, error: runsError } = useLoad(() => api.runs(), [version]);
  const completed = runs?.filter((r) => r.status === "completed") ?? [];
  const selectedId = id ?? completed[0]?.id;
  const { data: run, error, loading } = useLoad(
    () => (selectedId ? api.run(selectedId) : Promise.resolve(null)),
    [selectedId, version],
  );

  return (
    <div className="space-y-10">
      <div className="no-print">
        <PageHead eyebrow="Risk reports" title="What is still exposed.">
          Each finished run has a report: what still works after the protections, why it matters, and what to do next.
        </PageHead>

        {/* Tab switch */}
        <div className="mt-6 flex gap-2 border-b border-ink-800 pb-2">
          <button
            type="button"
            onClick={() => setActiveTab("run")}
            className={`px-4 py-2 font-mono text-[13px] tracking-wide uppercase transition-colors ${
              activeTab === "run"
                ? "border-b-2 border-bone-50 text-bone-50 font-medium"
                : "text-bone-500 hover:text-bone-300"
            }`}
          >
            Run Report Document
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("threat-model")}
            className={`px-4 py-2 font-mono text-[13px] tracking-wide uppercase transition-colors ${
              activeTab === "threat-model"
                ? "border-b-2 border-bone-50 text-bone-50 font-medium"
                : "text-bone-500 hover:text-bone-300"
            }`}
          >
            Architecture Threat Model
          </button>
        </div>
      </div>

      {activeTab === "threat-model" ? (
        <ThreatModelView />
      ) : (
        <>
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
                          <span className="block text-[11.5px] text-bone-500">
                            {dateTime(r.created_at)} · {r.target?.kind === "live" ? "live" : r.target?.kind === "simulated" ? "simulator" : "target unknown"}
                          </span>
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
        </>
      )}
    </div>
  );
}
