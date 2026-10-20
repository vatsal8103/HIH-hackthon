import { Fragment, useId, useState, type ReactNode } from "react";

import type { Attempt } from "../api";
import { KIND_PLAIN, TONE_TEXT, targetNotice, type Outcome, type Tone } from "../explain";
import { KindTag } from "./ui";
import { useLab } from "../lab";

/** A "?" toggle that reveals a short plain explanation inline. Works with touch, keyboard and screen readers. */
export function Help({ term, children }: { term: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="ml-1.5 inline-grid size-[18px] translate-y-[-1px] place-items-center border border-ink-500 align-middle font-mono text-[10px] normal-case tracking-normal text-bone-400 transition-colors hover:border-bone-400 hover:text-bone-50"
      >
        <span aria-hidden>{open ? "×" : "?"}</span>
        <span className="sr-only">{open ? `Hide the explanation of ${term}` : `What is ${term}?`}</span>
      </button>
      {open && (
        <span id={id} className="fade-in mt-2 block max-w-xl border-l border-ink-500 pl-3 font-sans text-[13px] leading-relaxed font-normal normal-case tracking-normal text-bone-400">
          {children}
        </span>
      )}
    </>
  );
}

export function OutcomeTag({ outcome }: { outcome: Outcome }) {
  return <span className={`text-[13px] font-medium ${TONE_TEXT[outcome.tone]}`}>{outcome.label}</span>;
}

/** Expert detail kept one click away from the plain explanation. */
export function Technical({ summary = "Technical detail", children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="group mt-4">
      <summary className="label cursor-pointer list-none hover:text-bone-200">
        <span aria-hidden className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
        {summary}
      </summary>
      <div className="mt-3 border-l border-ink-600 pl-4 text-[12.5px] leading-relaxed text-bone-400">{children}</div>
    </details>
  );
}

const NOTICE_BORDER: Record<Tone, string> = {
  good: "border-moss-500",
  warn: "border-amber-400",
  bad: "border-rust-400",
  neutral: "border-ink-500",
};

/** The demo-environment notice, derived from what the backend reports about the target. */
export function TargetNotice({ className = "" }: { className?: string }) {
  const { meta } = useLab();
  const notice = targetNotice(meta?.target);
  if (!notice) return null;
  return (
    <div className={`border-l-2 ${NOTICE_BORDER[notice.tone]} py-0.5 pl-3 ${className}`}>
      <p className={`text-[12.5px] leading-snug ${TONE_TEXT[notice.tone]}`}>{notice.text}</p>
      <p className="mt-0.5 font-mono text-[10.5px] text-bone-500">{notice.detail}</p>
    </div>
  );
}

const SENSITIVE = /(BAYORA-CANARY-[A-Z0-9-]+|Mara Quell|MRN 00-4471|\[REDACTED\])/g;

/** Response text with leaked secrets (rust) and redactions (moss) marked. */
export function ResponseText({ text }: { text: string }) {
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

/** Which protection acted on an attempt, in plain words. */
export function guardLine(attempt: Attempt, ruleName: (id: string) => string = (id) => id): string | null {
  if (attempt.blocked_by) return `Blocked before reaching the AI by “${ruleName(attempt.blocked_by)}”`;
  const parts = [];
  if (attempt.transformed_by) parts.push(`hidden instructions removed by “${ruleName(attempt.transformed_by)}”`);
  if (attempt.filtered_by) parts.push(`answer rewritten by “${ruleName(attempt.filtered_by)}”`);
  return parts.length ? parts.join(" · ").replace(/^./, (c) => c.toUpperCase()) : null;
}

/** Rule id → its title from /api/meta, falling back to the id. */
export function useRuleName() {
  const { meta } = useLab();
  return (id: string) => meta?.rules[id]?.title ?? id;
}

/** What each isolation label means, so an application check is never read as network isolation. */
export function KindLegend() {
  return (
    <Technical summary="What the labels mean">
      <dl className="space-y-2">
        {(Object.keys(KIND_PLAIN) as (keyof typeof KIND_PLAIN)[]).map((kind) => (
          <div key={kind} className="grid gap-1 sm:grid-cols-[150px_1fr] sm:gap-4">
            <dt><KindTag kind={kind} /></dt>
            <dd>{KIND_PLAIN[kind]}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3">
        Independent check: the Docker integration suite (scripts/compose-test.sh) probes the same boundaries from outside
        the containers. It runs on the developer's machine, not from this page.
      </p>
    </Technical>
  );
}
