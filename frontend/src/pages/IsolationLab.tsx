import { useState } from "react";

import { api, type ProbeRow } from "../api";
import { KindTag, Note, PageHead, SectionHead, stagger } from "../components/ui";
import { useLab } from "../lab";

const ROLES: [string, string][] = [
  ["operator", "Lab supervisor"],
  ["red", "Sandbox A"],
  ["blue", "Sandbox B"],
  ["target", "Simulated model"],
  ["anonymous", "No token"],
];
// Mirrors isolation.RESOURCES on the backend. Permissions here only label cells before probing.
const RESOURCES = [
  { id: "attack_library", label: "Attack library", route: "GET /api/attacks", permission: "attacks:read" },
  { id: "red_attempts", label: "Red attempts", route: "GET /red/…/attempts", permission: "red:read" },
  { id: "red_submit", label: "Submit attack", route: "POST /red/…/attempts", permission: "red:submit" },
  { id: "blue_findings", label: "Blue findings", route: "GET /blue/…/findings", permission: "blue:read" },
  { id: "blue_defend", label: "Apply defense", route: "POST /blue/…/defenses", permission: "blue:defend" },
  { id: "target_inbox", label: "Target inbox", route: "GET /target/…/inbox", permission: "target:read" },
  { id: "audit_log", label: "Audit log", route: "GET /api/audit", permission: "audit:read" },
  { id: "run_advance", label: "Advance run", route: "POST /runs/…/advance", permission: "runs:write" },
];

interface CellProps {
  row: ProbeRow | undefined;
  index: number;
  emphasis: boolean;
  onEnter: () => void;
}

function Cell({ row, index, emphasis, onEnter }: CellProps) {
  if (!row) return <td className="hairline border p-0" />;
  const allowed = row.expected === "allow";
  return (
    <td onMouseEnter={onEnter} className={`border p-0 transition-colors ${emphasis ? "border-ink-500" : "border-ink-700"}`}>
      <div
        className={`fade-in flex h-14 flex-col items-center justify-center gap-0.5 ${row.ok ? (allowed ? "bg-moss-900/60" : "") : "bg-rust-900"}`}
        style={stagger(index)}
        title={`${row.method} ${row.path} as ${row.role}: expected ${row.expected}, got ${row.status}`}
      >
        <span className={`font-mono text-[12px] ${row.ok ? (allowed ? "text-moss-300" : "text-bone-400") : "text-rust-300"}`}>
          {row.status}
        </span>
        <span className="font-mono text-[9px] tracking-[0.14em] text-bone-500 uppercase">{row.ok ? row.expected : "mismatch"}</span>
      </div>
    </td>
  );
}

export function IsolationLab() {
  const { run, meta } = useLab();
  const [rows, setRows] = useState<ProbeRow[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ role: string; resource: string } | null>(null);

  const probe = async () => {
    setProbing(true);
    setError(null);
    try {
      setRows(await api.probeMatrix());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const mismatches = rows?.filter((r) => !r.ok).length ?? 0;
  const allowed = rows?.filter((r) => r.ok && r.expected === "allow").length ?? 0;
  const find = (role: string, resource: string) => rows?.find((r) => r.role === role && r.resource === resource);
  const expected = (role: string, permission: string) => role !== "anonymous" && meta?.permissions[role]?.includes(permission);

  return (
    <div className="space-y-14">
      <PageHead eyebrow="Isolation lab" title="Who can reach what.">
        The backend sends real requests to its own routes with each role's token and compares every status code with
        the permission table. Probes use a session id that never exists, so allowed requests return 404 and change nothing.
      </PageHead>

      <Note tone="warn">
        Scope: these probes test application-layer authorisation inside one backend process. They do not test
        operating-system, container or network isolation, which this prototype does not enforce.
      </Note>

      <section>
        <SectionHead
          index="01"
          title="Permission matrix"
          aside={
            rows && (
              <span className={`label ${mismatches ? "text-rust-300" : "text-moss-300"}`}>
                {rows.length} probes · {mismatches} mismatch{mismatches === 1 ? "" : "es"}
              </span>
            )
          }
        />
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button type="button" className="btn btn-primary" onClick={probe} disabled={probing}>
            {probing ? "Probing…" : rows ? "Probe again" : "Run 40 live probes"}
          </button>
          {error && <span className="text-[13px] text-rust-300">{error}</span>}
          {!rows && !error && <span className="text-[13px] text-bone-500">Until probed, cells show what the policy expects.</span>}
          {rows && (
            <span className="text-[13px] text-bone-400">
              {allowed} allowed and {rows.length - allowed - mismatches} denied exactly as the policy states.
            </span>
          )}
        </div>
        <p className="label mt-8 sm:hidden" aria-hidden>Scroll the matrix sideways →</p>
        <div className="mt-3 -mx-4 overflow-x-auto sm:mx-0 sm:mt-8" onMouseLeave={() => setPointer(null)}>
          <table className="w-full min-w-[860px] border-collapse">
            <caption className="sr-only">
              Status code returned to each role for each protected resource, compared with the permission table
            </caption>
            <thead>
              <tr>
                <td className="sticky left-0 z-10 w-36 bg-ink-950 sm:w-32" />
                {RESOURCES.map((resource) => (
                  <th
                    key={resource.id}
                    scope="col"
                    className={`px-2 pb-3 text-left align-bottom font-normal transition-colors ${pointer?.resource === resource.id ? "text-bone-50" : "text-bone-200"}`}
                  >
                    <span className="block text-[12.5px]">{resource.label}</span>
                    <span className="block font-mono text-[9.5px] text-bone-500">{resource.route}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLES.map(([role, description], r) => (
                <tr key={role}>
                  <th scope="row" className="sticky left-0 z-10 bg-ink-950 pr-4 pl-4 text-left font-normal sm:pl-0">
                    <span className={`label block transition-colors ${pointer?.role === role ? "text-bone-50" : ""}`}>{role}</span>
                    <span className="block text-[11.5px] text-bone-500">{description}</span>
                  </th>
                  {RESOURCES.map((resource, c) => {
                    const emphasis = pointer?.role === role || pointer?.resource === resource.id;
                    const enter = () => setPointer({ role, resource: resource.id });
                    return rows ? (
                      <Cell key={resource.id} row={find(role, resource.id)} index={r * RESOURCES.length + c} emphasis={emphasis} onEnter={enter} />
                    ) : (
                      <td key={resource.id} onMouseEnter={enter} className={`border transition-colors ${emphasis ? "border-ink-500" : "border-ink-700"}`}>
                        <div className="flex h-14 items-center justify-center gap-1.5 font-mono text-[9.5px] tracking-[0.14em] text-bone-500 uppercase">
                          {expected(role, resource.permission) ? (
                            <>
                              <span aria-hidden className="size-1 bg-moss-400" />
                              allow
                            </>
                          ) : (
                            "deny"
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionHead index="02" title="Checks from the latest run" />
        {!run || run.isolation.length === 0 ? (
          <p className="py-8 text-[14px] text-bone-500">Run a test to execute isolation checks.</p>
        ) : (
          <ul>
            {run.isolation.map((check, i) => (
              <li key={check.check_id} className="hairline reveal grid gap-2 border-b py-5 sm:grid-cols-[72px_1fr_112px] sm:gap-6" style={stagger(i)}>
                <span className="font-mono text-[12px] text-bone-500">{check.check_id}</span>
                <div>
                  <p className="text-[14.5px] font-medium tracking-tight">{check.title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-bone-500">{check.detail}</p>
                </div>
                <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                  <KindTag kind={check.kind} />
                  <span className={`font-mono text-[11px] uppercase ${check.status === "pass" ? "text-moss-300" : check.status === "fail" ? "text-rust-300" : "text-bone-500"}`}>{check.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHead index="03" title="Control register" />
        <div className="grid gap-px bg-ink-700 md:grid-cols-3">
          {(["implemented", "simulated", "planned"] as const).map((status) => (
            <div key={status} className="bg-ink-950 p-5 md:p-6">
              <KindTag kind={status} />
              <ul className="mt-5 space-y-5">
                {meta?.controls
                  .filter((control) => control.status === status)
                  .map((control) => (
                    <li key={control.name}>
                      <p className="text-[14px] text-bone-50">{control.name}</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-bone-500">{control.detail}</p>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
