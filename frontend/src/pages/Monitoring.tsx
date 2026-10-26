import { useEffect, useState } from "react";

import { api, type Alert, type AlertsResponse } from "../api";
import { Empty, Note, PageHead, SectionHead, stagger, time } from "../components/ui";

const ROLE_COLOR: Record<string, string> = {
  red: "border-rust-800 text-rust-300 bg-rust-950/40",
  blue: "border-sky-800 text-sky-300 bg-sky-950/40",
  target: "border-amber-800 text-amber-300 bg-amber-950/40",
  operator: "border-moss-800 text-moss-300 bg-moss-950/40",
  anonymous: "border-ink-600 text-bone-400 bg-ink-900/40",
};

export function Monitoring() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = async () => {
    try {
      setError(null);
      const res = await api.alerts();
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
  }, []);

  const handleTriggerDemo = async () => {
    setTriggering(true);
    setError(null);
    try {
      await api.triggerDemoAlert();
      await fetchAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggering(false);
    }
  };

  const roles = ["red", "blue", "target", "anonymous", "operator"];

  return (
    <div className="space-y-14">
      <PageHead eyebrow="Continuous monitoring" title="Real-time access alerts & anomaly detection.">
        Detect cross-boundary access, forbidden routes, expired/replayed credentials, and unusual request bursts
        in real time. Every alert is cryptographically recorded in the hash-linked audit chain.
      </PageHead>

      <Note tone="neutral">
        <strong className="text-bone-200">Redacted by design:</strong> Alerts record strictly the caller role,
        normalized route, timestamp, and a coarse reason code. Attack prompts, defense rules, and sensitive tokens
        are never logged or exposed in the monitoring stream to eliminate side-channel leaks.
      </Note>

      <section>
        <SectionHead index="01" title="Alert counts by role" aside={
          <span className="label font-mono text-[12px] text-bone-400">
            {data?.counts.total ?? 0} total alert{(data?.counts.total ?? 0) === 1 ? "" : "s"} recorded
          </span>
        } />
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
          {roles.map((role, i) => {
            const count = data?.counts.by_role[role] ?? 0;
            return (
              <div key={role} className="border border-ink-800 bg-ink-950 p-4 transition-colors hover:border-ink-700" style={stagger(i)}>
                <span className="font-mono text-[11px] uppercase tracking-wider text-bone-500">{role}</span>
                <p className={`mt-2 font-mono text-[28px] font-semibold leading-none ${count > 0 ? (role === "red" || role === "blue" ? "text-amber-300" : "text-bone-100") : "text-bone-600"}`}>
                  {count}
                </p>
                <span className="mt-1 block font-mono text-[10px] text-bone-500">
                  {count === 1 ? "violation" : "violations"}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <SectionHead index="02" title="Live security alerts feed" />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn btn-secondary text-[12px]"
              onClick={fetchAlerts}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh feed"}
            </button>
            <button
              type="button"
              className="btn btn-primary text-[12px]"
              onClick={handleTriggerDemo}
              disabled={triggering}
            >
              {triggering ? "Triggering…" : "Trigger demo violation"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 border-l-2 border-rust-500 bg-rust-950/20 p-3 text-[13px] text-rust-300">
            {error}
          </div>
        )}

        {loading && !data && (
          <p className="py-8 font-mono text-[13px] text-bone-500">Loading monitoring stream…</p>
        )}

        {data && data.alerts.length === 0 && (
          <Empty>No security alerts recorded yet. All role requests are within assigned policies.</Empty>
        )}

        {data && data.alerts.length > 0 && (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ink-800 text-bone-500">
                  <th scope="col" className="pb-3 text-[11px] font-normal uppercase tracking-wider">Time</th>
                  <th scope="col" className="pb-3 text-[11px] font-normal uppercase tracking-wider">Role</th>
                  <th scope="col" className="pb-3 text-[11px] font-normal uppercase tracking-wider">Route</th>
                  <th scope="col" className="pb-3 text-[11px] font-normal uppercase tracking-wider">Reason code</th>
                  <th scope="col" className="pb-3 text-[11px] font-normal uppercase tracking-wider">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900">
                {data.alerts.map((alert: Alert, i: number) => (
                  <tr key={alert.id} className="reveal transition-colors hover:bg-ink-900/30" style={stagger(i)}>
                    <td className="py-3.5 pr-4 font-mono text-[11px] text-bone-400 whitespace-nowrap">
                      {time(alert.created_at)}
                    </td>
                    <td className="py-3.5 pr-4 whitespace-nowrap">
                      <span className={`inline-block border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider ${ROLE_COLOR[alert.role] ?? ROLE_COLOR.anonymous}`}>
                        {alert.role}
                      </span>
                    </td>
                    <td className="py-3.5 pr-4 font-mono text-[12px] text-bone-300 whitespace-nowrap">
                      {alert.route}
                    </td>
                    <td className="py-3.5 pr-4 font-mono text-[11px] font-semibold text-amber-300 whitespace-nowrap">
                      {alert.reason_code}
                    </td>
                    <td className="py-3.5 text-[12.5px] text-bone-400">
                      {alert.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
