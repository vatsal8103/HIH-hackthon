import { useState } from "react";

import { api } from "../api";
import { Help, OutcomeTag, useRuleName } from "../components/Explain";
import { Note, PageHead, RiskTag, VerdictTag, stagger } from "../components/ui";
import { caseOutcome } from "../explain";
import { navigate, useLoad } from "../hooks";
import { useLab } from "../lab";

export function AttackLibrary() {
  const { meta, run, busy, start } = useLab();
  const { data: attacks, error } = useLoad(() => api.attacks(), []);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const ruleName = useRuleName();

  if (error) return <Note tone="error">Could not load the attack library: {error}</Note>;
  if (!attacks) return <p className="py-10 text-[14px] text-bone-500">Loading the attack library…</p>;
  if (attacks.length === 0) return <Note tone="warn">The API returned an empty attack library, so there is nothing to run.</Note>;

  const sources = Array.from(new Set(attacks.map((a) => a.source || "Bayora Core"))).sort();
  const categories = Array.from(new Set(attacks.map((a) => a.category || a.technique))).sort();

  const filteredAttacks = attacks.filter((a) => {
    const matchSource = sourceFilter === "all" || (a.source || "Bayora Core") === sourceFilter;
    const matchCat = categoryFilter === "all" || (a.category || a.technique) === categoryFilter;
    return matchSource && matchCat;
  });

  const chosen = selected ?? new Set(attacks.map((a) => a.id));
  const focus = attacks.find((a) => a.id === focusId) ?? filteredAttacks[0] ?? attacks[0];
  const lastById = new Map(run?.cases.map((c) => [c.attack.id, c]));
  const lastCase = lastById.get(focus.id);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectVisible = () => {
    const next = new Set(chosen);
    for (const a of filteredAttacks) next.add(a.id);
    setSelected(next);
  };

  const deselectVisible = () => {
    const next = new Set(chosen);
    for (const a of filteredAttacks) next.delete(a.id);
    setSelected(next);
  };

  const runSelected = () => {
    const ids = attacks.filter((a) => chosen.has(a.id)).map((a) => a.id);
    navigate();
    void start(ids);
  };

  return (
    <div className="space-y-12">
      <PageHead eyebrow="Attack library" title={<>The attacks Bayora tries.</>}>
        Each case is a scripted attack prompt aimed at a fictional clinic assistant, plus the written safety rules its
        answer is judged by. Includes synthetic clinic attacks and benchmark samples from Gandalf, JailbreakBench,
        AdvBench, and HarmBench. Nothing here targets a real system or produces harmful content.
        <Help term="an attack case">
          One attack case is one technique, for example overriding the AI's instructions or hiding a command in a document.
          The benign control (BN-00) is a normal request: it checks that protections do not block ordinary use.
        </Help>
      </PageHead>

      {/* Filter controls */}
      <div className="hairline flex flex-wrap items-center gap-4 border-y py-4 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] tracking-wider text-bone-500 uppercase">Dataset:</span>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded border border-ink-600 bg-ink-900 px-2.5 py-1 text-bone-200 outline-none focus:border-moss-400"
          >
            <option value="all">All datasets ({attacks.length})</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s} ({attacks.filter((a) => (a.source || "Bayora Core") === s).length})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] tracking-wider text-bone-500 uppercase">Category:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded border border-ink-600 bg-ink-900 px-2.5 py-1 text-bone-200 outline-none focus:border-moss-400"
          >
            <option value="all">All categories ({attacks.length})</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c} ({attacks.filter((a) => (a.category || a.technique) === c).length})
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <button type="button" className="label hover:text-bone-200" onClick={selectVisible}>
            Select visible
          </button>
          <span className="text-bone-600">·</span>
          <button type="button" className="label hover:text-bone-200" onClick={deselectVisible}>
            Deselect visible
          </button>
        </div>
      </div>

      <div className="grid gap-10 lg:grid-cols-12 lg:gap-14">
        <section className="min-w-0 lg:col-span-5">
          <div className="hairline flex items-center justify-between border-b pb-3">
            <span className="label">
              {chosen.size} of {attacks.length} selected ({filteredAttacks.length} shown)
            </span>
            <div className="flex gap-4">
              <button type="button" className="label hover:text-bone-200" onClick={() => setSelected(new Set(attacks.map((a) => a.id)))}>
                All
              </button>
              <button type="button" className="label hover:text-bone-200" onClick={() => setSelected(new Set())}>
                None
              </button>
            </div>
          </div>

          {filteredAttacks.length === 0 ? (
            <p className="py-8 text-[13px] text-bone-500">No attacks match the selected dataset and category filters.</p>
          ) : (
            <ul>
              {filteredAttacks.map((attack, i) => {
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
                        <span className="block truncate text-[12px] text-bone-500">
                          {attack.technique} · <span className="text-bone-400">{attack.source || "Bayora Core"}</span>
                        </span>
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
          )}

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
                <div className="flex flex-wrap items-center gap-2">
                  <p className="label">{focus.technique}</p>
                  {focus.source && (
                    <span className="rounded border border-ink-600 bg-ink-800/80 px-2 py-0.5 font-mono text-[10.5px] text-bone-300">
                      {focus.source}
                    </span>
                  )}
                  {focus.license && (
                    <span className="rounded border border-ink-700 bg-ink-900/60 px-2 py-0.5 font-mono text-[10px] text-bone-500">
                      {focus.license}
                    </span>
                  )}
                </div>
                <h2 className="mt-3 font-serif text-[40px] leading-none sm:text-[52px]">{focus.title}</h2>
                {focus.source_url && (
                  <a
                    href={focus.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block font-mono text-[11px] text-bone-500 underline decoration-ink-600 hover:text-bone-300"
                  >
                    Dataset reference ↗
                  </a>
                )}
              </div>
              <span className="font-mono text-[13px] text-bone-500">{focus.id}</span>
            </div>
            <p className="mt-6 max-w-xl text-[14.5px] leading-relaxed text-bone-400">{focus.objective}</p>

            <p className="label mt-9">Prompt</p>
            <pre className="mt-3 border-l border-rust-500/60 pl-4 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-bone-200">
              {focus.prompt}
            </pre>

            <p className="label mt-9">Judged by these rules</p>
            <ul className="mt-3">
              {focus.criteria.map((id) => {
                const criterion = meta?.criteria[id];
                return (
                  <li key={id} className="hairline grid gap-1 border-t py-3 sm:grid-cols-[200px_1fr_auto] sm:gap-5">
                    <span>
                      <span className="block text-[13px] text-bone-200">{criterion?.title ?? id}</span>
                      <span className="block font-mono text-[10.5px] text-bone-500">{id}</span>
                    </span>
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
                  <>
                    <p className="mt-2">
                      <OutcomeTag outcome={caseOutcome(lastCase, ruleName, run?.defenses.length)} />
                    </p>
                    <p className="mt-1 flex items-center gap-3 text-[13px] text-bone-400">
                      <VerdictTag verdict={lastCase.baseline?.verdict} /> <span aria-hidden>→</span>
                      <VerdictTag verdict={lastCase.retest?.verdict} />
                      {lastCase.residual && <RiskTag risk={lastCase.residual.residual_risk} />}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-[13px] text-bone-500">Not part of the latest run.</p>
                )}
              </div>
              <div>
                <p className="label">How to defend against it</p>
                <p className="mt-2 text-[13px] leading-relaxed text-bone-400">{focus.recommendation}</p>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
