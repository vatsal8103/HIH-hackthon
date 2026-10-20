import type { ReactNode } from "react";

import { STAGES, api } from "../api";
import { OutcomeStrip } from "../components/Outcomes";
import { Pipeline } from "../components/Pipeline";
import { Hash, RiskTag, SectionHead, STAGE_INFO, dateTime, groupHash, riskText, shortId, stagger } from "../components/ui";
import { href, useLoad } from "../hooks";
import { useLab } from "../lab";
import { SecurityCore } from "../scene/SecurityCore";
import type { SceneStage } from "../scene/model";

const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);

function Headline() {
  const { run, playing, busy, start, resume, skip } = useLab();
  const report = run?.report;

  let eyebrow = "No runs yet";
  let word = "Ready";
  let wordClass = "text-bone-50";
  let sentence: ReactNode = "Run the suite to attack the simulated target, defend it through the Blue Team interface and retest.";
  if (busy && playing) {
    eyebrow = `Run in progress · stage 0${STAGES.indexOf(playing) + 1} of 07`;
    word = STAGE_INFO[playing].title;
    sentence = STAGE_INFO[playing].description;
  } else if (busy) {
    eyebrow = "Run in progress";
    word = "Starting";
    sentence = "Creating a session and recording it in the audit chain.";
  } else if (report) {
    eyebrow = "Residual risk · latest run";
    word = capitalize(report.overall_risk);
    wordClass = riskText(report.overall_risk);
    sentence = (
      <>
        <span className="text-bone-50">
          {report.counts.residual_failures} of {report.counts.cases} cases still fail
        </span>{" "}
        after Blue Team defenses. {report.counts.mitigated} of {report.counts.baseline_failures} baseline failures were
        mitigated.
      </>
    );
  } else if (run) {
    eyebrow = "Interrupted run";
    word = "Paused";
    sentence = `This run stopped after the ${run.stage} stage. Resume to execute the remaining stages.`;
  }

  return (
    <div className="flex flex-col">
      <p className="label reveal">{eyebrow}</p>
      <p
        key={word}
        className={`reveal mt-4 font-serif text-[80px] leading-[0.84] tracking-[-0.02em] sm:text-[104px] ${wordClass}`}
      >
        {word}
      </p>
      <p className="reveal mt-5 max-w-[22rem] text-[15px] leading-relaxed text-bone-400" style={stagger(2)}>
        {sentence}
      </p>
      <div className="reveal mt-7 flex flex-wrap items-center gap-3" style={stagger(3)}>
        {busy ? (
          <button type="button" className="btn" onClick={skip}>
            Skip animation
          </button>
        ) : run && !report ? (
          <button type="button" className="btn btn-primary" onClick={() => resume(run.id)}>
            Resume run
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => start()}>
            Run test suite
            <span aria-hidden>→</span>
          </button>
        )}
        <a href={href("attacks")} className="btn">
          Choose cases
        </a>
      </div>
    </div>
  );
}

/** Run metadata in full: nothing truncated, the audit head wraps in groups of eight. */
function RunFacts() {
  const { run, meta } = useLab();
  if (!run) return null;
  const facts: [string, ReactNode][] = [
    [
      "Run",
      <a href={href("runs", run.id)} className="text-bone-50 underline decoration-ink-500 underline-offset-4 hover:decoration-bone-400">
        {shortId(run.id)}
      </a>,
    ],
    ["Started", dateTime(run.created_at)],
    ["Storage", meta?.storage ?? "…"],
    [
      "Audit head",
      run.report ? (
        <span className="break-words text-bone-400" title={run.report.audit.head_hash}>
          {groupHash(run.report.audit.head_hash)}
        </span>
      ) : (
        "pending"
      ),
    ],
  ];
  return (
    <dl className="grid grid-cols-[84px_1fr] gap-x-4 gap-y-2 font-mono text-[11px] leading-relaxed">
      {facts.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="tracking-[0.12em] text-bone-500 uppercase">{term}</dt>
          <dd className="min-w-0 text-bone-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Findings() {
  const { run } = useLab();
  const remaining = run?.report?.cases.filter((c) => c.residual_risk !== "none" && c.residual_risk !== "low") ?? [];
  return (
    <section className="min-w-0 lg:col-span-7">
      <SectionHead
        index="02"
        title="Findings that remain"
        aside={run?.report && <a href={href("reports", run.id)} className="label hover:text-bone-200">Full report →</a>}
      />
      {!run?.report ? (
        <p className="py-8 text-[14px] text-bone-500">Findings appear once a run reaches its report stage.</p>
      ) : remaining.length === 0 ? (
        <p className="py-8 text-[14px] text-moss-300">No medium or higher residual risk in the latest run.</p>
      ) : (
        <ul>
          {remaining.map((c, i) => (
            <li key={c.attack_id} className="hairline reveal grid grid-cols-[64px_1fr] gap-x-4 border-b py-5 sm:grid-cols-[72px_1fr_auto]" style={stagger(i)}>
              <span className="font-mono text-[12px] text-bone-200">{c.attack_id}</span>
              <div className="min-w-0">
                <p className="text-[15px] font-medium tracking-tight">{c.title}</p>
                <p className="text-[12.5px] text-bone-500">{c.technique}</p>
                <p className="mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-bone-400">{c.rationale}</p>
                {c.recommendation && (
                  <p className="mt-2 grid max-w-xl grid-cols-[40px_1fr] gap-2 text-[13.5px] leading-relaxed text-bone-200">
                    <span className="label pt-[3px] text-moss-300">Next</span>
                    {c.recommendation}
                  </p>
                )}
              </div>
              <div className="col-start-2 mt-3 sm:col-start-3 sm:mt-0">
                <RiskTag risk={c.residual_risk} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditTail() {
  const { version } = useLab();
  const { data: events } = useLoad(() => api.audit(9), [version]);
  return (
    <section className="min-w-0 lg:col-span-5">
      <SectionHead index="03" title="Audit tail" aside={<a href={href("audit")} className="label hover:text-bone-200">Verify chain →</a>} />
      {events && events.length === 0 && <p className="py-8 text-[14px] text-bone-500">The chain is empty.</p>}
      <ol>
        {events
          ?.slice()
          .reverse()
          .map((event, i) => (
            <li key={event.seq} className="hairline fade-in grid grid-cols-[52px_1fr_auto] items-baseline gap-3 border-b py-2.5" style={stagger(i)}>
              <span className="font-mono text-[11px] text-bone-500">#{event.seq}</span>
              <span className="min-w-0 truncate text-[13px] text-bone-200">
                {event.event_type}
                <span className="ml-2 font-mono text-[10.5px] tracking-[0.08em] text-bone-500 uppercase">{event.actor}</span>
              </span>
              <Hash value={event.hash} length={10} />
            </li>
          ))}
      </ol>
    </section>
  );
}

export function Overview() {
  const { run, playing } = useLab();
  const stage: SceneStage = playing ?? run?.stage ?? "idle";
  const stageIndex = playing ? STAGES.indexOf(playing) + 1 : null;

  return (
    <div className="space-y-16 lg:space-y-20">
      <section className="grid gap-10 lg:grid-cols-12 lg:gap-12">
        <div className="flex min-w-0 flex-col lg:col-span-4">
          <Headline />
          <div className="hairline mt-10 space-y-7 border-t pt-6 lg:mt-auto">
            {run && <OutcomeStrip run={run} />}
            <RunFacts />
          </div>
        </div>
        <figure
          className="ticks hairline reveal relative h-[400px] min-w-0 border sm:h-[520px] lg:col-span-8 lg:h-[640px]"
          style={stagger(1)}
          aria-label="Isolation lattice: Red Team, Target LLM and Blue Team zones separated by gated walls"
        >
          <SecurityCore run={run} stage={stage} playing={Boolean(playing)} />
          <figcaption className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between gap-4">
            <span className="label whitespace-nowrap">Fig. 01<span className="hidden sm:inline"> · Isolation lattice</span></span>
            {/* Kept short on phones so it never collides with the Target label; the footer carries the detail. */}
            {stageIndex ? (
              <span className="label text-right text-moss-300">
                Stage 0{stageIndex} / 07<span className="hidden sm:inline"> · {STAGE_INFO[playing!].title}</span>
              </span>
            ) : (
              <span className="label hidden text-right sm:inline">{run?.report ? "Final state · latest run" : "Idle"}</span>
            )}
          </figcaption>
        </figure>
      </section>

      <section>
        <SectionHead
          index="01"
          title="Execution pipeline"
          aside={<span className="label hidden sm:inline">Each stage is executed by the backend before it is shown</span>}
        />
        <div className="pt-4 lg:pt-7">
          <Pipeline run={run} playing={playing} />
        </div>
      </section>

      <div className="grid gap-14 lg:grid-cols-12 lg:gap-12">
        <Findings />
        <AuditTail />
      </div>
    </div>
  );
}
