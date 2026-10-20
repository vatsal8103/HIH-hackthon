import type { CSSProperties, ReactNode } from "react";

import type { IsolationCheck, Risk, Stage, Verdict } from "../api";

const RISK_STYLE: Record<Risk, string> = {
  none: "text-moss-300",
  low: "text-moss-300",
  medium: "text-amber-300",
  high: "text-rust-300",
  critical: "text-rust-300",
};

const RISK_SWATCH: Record<Risk, string> = {
  none: "bg-moss-500",
  low: "bg-moss-500",
  medium: "bg-amber-400",
  high: "bg-rust-400",
  critical: "bg-rust-400",
};

export const riskText = (risk: Risk) => RISK_STYLE[risk];

export function RiskTag({ risk }: { risk: Risk | null | undefined }) {
  if (!risk) return <span className="label">—</span>;
  return (
    <span className={`inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] uppercase ${RISK_STYLE[risk]}`}>
      <span className={`size-1.5 ${RISK_SWATCH[risk]}`} aria-hidden />
      {risk}
    </span>
  );
}

export function VerdictTag({ verdict }: { verdict: Verdict | null | undefined }) {
  if (!verdict) return <span className="font-mono text-[11px] text-bone-500">pending</span>;
  return verdict === "pass" ? (
    <span className="font-mono text-[11px] tracking-[0.12em] text-moss-300 uppercase">pass</span>
  ) : (
    <span className="font-mono text-[11px] tracking-[0.12em] text-rust-300 uppercase">fail</span>
  );
}

const KIND_STYLE: Record<IsolationCheck["kind"] | "implemented" | "unknown", string> = {
  enforced: "border-moss-800 text-moss-300",
  network: "border-moss-800 text-moss-300",
  configured: "border-moss-800 text-moss-300",
  implemented: "border-moss-800 text-moss-300",
  simulated: "border-amber-900 text-amber-300",
  planned: "border-ink-600 text-bone-400",
  unknown: "border-rust-500 text-rust-300",
};

// What enforces each check, spelled out so an application check is never read as network isolation.
const KIND_LABEL: Record<keyof typeof KIND_STYLE, string> = {
  enforced: "app enforced",
  network: "network enforced",
  configured: "configured",
  implemented: "implemented",
  simulated: "simulated",
  planned: "planned",
  unknown: "unknown",
};

export function KindTag({ kind }: { kind: keyof typeof KIND_STYLE }) {
  return (
    <span className={`inline-block border px-1.5 py-px font-mono text-[10px] tracking-[0.14em] whitespace-nowrap uppercase ${KIND_STYLE[kind]}`}>
      {KIND_LABEL[kind]}
    </span>
  );
}

export function SectionHead({ index, title, aside }: { index: string; title: string; aside?: ReactNode }) {
  return (
    <div className="hairline flex items-baseline justify-between gap-4 border-b pb-3">
      <h2 className="flex items-baseline gap-3 text-[15px] font-medium tracking-tight text-bone-50">
        <span className="label">{index}</span>
        {title}
      </h2>
      {aside}
    </div>
  );
}

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="reveal max-w-3xl pt-2">
      <p className="label">{eyebrow}</p>
      <h1 className="mt-4 font-serif text-[44px] leading-[0.98] tracking-[-0.01em] text-bone-50 sm:text-[60px]">
        {title}
      </h1>
      {children && <div className="mt-5 max-w-2xl text-[15px] leading-relaxed text-bone-400">{children}</div>}
    </header>
  );
}

export function Hash({ value, length = 10 }: { value: string; length?: number }) {
  return (
    <span className="font-mono text-[11px] text-bone-400" title={value}>
      {value.slice(0, length)}…
    </span>
  );
}

export function Note({ tone = "neutral", children }: { tone?: "neutral" | "warn" | "error"; children: ReactNode }) {
  const border = { neutral: "border-ink-500", warn: "border-amber-400", error: "border-rust-400" }[tone];
  return <div className={`border-l-2 ${border} py-1 pl-4 text-[13px] leading-relaxed text-bone-400`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-10 text-[14px] text-bone-500">{children}</p>;
}

/** Inline custom property that staggers `.reveal` / `.fade-in` animations. */
export const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

export const shortId = (id: string) => id.slice(0, 8);

/** A SHA-256 hex digest in groups of eight so it wraps cleanly instead of truncating. */
export const groupHash = (hash: string) => hash.match(/.{1,8}/g)?.join(" ") ?? hash;

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const STAGE_ORDER: Record<Stage, number> = {
  attack: 0,
  respond: 1,
  evaluate: 2,
  defend: 3,
  retest: 4,
  isolation: 5,
  report: 6,
};
