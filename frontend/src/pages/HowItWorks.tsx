import type { ReactNode } from "react";

import { STAGES } from "../api";
import { TargetNotice } from "../components/Explain";
import { KindTag, Note, PageHead, SectionHead } from "../components/ui";
import { OUTCOME_MEANING, PLAIN_STAGE, TONE_TEXT, WORKFLOW_LABEL, liveHost, targetNotice } from "../explain";
import { href } from "../hooks";
import { useLab } from "../lab";

// The technical reference: roles, the seven stages, evidence integrity and what is real in this
// deployment. The guided demo presents one recorded result; this page explains how it is produced.

const SWATCH = { red: "bg-rust-400", target: "bg-bone-200", evaluator: "bg-amber-400", blue: "bg-moss-400" } as const;
const textLink = "text-bone-50 underline decoration-ink-500 underline-offset-4 hover:decoration-bone-400";

function Role({ color, name, plain, children, where }: { color: keyof typeof SWATCH; name: string; plain: string; children: ReactNode; where?: ReactNode }) {
  return (
    <article className="flex flex-col bg-ink-950 p-5 sm:p-6">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden className={`size-2.5 ${SWATCH[color]}`} />
        <span className="text-[16px] font-medium tracking-tight text-bone-50">{name}</span>
        <span className="text-[13px] text-bone-500">{plain}</span>
      </p>
      <div className="mt-4 flex-1 space-y-3 text-[13.5px] leading-relaxed text-bone-400">{children}</div>
      {where && <p className="mt-5 text-[12px] leading-relaxed text-bone-500">{where}</p>}
    </article>
  );
}

function Roles() {
  const { meta } = useLab();
  const notice = targetNotice(meta?.target);
  const separate = (role: string) =>
    meta?.deployment.roles[role] === "agent"
      ? "Runs in its own container and can reach only the control plane."
      : meta
        ? "Runs inside the API process in this local setup (the Docker stack separates it)."
        : "";
  const target = meta?.target;
  return (
    <section>
      <SectionHead index="01" title="Who is involved" />
      <div className="mt-6 grid gap-px bg-ink-700 md:grid-cols-2 xl:grid-cols-4">
        <Role color="red" name="Red Team" plain="the tester" where={separate("red")}>
          <p>Submits scripted attack prompts from the attack library, one test case at a time.</p>
          <p>The prompts are harmless and aimed at a fictional clinic assistant, not a real system.</p>
        </Role>
        <Role color="target" name="Target" plain="the system under test" where={separate("target")}>
          <p>Generates a response to each prompt with the configured model.</p>
          <p className={notice ? TONE_TEXT[notice.tone] : ""}>
            {target?.kind === "simulated"
              ? "Here it is a simulator: fixed rules, the same answer every time. It is not a live AI model."
              : target?.kind === "unknown"
                ? "Here the target service did not answer, so what it runs is unknown."
                : target?.kind === "live"
                  ? liveHost(target.provider) === "groq"
                    ? `Here it is a real language model (${target.provider}) hosted by Groq, a third-party service. The attack prompts and the synthetic scenario are sent there, and answers can vary between runs.`
                    : `Here it is a real language model (${target.provider ?? "live"}) running locally through Ollama. Answers can vary between runs.`
                  : target
                    ? `Here it is ${target.provider ?? target.kind}.`
                    : "Loading what the target is…"}
          </p>
        </Role>
        <Role color="evaluator" name="Evaluator" plain="the judge" where="Runs in the control plane, never in a role container.">
          <p>Checks each response against the criteria written for its attack: leaked secrets or personal data, accepted overrides, refusals, and whether a legitimate task was done.</p>
          <p>The checks are deterministic heuristics, not a full audit: a reworded or summarised leak can be missed.</p>
        </Role>
        <Role color="blue" name="Blue Team" plain="the defender" where={separate("blue")}>
          <p>Applies the configured protections (input guards and an output filter) for what failed.</p>
          <p>
            It sees only a redacted summary, never the attack prompts. It is <span className="text-amber-300">simulated</span>: a
            fixed playbook maps each violated criterion to one rule. It is not an AI.
          </p>
        </Role>
      </div>
      <TargetNotice className="mt-5 max-w-3xl" />
    </section>
  );
}

function Workflow() {
  return (
    <section>
      <SectionHead index="02" title="What happens in a test" />
      <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-bone-400">
        One test session runs seven recorded stages, one per request, in this order. Each stage writes its result to the
        audit record before the next one starts.
      </p>
      <ol className="mt-6 grid gap-px bg-ink-700 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" aria-label="The seven stages of a test">
        {STAGES.map((stage, i) => (
          <li key={stage} className="relative bg-ink-950 p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-7 shrink-0 place-items-center border border-ink-500 font-mono text-[12px] text-bone-200">{i + 1}</span>
              {i < STAGES.length - 1 && <span aria-hidden className="h-px flex-1 bg-ink-600" />}
            </div>
            <p className="mt-3 text-[14.5px] font-medium tracking-tight text-bone-50">{WORKFLOW_LABEL[stage]}</p>
            <p className="font-mono text-[10px] tracking-[0.1em] text-bone-500 uppercase">{PLAIN_STAGE[stage].who}</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-bone-400">{PLAIN_STAGE[stage].sentence}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 max-w-4xl">
        <p className="text-[14px] leading-relaxed text-bone-400">
          After the retest, every attack gets one outcome from its recorded attempts. An improvement is reported only when
          the recorded retry passed where the first attempt failed, and a protection is credited only when it is recorded as
          acting.
        </p>
        <details className="group hairline mt-4 border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-[14px] text-bone-50 hover:bg-ink-900">
            <span>
              What each retest outcome means <span className="text-bone-500">· {Object.keys(OUTCOME_MEANING).length} outcomes</span>
            </span>
            <span aria-hidden className="text-bone-500 transition-transform group-open:rotate-90">›</span>
          </summary>
          <dl className="px-4 pb-2">
            {Object.values(OUTCOME_MEANING).map((item) => (
              <div key={item.label} className="hairline grid gap-1 border-t py-3 sm:grid-cols-[210px_1fr] sm:gap-6">
                <dt className={`text-[13.5px] font-medium ${TONE_TEXT[item.tone]}`}>{item.label}</dt>
                <dd className="text-[13.5px] leading-relaxed text-bone-400">{item.meaning}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </section>
  );
}

function ChainDiagram() {
  const box = "border border-ink-600 px-3 py-2 font-mono text-[11px] leading-relaxed";
  return (
    <div className="flex flex-col items-start" role="img" aria-label="Three record entries, each holding the fingerprint of the one before it">
      {[41, 42, 43].map((n, i) => (
        <div key={n} className="flex flex-col items-start">
          {i > 0 && (
            <span aria-hidden className="py-1 pl-4 font-mono text-[11px] text-bone-500">
              ↓ links to
            </span>
          )}
          <div className={box}>
            <span className="text-bone-200">#{n}</span>
            <span className="ml-3 text-bone-500">prev: #{n - 1}'s fingerprint</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Evidence() {
  const { meta } = useLab();
  const witnessed = meta?.deployment.checkpoint === "witness";
  const dbControl = meta?.controls.find((control) => control.name === "Database least privilege");
  const leastPrivilege = dbControl ? dbControl.status === "implemented" : null;
  const card = "bg-ink-950 p-5 sm:p-6";
  const heading = "text-[15.5px] font-medium tracking-tight text-bone-50";
  const body = "mt-3 text-[13.5px] leading-relaxed text-bone-400";
  return (
    <section>
      <SectionHead index="03" title="How the evidence is protected" aside={<a href={href("audit")} className="label hover:text-bone-200">Check its current status →</a>} />
      <div className="mt-6 grid gap-px bg-ink-700 lg:grid-cols-3">
        <article className={card}>
          <h3 className={heading}>Hash-linked audit trail</h3>
          <p className={body}>
            Every action is recorded in order. Each entry stores a fingerprint (hash) of itself and of the entry before it, so
            editing, deleting or reordering an entry breaks the links.
            {leastPrivilege === true
              ? " Here the runtime database role cannot update or delete audit entries."
              : leastPrivilege === false
                ? " In this deployment the database user can still modify audit rows (see the register below)."
                : ""}
          </p>
          <div className="mt-5">
            <ChainDiagram />
          </div>
        </article>
        <article className={card}>
          <h3 className={heading}>Separate witness service</h3>
          <p className={body}>
            Someone with full control of the database could rewrite every entry and recompute every fingerprint. So after each
            stage the latest fingerprint is sent to a witness, a separate service with its own storage, which keeps an
            append-only log of checkpoints and accepts a new one only if it extends the last.
          </p>
          {meta && (
            <p className={`mt-4 text-[12.5px] leading-relaxed ${witnessed ? "text-bone-500" : "text-amber-300"}`}>
              {witnessed
                ? "This deployment has a witness."
                : "This deployment has no witness, so a complete rewrite would not be detected here. The Docker stack runs one."}
            </p>
          )}
        </article>
        <article className={card}>
          <h3 className={heading}>Checkpoint verification and its limits</h3>
          <p className={body}>
            Verification recomputes every fingerprint and compares the record with every witness checkpoint. Entries after the
            latest checkpoint are <span className="text-bone-200">unanchored</span>: not yet protected by a checkpoint until
            the next one is written.
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-bone-500">
            This is tamper detection, not tamper-proofing. Someone who controls both the database and the witness's storage
            could still alter both.
          </p>
        </article>
      </div>
    </section>
  );
}

const STATUS_PLAIN = {
  implemented: "Active in this deployment",
  simulated: "A stand-in, not the real thing",
  planned: "Not built yet, or not active here",
  unknown: "The service did not answer",
} as const;

function RealOrSimulated() {
  const { meta } = useLab();
  const groq = meta?.target?.kind === "live" && liveHost(meta.target.provider) === "groq";
  return (
    <section>
      <SectionHead index="04" title="What is real, simulated and planned" />
      <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-bone-400">
        The backend computes this register for the deployment you are looking at, so a control is listed as implemented only
        when it is active here. Automated tests back the implemented controls (backend unit tests and a container suite that
        probes the Docker stack). The{" "}
        <a href={href("isolation")} className={textLink}>
          Isolation lab
        </a>{" "}
        shows the checks that ran in the latest test.
      </p>
      <div className="mt-6 grid gap-px bg-ink-700 md:grid-cols-3">
        {(["implemented", "simulated", "planned", "unknown"] as const)
          .filter((status) => status !== "unknown" || meta?.controls.some((control) => control.status === "unknown"))
          .map((status) => (
            <div key={status} className="bg-ink-950 p-5">
              <KindTag kind={status} />
              <p className="mt-2 text-[12.5px] text-bone-500">{STATUS_PLAIN[status]}</p>
              <ul className="mt-4 space-y-4">
                {meta?.controls
                  .filter((control) => control.status === status)
                  .map((control) => (
                    <li key={control.name}>
                      <p className="text-[13.5px] text-bone-200">{control.name}</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-bone-500">{control.detail}</p>
                    </li>
                  ))}
                {!meta && <li className="text-[12.5px] text-bone-500">Loading…</li>}
              </ul>
            </div>
          ))}
      </div>
      <div className="mt-6 max-w-3xl">
        <Note tone="warn">
          <span className="text-bone-200">Limits to keep in mind.</span> The evaluator's checks are heuristics written for
          this scripted scenario; seven scripted attacks are not a security audit, and a pass is not proof of safety.
          {groq ? " The live model is hosted by Groq, a third party: attack prompts and the synthetic scenario leave this machine." : ""}{" "}
          Containers share one host kernel; there is no kernel-level sandbox.
        </Note>
      </div>
    </section>
  );
}

const GLOSSARY: [string, string][] = [
  ["Prompt injection", "Text that tries to override the AI's original instructions, such as “ignore all previous instructions”."],
  ["Jailbreak", "Persuading the AI to drop its rules, often by asking it to play a character without limits."],
  ["Obfuscation", "Hiding an attack, for example in Base64 encoding, so simple filters do not recognise it."],
  ["Indirect prompt injection", "An instruction hidden inside content the AI is asked to read, such as a document."],
  ["Protection (guardrail)", "A rule placed in front of or behind the AI: it can block a prompt, clean it, or filter the answer."],
  ["Baseline", "The first attempt, before the Blue Team adds protections."],
  ["Residual risk", "How serious the remaining problem is after the retest, set by the most serious rule still broken."],
  ["Hash", "A fingerprint of some data. Changing even one character gives a completely different fingerprint."],
];

function Glossary() {
  return (
    <section>
      <details className="group hairline border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-ink-900">
          <span className="flex items-baseline gap-3 text-[14px] text-bone-50">
            <span className="label">05</span>
            Security glossary <span className="text-bone-500">· {GLOSSARY.length} terms</span>
          </span>
          <span aria-hidden className="text-bone-500 transition-transform group-open:rotate-90">›</span>
        </summary>
        <dl className="grid gap-x-10 px-4 pb-2 md:grid-cols-2">
          {GLOSSARY.map(([term, meaning]) => (
            <div key={term} className="hairline grid gap-1 border-t py-3 sm:grid-cols-[170px_1fr] sm:gap-5">
              <dt className="text-[13.5px] text-bone-50">{term}</dt>
              <dd className="text-[13.5px] leading-relaxed text-bone-400">{meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

export function HowItWorks() {
  const { online } = useLab();
  return (
    <div className="space-y-14">
      <PageHead eyebrow="How it works · technical reference" title="One test, start to finish.">
        Who takes part, the seven recorded stages of a test, how the evidence is protected, and what is real, simulated or
        planned in this deployment. To present a recorded result instead, use the{" "}
        <a href={href("demo")} className={textLink}>
          guided demo
        </a>
        .
      </PageHead>
      {online === false && <Note tone="error">The API is offline, so live statuses on this page are missing.</Note>}
      <Roles />
      <Workflow />
      <Evidence />
      <RealOrSimulated />
      <Glossary />
      <div className="hairline flex flex-col gap-5 border p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div>
          <p className="text-[17px] font-medium tracking-tight text-bone-50">See it on a real result</p>
          <p className="mt-1 text-[13.5px] text-bone-400">The guided demo presents one recorded attack, its defense and its evidence in 60 to 90 seconds.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <a href={href("demo")} className="btn btn-primary">
            Start the guided demo <span aria-hidden>→</span>
          </a>
          <a href={href()} className="btn">
            Back to the overview
          </a>
        </div>
      </div>
    </div>
  );
}
