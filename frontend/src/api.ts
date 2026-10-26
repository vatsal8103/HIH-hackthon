// Typed client for the operator interface of the Bayora API.
// The browser holds no credential: the proxy in front of the API (nginx in Docker, the
// Vite dev server locally) injects the operator token. The backend enforces every permission.

export type Stage = "attack" | "respond" | "evaluate" | "defend" | "retest" | "isolation" | "report";
export type Risk = "none" | "low" | "medium" | "high" | "critical";
export type Verdict = "pass" | "fail";

export const STAGES: Stage[] = ["attack", "respond", "evaluate", "defend", "retest", "isolation", "report"];

export interface Attack {
  id: string;
  title: string;
  technique: string;
  objective: string;
  prompt: string;
  criteria: string[];
  recommendation: string;
  category?: string;
  source?: string;
  source_url?: string;
  license?: string;
}

export interface CriterionResult {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface Attempt {
  id: string;
  attack_id: string;
  phase: "baseline" | "retest";
  prompt: string;
  response: string | null;
  blocked_by: string | null;
  filtered_by: string | null;
  transformed_by: string | null;
  verdict: Verdict | null;
  criteria: CriterionResult[] | null;
  created_at: string;
}

export interface CaseResult {
  attack_id: string;
  title: string;
  technique: string;
  baseline_verdict: Verdict;
  retest_verdict: Verdict;
  residual_risk: Risk;
  rationale: string;
  recommendation: string | null;
}

export interface RunCase {
  attack: Attack;
  baseline: Attempt | null;
  retest: Attempt | null;
  residual: CaseResult | null;
}

export interface Defense {
  rule_id: string;
  criterion: string;
  created_at: string;
  title: string;
  stage: "input" | "output";
  description: string;
}

export interface IsolationCheck {
  check_id: string;
  title: string;
  // enforced = application layer; network = probed inside role containers; configured = container
  // controls observed inside them; simulated = declared model only; planned = not active here.
  kind: "enforced" | "network" | "configured" | "simulated" | "planned";
  status: "pass" | "fail" | "not-run";
  detail: string;
}

export interface Report {
  generated_at: string;
  overall_risk: Risk;
  counts: { cases: number; baseline_failures: number; mitigated: number; residual_failures: number };
  cases: CaseResult[];
  defenses: string[];
  isolation: {
    enforced_pass: number;
    enforced_fail: number;
    network_pass?: number;
    network_fail?: number;
    configured_pass?: number;
    configured_fail?: number;
    simulated: number;
    planned: number;
  };
  audit: { ok: boolean; checked: number; head_hash: string; checkpoint?: CheckpointStatus; anchored_seq?: number | null };
  deployment?: { roles: Record<string, RoleMode>; target_provider: string | null; target_kind: string | null };
  disclaimer: string;
}

/** What answered as the target in a run, as recorded. Both null before the target has answered. */
export interface RunTarget {
  provider: string | null;
  kind: "simulated" | "live" | (string & {}) | null;
}

/** "incomplete": the run stopped before its report; stages run only while a request drives them. */
export type RunStatus = "incomplete" | "completed";

export interface RunDetail {
  id: string;
  created_at: string;
  stage: Stage | "created";
  next_stage: Stage | null;
  status: RunStatus;
  target?: RunTarget;
  cases: RunCase[];
  defenses: Defense[];
  isolation: IsolationCheck[];
  report: Report | null;
}

export interface RunSummary {
  id: string;
  created_at: string;
  stage: Stage | "created";
  status: RunStatus;
  target?: RunTarget;
  attack_ids: string[];
  overall_risk: Risk | null;
  counts: Report["counts"] | null;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  session_id: string | null;
  actor: string;
  event_type: string;
  evidence_ref: string | null;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export type RoleMode = "agent" | "in-process";
export type CheckpointStatus = "ok" | "mismatch" | "unavailable" | "not-configured";

export interface ChainError {
  seq: number | null;
  kind:
    | "sequence"
    | "link"
    | "hash"
    | "evidence"
    | "credential"
    | "checkpoint"
    | "truncated"
    | "missing"
    | "superseded"
    | "witness";
  message: string;
}

export interface CheckpointVerification {
  status: CheckpointStatus;
  checkpoints?: number;
  anchored_seq?: number;
  head_seq?: number;
  unanchored_events?: number;
  /** Checkpoints an operator took out of force during witness recovery; never deleted. */
  superseded?: { index: number; seq: number; reason: string }[];
  errors: ChainError[];
}

/** Result of anchoring the chain head after a committed stage. */
export interface CheckpointPublish {
  status: "anchored" | "failed" | "rejected" | "not-configured" | "empty";
  seq?: number;
  error?: string;
}

export interface Alert {
  id: string;
  created_at: string;
  role: string;
  route: string;
  reason_code: string;
  description: string;
}

export interface AlertsResponse {
  alerts: Alert[];
  counts: {
    total: number;
    by_role: Record<string, number>;
    by_reason: Record<string, number>;
  };
  reason_codes: Record<string, string>;
}

export interface Verification {
  ok: boolean;
  checked: number;
  head_hash: string;
  errors: ChainError[];
  checkpoint?: CheckpointVerification;
}

export type TamperMode = "modify" | "delete" | "reorder" | "rewrite";

export interface TamperResult {
  mode: TamperMode;
  seq: number;
  summary: string;
  original_head: string;
  tampered_head: string;
  verification: Verification;
  checkpoint?: { detected: boolean; errors: ChainError[] };
}

export interface ProbeRow {
  role: string;
  resource: string;
  method: string;
  path: string;
  permission: string;
  expected: "allow" | "deny";
  status: number;
  ok: boolean;
  /** Which credential the probe used: the agent's own signed one, one the control plane holds, or none. */
  credential?: "agent-signed" | "held" | "none";
}

export interface Meta {
  stages: Stage[];
  criteria: Record<string, { title: string; severity: Risk; description: string }>;
  rules: Record<string, { title: string; stage: "input" | "output"; description: string }>;
  playbook: Record<string, string>;
  controls: { name: string; status: "implemented" | "simulated" | "planned" | "unknown"; detail: string }[];
  permissions: Record<string, string[]>;
  deployment: { roles: Record<string, RoleMode>; checkpoint: "witness" | "not-configured" };
  /** What answers as the target, as reported by the process that runs it. */
  target: TargetInfo;
  storage: string;
}

export interface TargetInfo {
  provider: string | null;
  kind: "simulated" | "live" | "unknown" | (string & {});
  source: string;
  /** Whether the provider can answer now (a live model: its service reachable and the model available). */
  ready?: boolean | null;
  detail?: string | null;
}

export class ApiError extends Error {
  status: number; // a plain field (not a parameter property) so `node --test` can strip the types

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "Cannot reach the Bayora API. Check that the backend (or the Docker stack) is running.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // A proxy answering for an API that is down has no JSON detail; the backend's own errors always do.
    const detail =
      typeof body.detail === "string"
        ? body.detail
        : response.status >= 502 && response.status <= 504
          ? `The Bayora API is not answering (${response.status}). Is the backend running?`
          : response.statusText;
    throw new ApiError(response.status, detail);
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// Minimal shape checks: a 200 with an unexpected body is an error, never an empty success.
type Check = (value: unknown) => boolean;
const isList: Check = Array.isArray;
const isRecord = (...keys: string[]): Check => (value) =>
  typeof value === "object" && value !== null && keys.every((key) => key in value);
const isRun = isRecord("id", "stage", "cases", "defenses", "isolation");

async function checked<T>(response: Promise<unknown>, valid: Check, what: string): Promise<T> {
  const value = await response;
  if (!valid(value)) throw new ApiError(502, `The API returned an unexpected ${what}.`);
  return value as T;
}

export interface ThreatItem {
  threat: string;
  protected: boolean;
  status: "Implemented" | "Partial" | "Simulated / Disclaimed" | "Planned" | string;
  how: string;
  failure_mode: string;
  test: string;
  future: string;
}

export interface ThreatModelResponse {
  markdown: string;
  threats: ThreatItem[];
}

export const api = {
  meta: () => checked<Meta>(request("/api/meta"), isRecord("stages", "criteria", "rules", "controls", "deployment"), "metadata response"),
  attacks: () => checked<Attack[]>(request("/api/attacks"), isList, "attack list"),
  threatModel: () =>
    checked<ThreatModelResponse>(request("/api/threat-model"), isRecord("markdown", "threats"), "threat model response"),
  runs: () => checked<RunSummary[]>(request("/api/runs"), isList, "run list"),
  run: (id: string) => checked<RunDetail>(request(`/api/runs/${encodeURIComponent(id)}`), isRun, "run"),
  createRun: (attackIds?: string[]) =>
    checked<RunDetail & { checkpoint?: CheckpointPublish }>(
      post("/api/runs", attackIds ? { attack_ids: attackIds } : {}),
      isRun,
      "new run",
    ),
  // `stage` is the step the caller means to run: a repeated request is refused (409) instead of running the next one.
  advance: (id: string, stage: Stage) =>
    checked<{ executed: Stage; run: RunDetail; checkpoint?: CheckpointPublish }>(
      post(`/api/runs/${encodeURIComponent(id)}/advance`, { stage }),
      (value) => isRecord("executed", "run")(value) && isRun((value as { run: unknown }).run),
      "stage result",
    ),
  audit: (limit = 200, sessionId?: string) =>
    checked<AuditEvent[]>(
      request(`/api/audit?limit=${limit}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`),
      isList,
      "audit list",
    ),
  verify: () =>
    checked<Verification>(
      request("/api/audit/verify"),
      (value) => isRecord("ok", "checked", "errors")(value) && typeof (value as { ok: unknown }).ok === "boolean",
      "verification result",
    ),
  tamper: (mode: TamperMode, seq?: number) =>
    checked<TamperResult>(post("/api/audit/tamper-test", { mode, seq }), isRecord("verification", "summary"), "simulation result"),
  probeMatrix: () => checked<ProbeRow[]>(post("/api/isolation/matrix"), isList, "probe matrix"),
  alerts: (limit = 100) =>
    checked<AlertsResponse>(request(`/api/alerts?limit=${limit}`), isRecord("alerts", "counts"), "alerts response"),
  triggerDemoAlert: () =>
    checked<Alert>(post("/api/alerts/demo"), isRecord("id", "role", "route", "reason_code"), "demo alert result"),
};
