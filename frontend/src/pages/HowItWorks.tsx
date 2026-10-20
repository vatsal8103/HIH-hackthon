import type { ReactNode } from "react";

import { STAGES } from "../api";
import { KindTag, Note, PageHead, SectionHead, stagger } from "../components/ui";
import { OUTCOME_MEANING, PLAIN_STAGE, TONE_TEXT, targetNotice } from "../explain";
import { href } from "../hooks";
import { useLab } from "../lab";

const SWATCH = { red: "bg-rust-400", target: "bg-bone-200", blue: "bg-moss-400" } as const;

function Role({ color, name, plain, children, where }: { color: keyof typeof SWATCH; name: string; plain: string; children: ReactNode; where: ReactNode }) {
  return (
    <article className="bg-ink-950 p-6">
      <p className="flex items-center gap-3">
        <span aria-hidden className={`size-2.5 ${SWATCH[color]}`} />
        <span className="text-[16px] font-medium tracking-tight text-bone-50">{name}</span>
        <span className="text-[13px] text-bone-500">· {plain}</span>
      </p>
      <div className="mt-4 space-y-3 text-[14px] leading-relaxed text-bone-400">{children}</div>
      <p className="mt-5 text-[12px] text-bone-500">{where}</p>
    </article>
  );
}

function Roles() {
  const { meta } = useLab();
  const notice = targetNotice(meta?.target);
  const separate = (role: string) =>
    meta?.deployment.roles[role] === "agent"
      ? "In this deployment it runs in its own container and can reach only the control plane."
      : meta
        ? "In this local setup it runs inside the API process (the Docker version separates it)."
        : "";
  return (
    <section>
      <SectionHead index="01" title="Who is involved" />
      <div className="mt-6 grid gap-px bg-ink-700 lg:grid-cols-3">
        <Role color="red" name="Red Team" plain="the tester" where={separate("red")}>
          <p>Tries to manipulate the AI using controlled attack prompts from the attack library.</p>
          <p>The prompts are scripted and harmless; they aim at a fictional clinic assistant, not a real system.</p>
        </Role>
        <Role color="target" name="Target" plain="the system under test" where={separate("target")}>
          <p>Receives each prompt and generates a response.</p>
          <p className={notice ? TONE_TEXT[notice.tone] : ""}>
            {meta?.target?.kind === "simulated"
              ? "Here it is a simulator: it follows fixed rules, so the same prompt always gets the same answer. It is not a live AI model."
              : meta?.target?.kind === "unknown"
                ? "Here the target service did not answer, so what it runs is unknown."
                : meta?.target
                  ? `Here it is ${meta.target.provider ?? meta.target.kind}.`
                  : "Loading what the target is…"}
          </p>
        </Role>
        <Role color="blue" name="Blue Team" plain="the defender" where={separate("blue")}>
          <p>Examines what failed and applies the configured defenses (input guards and an output filter).</p>
          <p>It sees only a redacted summary, never the attack prompts, so it fixes the weakness rather than one prompt. In this demo it follows a fixed playbook.</p>
        </Role>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section>
      <SectionHead index="02" title="What happens in a test" />
      <ol className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stage, i) => (
          <li key={stage} className="reveal grid grid-cols-[34px_1fr] gap-2" style={stagger(i)}>
            <span className="font-serif text-[28px] leading-none text-bone-500">{i + 1}</span>
            <div>
              <p className="text-[15px] font-medium tracking-tight text-bone-50">{PLAIN_STAGE[stage].name}</p>
              <p className="font-mono text-[10.5px] tracking-[0.08em] text-bone-500 uppercase">{PLAIN_STAGE[stage].who}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-bone-400">{PLAIN_STAGE[stage].sentence}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-12 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <h3 className="text-[16px] font-medium tracking-tight text-bone-50">Retest · did the defense help?</h3>
          <p className="mt-3 text-[14px] leading-relaxed text-bone-400">
            For every attack, Bayora compares the first attempt with the retry. It reports an improvement only when the
            recorded retry passed where the first attempt failed, and it names the protection that made the difference.
          </p>
        </div>
        <dl className="lg:col-span-8">
          {Object.values(OUTCOME_MEANING).map((item) => (
            <div key={item.label} className="hairline grid gap-1 border-b py-3 sm:grid-cols-[190px_1fr] sm:gap-6">
              <dt className={`text-[13.5px] font-medium ${TONE_TEXT[item.tone]}`}>{item.label}</dt>
              <dd className="text-[13.5px] leading-relaxed text-bone-400">{item.meaning}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ChainDiagram() {
  const box = "border border-ink-600 px-3 py-2 font-mono text-[11px] leading-relaxed";
  return (
    <div className="flex flex-wrap items-center gap-2" role="img" aria-label="Three record entries, each holding the fingerprint of the one before it">
      {[41, 42, 43].map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <div className={box}>
            <span className="block text-bone-200">#{n}</span>
            <span className="block text-bone-500">prev: #{n - 1}'s fingerprint</span>
          </div>
          {i < 2 && <span aria-hidden className="text-bone-500">→</span>}
        </div>
      ))}
    </div>
  );
}

function Record() {
  const { meta } = useLab();
  const witnessed = meta?.deployment.checkpoint === "witness";
  return (
    <section>
      <SectionHead index="03" title="How the evidence is protected" aside={<a href={href("audit")} className="label hover:text-bone-200">Check its current status →</a>} />
      <div className="mt-6 grid gap-px bg-ink-700 lg:grid-cols-2">
        <article className="bg-ink-950 p-6">
          <h3 className="text-[16px] font-medium tracking-tight text-bone-50">Audit trail · what happened?</h3>
          <p className="mt-3 text-[14px] leading-relaxed text-bone-400">
            Every step is recorded in order. Each entry stores a fingerprint of itself and of the entry before it, so
            editing, deleting or reordering an entry breaks the links and verification fails.
          </p>
          <div className="mt-5">
            <ChainDiagram />
          </div>
        </article>
        <article className="bg-ink-950 p-6">
          <h3 className="text-[16px] font-medium tracking-tight text-bone-50">Witness checkpoints · can changes be detected?</h3>
          <p className="mt-3 text-[14px] leading-relaxed text-bone-400">
            Someone with control of the database could rewrite the whole record and recompute every fingerprint. So a
            separate witness service keeps its own copy of checkpoints. Comparing against them reveals changes to any
            anchored entry. Entries after the latest checkpoint are not protected until the next one.
          </p>
          {meta && (
            <p className={`mt-4 text-[13px] leading-relaxed ${witnessed ? "text-bone-400" : "text-amber-300"}`}>
              {witnessed
                ? "This deployment has a witness."
                : "This deployment has no witness, so a complete rewrite would not be detected here. The Docker stack runs one."}
            </p>
          )}
          <p className="mt-4 text-[12.5px] leading-relaxed text-bone-500">
            This is detection, not absolute tamper-proofing: someone who controls both the database and the witness's
            storage could still alter both.
          </p>
        </article>
      </div>
    </section>
  );
}

const STATUS_PLAIN = {
  implemented: "Active in this deployment",
  simulated: "Simulated: a stand-in, not the real thing",
  planned: "Planned: not built yet",
  unknown: "Unknown: the service did not answer",
} as const;

function RealOrSimulated() {
  const { meta } = useLab();
  return (
    <section>
      <SectionHead index="04" title="What is real here, and what is simulated" />
      <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-bone-400">
        The backend computes this list for the deployment you are looking at. Automated tests back the active controls:
        backend unit tests, and a Docker suite that probes the containers from outside. Those run on the developer's
        machine, not from this page. The{" "}
        <a href={href("isolation")} className="text-bone-50 underline decoration-ink-500 underline-offset-4">
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
            </ul>
          </div>
        ))}
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
      <SectionHead index="05" title="Words you will see" />
      <dl className="mt-4 grid gap-x-10 md:grid-cols-2">
        {GLOSSARY.map(([term, meaning]) => (
          <div key={term} className="hairline grid gap-1 border-b py-3 sm:grid-cols-[170px_1fr] sm:gap-5">
            <dt className="text-[13.5px] text-bone-50">{term}</dt>
            <dd className="text-[13.5px] leading-relaxed text-bone-400">{meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function HowItWorks() {
  const { online } = useLab();
  return (
    <div className="space-y-16">
      <PageHead eyebrow="How it works" title="One test, start to finish.">
        Bayora is a practice range for AI security. A tester attacks an AI with scripted prompts, an evaluator checks what
        the AI said, a defender adds protections, and the same attacks run again. Every step is written to a record that
        shows whether it was changed later.
      </PageHead>
      {online === false && <Note tone="error">The API is offline, so live statuses on this page are missing.</Note>}
      <Roles />
      <Steps />
      <Record />
      <RealOrSimulated />
      <Glossary />
      <div className="hairline flex flex-wrap items-center gap-3 border-t pt-8">
        <a href={href("demo")} className="btn btn-primary">
          Start the guided demo <span aria-hidden>→</span>
        </a>
        <a href={href()} className="btn">
          Back to the overview
        </a>
      </div>
    </div>
  );
}
