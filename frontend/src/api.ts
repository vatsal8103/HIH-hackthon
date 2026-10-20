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

export interface RunDetail {
  id: string;
  created_at: string;
  stage: Stage | "created";
  next_stage: Stage | null;
  status: "running" | "completed";
  cases: RunCase[];
  defenses: Defense[];
  isolation: IsolationCheck[];
  report: Report | null;
}

export interface RunSummary {
  id: string;
  created_at: string;
  stage: Stage | "created";
  status: "running" | "completed";
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
}

export interface Meta {
  stages: Stage[];
  criteria: Record<string, { title: string; severity: Risk; description: string }>;
  rules: Record<string, { title: string; stage: "input" | "output"; description: string }>;
  playbook: Record<string, string>;
  controls: { name: string; status: "implemented" | "simulated" | "planned"; detail: string }[];
  permissions: Record<string, string[]>;
  deployment: { roles: Record<string, RoleMode>; checkpoint: "witness" | "not-configured" };
  storage: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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
    throw new ApiError(0, "Cannot reach the Bayora API. Is the backend running on port 8000?");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = typeof body.detail === "string" ? body.detail : response.statusText;
    throw new ApiError(response.status, detail);
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  meta: () => request<Meta>("/api/meta"),
  attacks: () => request<Attack[]>("/api/attacks"),
  runs: () => request<RunSummary[]>("/api/runs"),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  createRun: (attackIds?: string[]) =>
    post<RunDetail & { checkpoint?: CheckpointPublish }>("/api/runs", attackIds ? { attack_ids: attackIds } : {}),
  advance: (id: string) =>
    post<{ executed: Stage; run: RunDetail; checkpoint?: CheckpointPublish }>(`/api/runs/${id}/advance`),
  audit: (limit = 200, sessionId?: string) =>
    request<AuditEvent[]>(`/api/audit?limit=${limit}${sessionId ? `&session_id=${sessionId}` : ""}`),
  verify: () => request<Verification>("/api/audit/verify"),
  tamper: (mode: TamperMode, seq?: number) => post<TamperResult>("/api/audit/tamper-test", { mode, seq }),
  probeMatrix: () => post<ProbeRow[]>("/api/isolation/matrix"),
};
