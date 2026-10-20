import type { Risk, RunCase, RunDetail, RunSummary, Verdict } from "../api";

const VERDICT_CELL: Record<Verdict, string> = { fail: "bg-rust-500", pass: "bg-moss-800" };
const RESIDUAL_LINE: Record<Risk, string> = {
  none: "bg-moss-500",
  low: "bg-moss-500",
  medium: "bg-amber-400",
  high: "bg-rust-400",
  critical: "bg-rust-400",
};

function Cell({ verdict }: { verdict: Verdict | null | undefined }) {
  return <span className={`block h-6 transition-colors duration-700 ${verdict ? VERDICT_CELL[verdict] : "hatch"}`} />;
}

const describe = (c: RunCase) =>
  `${c.attack.id} ${c.attack.title}: first try ${c.baseline?.verdict ?? "pending"}, retry ${c.retest?.verdict ?? "pending"}` +
  (c.residual ? `, remaining risk ${c.residual.residual_risk}` : "");

/** One column per case: baseline verdict over retest verdict, underlined by residual risk. */
export function OutcomeStrip({ run }: { run: RunDetail }) {
  return (
    <figure>
      <div className="flex items-baseline justify-between gap-4">
        <figcaption className="label">Each attack</figcaption>
        <span className="font-mono text-[10px] tracking-[0.1em] text-bone-500 uppercase">first try / retry</span>
      </div>
      {/* One labelled image rather than a list: its cells carry no visible text, so as a list it read as seven
          empty items in text extraction. The label carries every attack's verdicts for assistive technology. */}
      <div
        role="img"
        aria-label={run.cases.map(describe).join("; ")}
        className="mt-3 grid gap-x-1"
        style={{ gridTemplateColumns: `repeat(${run.cases.length}, minmax(0, 1fr))` }}
      >
        {run.cases.map((c) => (
          <div key={c.attack.id} title={describe(c)}>
            <span className="block space-y-px">
              <Cell verdict={c.baseline?.verdict} />
              <Cell verdict={c.retest?.verdict} />
            </span>
            <span
              className={`mt-1 block h-0.5 transition-colors duration-700 ${c.residual ? RESIDUAL_LINE[c.residual.residual_risk] : "bg-ink-700"}`}
            />
            <span className="mt-1.5 block truncate text-center font-mono text-[9.5px] text-bone-400">{c.attack.id}</span>
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9.5px] tracking-[0.1em] text-bone-500 uppercase">
        <span className="flex items-center gap-1.5"><span className="size-2 bg-rust-500" />fail</span>
        <span className="flex items-center gap-1.5"><span className="size-2 bg-moss-800" />pass</span>
        <span className="flex items-center gap-1.5"><span className="hatch size-2" />pending</span>
      </div>
    </figure>
  );
}

/** Proportional bar from run counts: passed at baseline, mitigated, still failing. */
export function OutcomeBar({ counts }: { counts: RunSummary["counts"] }) {
  if (!counts) return <span className="hatch block h-1.5 w-full max-w-40" aria-label="No report yet" />;
  const clean = counts.cases - counts.baseline_failures;
  const segments = [
    [clean, "bg-ink-500"],
    [counts.mitigated, "bg-moss-500"],
    [counts.residual_failures, "bg-rust-400"],
  ] as const;
  return (
    <span
      className="flex h-1.5 w-full max-w-40 gap-px"
      role="img"
      aria-label={`${clean} passed at first, ${counts.mitigated} passed after a protection, ${counts.residual_failures} still failing`}
    >
      {segments.map(([value, color], i) => (value ? <span key={i} className={color} style={{ flexGrow: value }} /> : null))}
    </span>
  );
}
