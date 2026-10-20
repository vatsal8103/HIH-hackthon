import { useState } from "react";

import { api } from "../api";
import { Note, PageHead, RiskTag, VerdictTag, stagger } from "../components/ui";
import { navigate, useLoad } from "../hooks";
import { useLab } from "../lab";

export function AttackLibrary() {
  const { meta, run, busy, start } = useLab();
  const { data: attacks, error } = useLoad(() => api.attacks(), []);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  if (error) return <Note tone="error">{error}</Note>;
  if (!attacks) return null;

  const chosen = selected ?? new Set(attacks.map((a) => a.id));
  const focus = attacks.find((a) => a.id === focusId) ?? attacks[0];
  const lastById = new Map(run?.cases.map((c) => [c.attack.id, c]));
  const lastCase = lastById.get(focus.id);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const runSelected = () => {
    const ids = attacks.filter((a) => chosen.has(a.id)).map((a) => a.id);
    navigate();
    void start(ids);
  };

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Attack library" title={<>Seven controlled cases.</>}>
        Synthetic prompts against a fictional clinic assistant. Each case declares the safety criteria it is judged by.
        Nothing here targets a real system or produces harmful content.
      </PageHead>

      <div className="grid gap-10 lg:grid-cols-12 lg:gap-14">
        <section className="min-w-0 lg:col-span-5">
          <div className="hairline flex items-center justify-between border-b pb-3">
            <span className="label">{chosen.size} of {attacks.length} selected</span>
            <div className="flex gap-4">
              <button type="button" className="label hover:text-bone-200" onClick={() => setSelected(new Set(attacks.map((a) => a.id)))}>All</button>
              <button type="button" className="label hover:text-bone-200" onClick={() => setSelected(new Set())}>None</button>
            </div>
          </div>
          <ul>
            {attacks.map((attack, i) => {
              const active = attack.id === focus.id;
              const last = lastById.get(attack.id);
              return (
                <li key={attack.id} className="hairline reveal flex border-b" style={stagger(i)}>
                  <label className="relative flex cursor-pointer items-center px-1 py-4 pr-4">
                    <input
                      type="checkbox"
                      checked={chosen.has(attack.id)}
                      onChange={() => toggle(attack.id)}
                      className="peer absolute size-4 cursor-pointer opacity-0"
                      aria-label={`Include ${attack.id} ${attack.title}`}
                    />
                    <span
                      aria-hidden
                      className="grid size-4 place-items-center border border-ink-500 text-ink-950 transition-colors peer-checked:border-bone-50 peer-checked:bg-bone-50 peer-focus-visible:outline peer-focus-visible:outline-offset-2 peer-focus-visible:outline-moss-400"
                    >
                      <svg viewBox="0 0 12 12" className="size-2.5">
                        <path d="M2.4 6.3 5 8.6l4.6-5.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
                      </svg>
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setFocusId(attack.id)}
                    aria-pressed={active}
                    className={`flex min-w-0 flex-1 items-baseline gap-4 py-4 text-left transition-colors ${active ? "text-bone-50" : "text-bone-400 hover:text-bone-50"}`}
                  >
                    <span className={`w-14 shrink-0 font-mono text-[12px] ${active ? "text-bone-50" : "text-bone-500"}`}>{attack.id}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium tracking-tight">{attack.title}</span>
                      <span className="block truncate text-[12px] text-bone-500">{attack.technique}</span>
                    </span>
                    <span className="ml-auto flex items-center gap-3 self-center">
                      {last && (
                        <span className="flex gap-px" title="Latest run: baseline, retest">
                          {[last.baseline?.verdict, last.retest?.verdict].map((verdict, k) => (
                            <span
                              key={k}
                              className={`block h-3 w-1.5 ${verdict === "fail" ? "bg-rust-500" : verdict === "pass" ? "bg-moss-800" : "hatch"}`}
                            />
                          ))}
                          <span className="sr-only">
                            Latest run: baseline {last.baseline?.verdict ?? "pending"}, retest {last.retest?.verdict ?? "pending"}
                          </span>
                        </span>
                      )}
                      <span className={`transition-opacity ${active ? "opacity-100" : "opacity-0"}`} aria-hidden>→</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button type="button" className="btn btn-primary" disabled={busy || chosen.size === 0} onClick={runSelected}>
              Run {chosen.size === attacks.length ? "full suite" : `${chosen.size} selected`}
              <span aria-hidden>→</span>
            </button>
            {busy && <span className="label text-moss-300">A run is in progress</span>}
          </div>
        </section>

        <article key={focus.id} className="min-w-0 fade-in lg:sticky lg:top-10 lg:col-span-7 lg:self-start">
          <div className="ticks hairline border p-6 sm:p-9">
            <div className="flex items-start justify-between gap-6">
              <div>
                <p className="label">{focus.technique}</p>
                <h2 className="mt-3 font-serif text-[40px] leading-none sm:text-[52px]">{focus.title}</h2>
              </div>
              <span className="font-mono text-[13px] text-bone-500">{focus.id}</span>
            </div>
            <p className="mt-6 max-w-xl text-[14.5px] leading-relaxed text-bone-400">{focus.objective}</p>

            <p className="label mt-9">Prompt</p>
            <pre className="mt-3 border-l border-rust-500/60 pl-4 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-bone-200">
              {focus.prompt}
            </pre>

            <p className="label mt-9">Judged by</p>
            <ul className="mt-3">
              {focus.criteria.map((id) => {
                const criterion = meta?.criteria[id];
                return (
                  <li key={id} className="hairline grid gap-1 border-t py-3 sm:grid-cols-[200px_1fr_auto] sm:gap-5">
                    <span className="font-mono text-[11.5px] text-bone-200">{id}</span>
                    <span className="text-[13px] text-bone-400">{criterion?.description}</span>
                    {criterion && <RiskTag risk={criterion.severity} />}
                  </li>
                );
              })}
            </ul>

            <div className="hairline mt-9 grid gap-6 border-t pt-6 sm:grid-cols-2">
              <div>
                <p className="label">Latest run</p>
                {lastCase ? (
                  <p className="mt-2 flex items-center gap-3 text-[13px] text-bone-400">
                    <VerdictTag verdict={lastCase.baseline?.verdict} /> <span aria-hidden>→</span>
                    <VerdictTag verdict={lastCase.retest?.verdict} />
                    {lastCase.residual && <RiskTag risk={lastCase.residual.residual_risk} />}
                  </p>
                ) : (
                  <p className="mt-2 text-[13px] text-bone-500">Not part of the latest run.</p>
                )}
              </div>
              <div>
                <p className="label">Guidance</p>
                <p className="mt-2 text-[13px] leading-relaxed text-bone-400">{focus.recommendation}</p>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
