import { useEffect, useState, type ReactNode } from "react";

import { href } from "../hooks";
import { useLab } from "../lab";
import { PLAIN_STAGE, stageResult } from "../explain";

export const NAV = [
  { path: "", label: "Overview" },
  { path: "how", label: "How it works" },
  { path: "demo", label: "Guided demo" },
  { path: "runs", label: "Test runs" },
  { path: "attacks", label: "Attack library" },
  { path: "isolation", label: "Isolation lab" },
  { path: "audit", label: "Audit trail" },
  { path: "reports", label: "Risk reports" },
];

export function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <path d="M16 4.5 26 10.25v11.5L16 27.5 6 21.75v-11.5Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M16 16V4.5M16 16 6 21.75M16 16l10 5.75" stroke="#5e594f" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.3" fill="currentColor" />
      <circle cx="9.6" cy="11.8" r="1.25" fill="#c9705f" />
      <circle cx="22.4" cy="11.8" r="1.25" fill="#9cae7e" />
    </svg>
  );
}

function Wordmark() {
  return (
    <a href={href()} className="flex items-center gap-3 text-bone-50">
      <Mark />
      <span className="flex flex-col leading-none">
        <span className="font-serif text-[25px] tracking-[0.01em]">Bayora</span>
        <span className="mt-1 font-mono text-[9px] tracking-[0.2em] text-bone-500 uppercase">Adversarial lab</span>
      </span>
    </a>
  );
}

function NavLinks({ active, onNavigate }: { active: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary">
      <ul className="flex flex-col">
        {NAV.map((item, i) => {
          const current = item.path === active;
          return (
            <li key={item.path}>
              <a
                href={href(item.path)}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                className={`group flex items-baseline gap-3 border-l py-2.5 pl-4 text-[14px] transition-colors duration-200 ${
                  current
                    ? "border-bone-50 text-bone-50"
                    : "border-ink-700 text-bone-400 hover:border-bone-500 hover:text-bone-50"
                }`}
              >
                <span aria-hidden className="font-mono text-[10px] text-bone-700 group-hover:text-bone-500">0{i + 1}</span>
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SystemStatus() {
  const { online, meta, busy, playing } = useLab();
  const isolated = meta ? Object.values(meta.deployment.roles).every((mode) => mode === "agent") : false;
  return (
    <dl className="space-y-2.5 font-mono text-[10.5px] tracking-[0.08em] text-bone-500 uppercase">
      <div className="flex justify-between gap-3">
        <dt>API</dt>
        <dd className={online === false ? "text-rust-300" : online ? "text-moss-300" : ""}>
          {online === null ? "…" : online ? "online" : "offline"}
        </dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>Target</dt>
        <dd className={!meta ? "" : meta.target?.kind === "unknown" ? "text-rust-300" : meta.target?.kind === "simulated" ? "text-amber-300" : "text-bone-200"}>
          {meta ? (meta.target?.kind ?? "not reported") : "…"}
        </dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>Storage</dt>
        <dd className="text-bone-200">{meta?.storage ?? "…"}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>Roles</dt>
        <dd className={isolated ? "text-moss-300" : "text-amber-300"}>{meta ? (isolated ? "isolated" : "in-process") : "…"}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>Anchor</dt>
        <dd className={meta?.deployment.checkpoint === "witness" ? "text-moss-300" : "text-amber-300"}>
          {meta ? (meta.deployment.checkpoint === "witness" ? "witness" : "none") : "…"}
        </dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>Run</dt>
        <dd className={busy ? "flex items-center gap-1.5 text-moss-300" : "text-bone-200"}>
          {busy && <span className="live-dot size-1 bg-moss-300" aria-hidden />}
          {busy ? (playing ? PLAIN_STAGE[playing].name : "starting") : "idle"}
        </dd>
      </div>
    </dl>
  );
}

export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { busy, playing, error, run, dismiss } = useLab();

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  // Announced to assistive technology on every page as the backend executes stages.
  const announcement =
    busy && playing && run
      ? `Step “${PLAIN_STAGE[playing].name}” finished. ${stageResult(run, playing)?.text ?? ""}`
      : !busy && run?.report
        ? `Run complete. Highest remaining risk: ${run.report.overall_risk}.`
        : "";

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[236px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:bg-bone-50 focus:px-3 focus:py-2 focus:text-ink-950">
        Skip to content
      </a>

      {/* Desktop rail */}
      <aside className="hairline no-print sticky top-0 hidden h-screen flex-col justify-between border-r px-6 py-7 lg:flex">
        <div className="space-y-12">
          <Wordmark />
          <NavLinks active={active} />
        </div>
        <SystemStatus />
      </aside>

      {/* Mobile bar */}
      <header className="hairline no-print sticky top-0 z-30 flex items-center justify-between border-b bg-ink-950/95 px-4 py-3 backdrop-blur-sm lg:hidden">
        <Wordmark />
        <button
          type="button"
          className="label flex h-9 items-center gap-2 border border-ink-600 px-3 text-bone-200"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {busy && <span className="live-dot size-1 bg-moss-300" aria-hidden />}
          {menuOpen ? "Close" : "Menu"}
        </button>
      </header>
      {menuOpen && (
        <div id="mobile-menu" className="fade-in fixed inset-x-0 top-[61px] bottom-0 z-20 overflow-y-auto bg-ink-950 px-4 py-6 lg:hidden">
          <NavLinks active={active} onNavigate={() => setMenuOpen(false)} />
          <div className="hairline mt-8 border-t pt-6">
            <SystemStatus />
          </div>
        </div>
      )}

      <main id="main" className="relative min-w-0">
        <p className="sr-only" role="status">
          {announcement}
        </p>
        {busy && <div key={playing ?? "start"} className="sweep no-print fixed top-0 right-0 left-0 z-40 h-px bg-moss-400 lg:left-[236px]" />}
        {error && (
          <div role="alert" className="flex items-start justify-between gap-4 border-b border-rust-500/40 bg-rust-900/60 px-4 py-2.5 text-[13px] text-rust-300 sm:px-8 lg:px-12">
            <span>{error}</span>
            <button type="button" className="label shrink-0 text-rust-300 hover:text-bone-50" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        )}
        <div className="mx-auto max-w-[1480px] px-4 pt-8 pb-24 sm:px-8 lg:px-12 lg:pt-12">{children}</div>
      </main>
    </div>
  );
}
