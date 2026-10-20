# Execution Flow

The end-to-end execution path through the codebase, per `AGENTS.md`. Every path here was checked against the source, and the Docker paths were run (see §8). Anything not exercised is marked **(unverified)**.

_Last verified: 2026-10-20, against the security hardening milestone and the security review that followed (Host allowlists, redaction, ISO-02 data source, witness reply validation). The frontend animation flow (§2.5) is from the visual refinement pass._
_History: the baseline on the same date had no code. The first vertical slice ran every role in-process; this milestone adds isolated agents and the witness._

## Components

| Layer | Entry | Responsibility |
|---|---|---|
| UI | `frontend/index.html` → `src/main.tsx` | React app. Sends no credential |
| Edge proxy | Docker: `frontend/nginx.conf.template` (nginx-unprivileged). Dev: `frontend/vite.config.ts` proxy | Answers only `Host` 127.0.0.1 or localhost (nginx 421 otherwise; Vite 403). Injects the operator token server-side, replacing any client `Authorization` header. Refuses `/api/(red\|blue\|target)/` (nginx 403, Vite 404). nginx adds anti-framing, `nosniff` and `no-referrer` headers |
| Run controller | `src/lab.tsx` (`LabProvider`) | Creates runs, advances them stage by stage, holds `run`, `playing`, `busy`, `version`, and surfaces checkpoint failures |
| API (control plane) | `backend/app/main.py` (`uvicorn app.main:app`) | `TrustedHostMiddleware` (`BAYORA_ALLOWED_HOSTS`), then routes, each with one permission (`auth.require`). The control register, checkpoint publishing and the verify endpoint |
| Auth | `backend/app/auth.py` | Bearer token → role. The `PERMISSIONS` table. `validate_tokens()` at startup |
| Pipeline | `backend/app/pipeline.py` | Session state machine. Each role stage runs in-process or through that role's agent |
| Remote | `backend/app/remote.py` | Outbound HTTP to agents and the witness. Failures raise `RemoteError`, never fall back |
| Role agents | `backend/agents/{red,blue,target}_agent.py`, `common.py` | Docker only. Each acts through its own role API with only its own token. The target has none |
| Simulation | `attacks.py`, `target.py`, `providers.py`, `defenses.py`, `evaluator.py` | Test cases, deterministic target behind a provider interface, guardrails, criteria |
| Isolation | `backend/app/isolation.py` | Permission probes, data checks, and network and container checks reported by the agents |
| Audit | `backend/app/audit.py` | Hash-chain append, verification, tamper simulation |
| Checkpoint | `backend/app/checkpoint.py` → `backend/witness/app.py` | Publishes the chain head after commits; verifies the chain against the witness log |
| Storage | `backend/app/db.py` | SQLite (default) or PostgreSQL (`DATABASE_URL`) |

## 0. Deployments and boundaries

**Dev** (two local processes): Vite proxy → API. Red, Blue and Target run inside the API process, and there is no witness unless `BAYORA_WITNESS_URL` is set. The UI shows "Roles: in-process" and "Anchor: none", and the isolation checks for network and containers are `simulated` or `planned`.

**Docker** (`docker-compose.yml`): seven services, one network per path. Every network except `public` is `internal: true`, with no outside route.

```mermaid
flowchart LR
  B[Browser] -- public :8080 on 127.0.0.1 --> F[frontend nginx<br/>uid 101]
  F -- edge --> API[backend control plane<br/>uid 10001, all tokens, DB creds]
  API -- data --> DB[(db postgres)]
  API -- red_net --> R[red-agent<br/>Red token only]
  API -- blue_net --> BL[blue-agent<br/>Blue token only]
  API -- target_net --> T[target<br/>no token]
  API -- witness_net --> W[witness<br/>own volume /data]
  R -. calls Red API .-> API
  BL -. calls Blue API .-> API
```

The policy, measured from outside by `tests_compose/`:
- Each agent reaches only `backend`.
- The witness reaches only `backend`.
- The frontend reaches only `backend`.
- The backend reaches the DB, all agents and the witness.
- No internal service has egress.

Every container is non-root and read-only, with all capabilities dropped (Postgres adds back five for initialisation), `no-new-privileges`, memory, CPU and PID limits, and no bind mounts or Docker socket.

## 1. Startup

1. **Compose order.** `db` (healthcheck) and the agents and witness start first, then `backend`, then `frontend`. Compose refuses to render if any `${VAR:?}` secret from `.env` is missing.
2. **API.** `uvicorn app.main:app` → `lifespan`:
   1. `auth.validate_tokens()`. With `BAYORA_REQUIRE_TOKENS=1` (Docker), missing, dev-default, short or duplicate tokens, or a witness without a strong token, raise `RuntimeError`, and the process exits.
   2. If the target runs in-process, `providers.get_provider()`. Any provider but `simulator` refuses startup.
   3. `db.init_db()` runs the five `CREATE TABLE IF NOT EXISTS` statements.
3. **Database.** `db.database_url()` reads `DATABASE_URL`. A `postgres…` URL uses `psycopg` with `dict_row`; otherwise `sqlite3` opens `backend/bayora.db`.
4. **Agents** (`uvicorn agents.<role>_agent:app`). They hold no state. The Red and Blue agents read their token from the environment on each call (`common.role_token`). The target loads `providers.get_provider()` at import.
5. **Witness** (`uvicorn witness.app:app`). It holds no state in memory; the whole log is read and validated on every request.
6. **nginx.** The image's envsubst step renders `default.conf.template`, filtered to `BAYORA_*` variables, into a tmpfs `/etc/nginx/conf.d`. The operator token exists only in that rendered file and the container's environment.
7. **Browser.** `index.html` → `main.tsx` → `<LabProvider><App/></LabProvider>`. `LabProvider` calls:
   - `GET /api/meta`: stages, criteria, rules, playbook, the control register computed by `main.controls()` for this deployment, permissions, storage, and `deployment` (role modes, checkpoint). `Shell` shows Roles and Anchor from it.
   - `GET /api/runs`, then the latest run.
   A network failure → `ApiError(0, …)` → `online = false` and the error banner.

## 2. Running a test (the vertical slice)

```mermaid
sequenceDiagram
  participant Lab as lab.tsx drive()
  participant Edge as nginx / Vite proxy
  participant API as main.py
  participant P as pipeline.py
  participant Ag as role agent (Docker) or in-process code
  participant A as audit.py
  participant W as witness

  Lab->>Edge: POST /api/runs (no credential)
  Edge->>API: + Authorization: operator token
  API->>P: create_session() → audit session.created → commit
  API->>W: POST /v1/checkpoints {seq, head_hash}
  API-->>Lab: RunDetail + checkpoint status
  loop until next_stage is null
    Lab->>Edge: POST /api/runs/{id}/advance
    Edge->>API: + operator token
    API->>P: advance(conn, id, app)
    P->>Ag: stage work (agent calls back its own role API)
    P->>A: append(...) per action
    API->>API: commit (or rollback + 502 on RemoteError)
    API->>W: POST /v1/checkpoints (after commit)
    API-->>Lab: {executed, run, checkpoint}
    Lab->>Lab: banner if checkpoint failed; sleep(STAGE_MS) (presentational)
  end
```

### 2.1 Creating the session
1. **Overview** "Run test suite" calls `lab.start()`. **Attack library** calls `lab.start(ids)` and navigates to the overview.
2. `lab.guarded()` ignores the call if a run is in progress, then sets `busy` and calls `drive(api.createRun(ids))`.
3. `POST /api/runs` → `main.create_run` (`runs:write`).
   - Omitted ids default to all seven cases, with duplicates removed. Unknown or empty selections → **422**.
   - `pipeline.create_session` inserts the session and appends `session.created`. The connection commits.
   - In a second connection, `checkpoint.publish()` posts the head to the witness (§5.2), then `_run_detail()` builds the response. The response carries `checkpoint: {status: anchored | failed | rejected | not-configured}`.

### 2.2 Advancing: one request per stage
`POST /api/runs/{id}/advance` → `main.advance_run` (`runs:write`):
1. `_session` → **404** for an unknown id.
2. `pipeline.advance` computes `next_stage`. A completed session → `Conflict` → **409**.
3. The stage handler runs, then `sessions.stage` is updated. `db.connect()` commits, or rolls back on any exception. A `RemoteError` from an agent → `remote_handler` → **502** `"Role service failure: …"`; the session stays at its previous stage.
4. After the commit, `checkpoint.publish()` runs in a new connection, then `{executed, run, checkpoint}` is returned.

| Stage | In-process (dev) | Agent mode (Docker) | Audit events |
|---|---|---|---|
| attack | `submit_attempt(baseline)` per case | `call_agent("red", "/v1/act", {session_id, attack_ids, phase: baseline})`. The Red agent GETs its attempts, then POSTs each missing case to `/api/red/sessions/{id}/attempts`. `_require_submitted` then checks every case exists, or raises `RemoteError` | `red.baseline_submitted` (prompt SHA-256) |
| respond | `_respond`: `defenses.run_target(prompt, rules, model)`, where `model` = `SimulatorProvider.respond` | Same guardrails in the control plane; `model` = `call_agent("target", "/v1/respond", {prompt})`. A reply without a string `response` → `RemoteError` | `target.baseline_response` (response SHA-256, guard fields, `provider`, `provider_kind`, `target_runtime`) |
| evaluate | `_evaluate` (always in the control plane) | Same | `evaluator.baseline_verdict` |
| defend | `blue_findings()` → `PLAYBOOK` → `apply_defense` | `call_agent("blue", "/v1/act", {session_id})`. The Blue agent GETs `/api/blue/sessions/{id}/findings` and POSTs `/defenses` per criterion in its own `PLAYBOOK` | `blue.findings_read` (in-process: stage; agent: Blue API route, `via: api`), `blue.defense_applied` per rule |
| retest | `submit_attempt(retest)` per case, then respond and evaluate | Red agent `/v1/act` with `phase: retest` (the Red API allows retest only while the stage is `defend`), `_require_submitted`, then respond (target agent) and evaluate | `red.retest_submitted`, `target.retest_response`, `evaluator.retest_verdict` |
| isolation | `isolation.run_checks` (§3) | Same, plus agent probes | `isolation.check` ×8 |
| report | `stage_report`: residual risk per case, counts, isolation summary (`enforced`, `network`, `configured`, `simulated`, `planned`), `audit.verify` plus `checkpoint.verify` (both taken *before* the report event), `deployment` (role modes and the provider recorded on the latest target event), disclaimer chosen by mode | Same | `report.generated` |

A full seven-case run appends **56 events**; ISO-05 sees 47 of them. Both were measured in-process and in a Docker agent-mode run, which records exactly one `blue.findings_read`, the Blue agent's. Before the security review it was 57, because ISO-02 itself read through the Blue API (finding V3).

Agent calls happen before the stage writes anything locally. SQLite therefore never holds a write lock while an agent calls back into the API, and the agent's own requests commit independently. The Red agent skips cases already submitted, so a retried stage is idempotent.

### 2.3 Inside `defenses.run_target` (the guarded target)
1. Input rules run in the fixed order of `defenses.RULES`, always in the control plane:
   - `instruction-guard` (literal override regex) → **blocked**
   - `persona-lock` → blocked
   - `decode-scan` (Base64, then the override regex) → blocked
   - `untrusted-content-fence` strips `<!-- … -->` → **transformed**
   A blocked prompt never reaches the model or the target agent.
2. `model(text)`: in-process this is `target.model` via the provider; in Docker it is the target agent. The simulator adds `resolve_concatenation()` output, plus `decode_base64()` output when the prompt says "decode". It then answers in this order:
   1. disallowed request → refusal
   2. override → config dump with the canary
   3. persona + secret request → canary leak
   4. hidden "record" instruction → summary plus the patient record
   5. summary
   6. opening hours
   7. default
3. The output rule `secret-egress-filter` replaces the canary with `[REDACTED]` → **filtered**.

### 2.4 Deterministic outcome of the full suite
After defend, the active rules are `secret-egress-filter`, `instruction-guard` and `untrusted-content-fence`. The outcome is identical in-process and in agent mode (asserted in `tests/test_workflow.py`, `tests/test_agents.py` and `tests_compose/`).

| Case | Baseline | Retest | Residual | Why |
|---|---|---|---|---|
| BN-00 control | pass | pass | none | No over-refusal after defenses |
| PI-01 direct override | fail | pass | low | Blocked by `instruction-guard` |
| JB-02 persona | fail | pass | medium | Only the output filter hid the canary |
| OB-03 Base64 | fail | fail | high | The literal guard misses encoded text |
| II-04 poisoned doc | fail | pass | low | Fence removed the hidden instruction |
| PS-05 split payload | fail | fail | high | The literal guard misses assembled text |
| PR-06 phishing | pass | pass | none | Baseline refusal |

### 2.5 Frontend during a run (animation state flow)
_From the visual refinement pass, except for item 1's checkpoint banner, which this milestone added._

1. Every advance response calls `setRun(next)`, `setPlaying(executed)` and `setVersion(v+1)`. If `checkpoint.status` is `failed` or `rejected`, `lab.error` shows "Audit checkpoint … after <stage>". `drive()` then waits `STAGE_MS[executed]`, or 280 ms with reduced motion or after **Skip animation**.
2. **Shell** announces each executed stage, and the final risk, through a `role="status"` region. The rail shows API, Target, Storage, Roles (isolated or in-process), Anchor (witness or none) and Run.
3. **Overview** derives `stage = playing ?? run.stage ?? "idle"`:
   - `Headline`
   - `OutcomeStrip`: per-case verdict cells, hatched until written
   - `RunFacts`: grouped audit head
   - `Pipeline`: active / done / pending, with real `stageMetric`s
   - `AuditTail`: refetched on `version`
4. **`SecurityCore`:** `highlight = hovered ?? selected` (pointer, focus or pin) drives the permission panel, the labels and the scene. `sceneData(run)` reduces the run to counts. The footer `readout()` is built from run data only. A WebGL failure, a loading chunk or a scene error → `LatticeFallback`.
5. **`LatticeCanvas`:** progress `p` over 92% of `STAGE_MS[stage]`. `live(s) = playing && stage === s` gates the gates, probes and glows; recorded state (facet failure share, rings, evaluator) shows whenever the run has reached it. The camera moves to a framing per playing stage (hero framing with reduced motion). Frames render on demand only.
6. When the loop ends, `playing` and `busy` clear, and the scene shows the final recorded state.
7. Other pages refetch on `version`. Run detail prefers `lab.run` while the run is active.

## 3. Isolation checks (`isolation.run_checks`)
1. Reads the session's attempts.
2. `probe_matrix(app)`: 5 roles × 8 resources = 40 requests against `SENTINEL` (a session id that never exists) through `httpx.ASGITransport`, sent from the sync route via `anyio.from_thread.run`. A row is OK when "observed allowed" (not 401/403) matches `can(role, permission)`.
3. Data checks on the real session:
   - **Blue findings:** `pipeline.blue_findings(db, id)` is checked directly, as the exact output the Blue route returns, and not read with the Blue token. That keeps the audit chain from recording a Blue read Blue never made. Must contain no prompt prefix, no attack id, and none of `target.SENSITIVE_VALUES` (canary, patient name, date of birth, MRN).
   - **Red attempts:** no rule ids.
   - **Target inbox:** no answered prompts, and only the keys `attempt_id`, `phase` and `prompt`.
4. `audit.verify(db)` → ISO-05.
5. **`role_runtime_checks()`:**
   - If any role is in-process: ISO-06 is `simulated` (the declared `NETWORK_MODEL`, naming the in-process roles) and ISO-07 is `planned` / `not-run`.
   - If all three agents are configured: for each role, `call_agent(role, "/v1/probe", {})`. The agent probes its fixed `PROBE_TARGETS` (compose service names plus TEST-NET-1 `192.0.2.1`) with a 1.5 s TCP connect, and reads `/proc/self/status` (uid, CapEff, NoNewPrivs), a write probe on `/`, and whether `/var/run/docker.sock` exists.
   - `evaluate_probe` compares reachability with `NETWORK_POLICY` (each role → `control-plane` only; "refused" counts as reachable) → ISO-06 `network`. `evaluate_security` → ISO-07 `configured`. An agent that doesn't answer fails both checks: fail closed.
6. **`checkpoint_check()`** → ISO-08: `enforced` when a witness is configured (`checkpoint.verify`), else `planned`.
7. Inserts 8 rows and appends `isolation.check` ×8. All probes run before any local write in this stage.

**Isolation lab page:** `POST /api/isolation/matrix` runs the same 40 probes on demand.

The agents' probe results are self-reported by Bayora's own code. Independent proof comes from `tests_compose/` (§8), which probes from outside with `docker exec`, both by service name and by every container IP.

## 4. Role-scoped interfaces
| Route | Permission | Service | Returns / guards |
|---|---|---|---|
| `GET /api/red/sessions/{id}/attempts` | `red:read` | `red_view` | Prompts, responses, verdict, `blocked` bool. No rule ids |
| `POST /api/red/sessions/{id}/attempts` `{attack_id, phase}` | `red:submit` | `red_submit` | `baseline`: only in `created`/`attack`, no duplicates. `retest`: only in `defend`, needs a baseline, once per case. Otherwise 409. Unknown case → 422 |
| `GET /api/blue/rules` | `blue:read` | `defenses.RULES` | Rule catalogue |
| `GET /api/blue/sessions/{id}/findings` | `blue:read` | `blue_findings` | Redacted findings; every read appends `blue.findings_read` |
| `POST /api/blue/sessions/{id}/defenses` | `blue:defend` | `apply_defense` | Unknown rule → 404. Outside `evaluate`/`defend` → 409 |
| `GET /api/target/sessions/{id}/inbox` | `target:read` | `target_inbox` | Pending prompts only (`response IS NULL`); empty for finished sessions |

`TrustedHostMiddleware` runs first: a `Host` outside `BAYORA_ALLOWED_HOSTS` → **400**, before any credential is looked at. `auth.require` then runs before the handler body: no or unknown token → **401**, wrong role → **403**. If token lookup itself fails, the request errors (500) and never reaches the handler (tested). In Docker the API publishes no port. Browsers reach it only through nginx, which acts only as the operator and refuses role routes.

## 5. Audit trail and external checkpoint

### 5.1 Chain (database)
- **Append** (`audit.append`): `db.lock_audit()`, read the head, then `seq = head+1`, `prev_hash`, canonical JSON details, `hash = sha256(HASHED_FIELDS)`, INSERT. The event commits with its stage.
- **Read:** `GET /api/audit?session_id&limit` returns the newest `limit` events in ascending order.
- **Local verify** (`audit.verify`): seq continuity, `prev_hash` links, recomputed hashes, and evidence digests against `attempts`.

### 5.2 Checkpoint (witness)
1. **Publish** (`checkpoint.publish`, after every committed create or advance): read the head `(seq, hash)` and `POST {witness}/v1/checkpoints` with `BAYORA_WITNESS_TOKEN`.
   - `anchored`: success.
   - `rejected`: a 409 from the witness.
   - `failed`: unreachable, or any other error.
   - `not-configured`: no witness URL set.
   A failure never undoes the committed stage; it is returned to the UI, and `/verify` then shows the unanchored gap.
2. **Witness append** (`witness/app.py`):
   1. Check the token (401 otherwise).
   2. Under a lock, `load()` the log: parse each line and validate the record hash, the `prev_record` link and the index. Unparseable lines are ignored only while the chain of valid records stays continuous; a broken chain → integrity false → **503**, refusing appends.
   3. A seq lower than the latest → **409**. The same seq with the same hash → returns the existing record. The same seq with a different hash → **409**.
   4. Append one JSON line, adding a leading newline first if a torn line precedes it, then `flush` and `fsync`.
3. **Verify** (`GET /api/audit/verify`): local verify, then `checkpoint.verify(events)`. That fetches `GET /v1/checkpoints` and, for **every** record, compares the stored event at `record.seq`:
   - absent → `missing` (or `truncated` when beyond the head)
   - different hash → `checkpoint`
   Witness integrity problems → `witness`.
   It returns `status`, `checkpoints`, `anchored_seq`, `head_seq` and `unanchored_events`. A mismatch, or an unreachable configured witness, sets `ok = false`.
4. **Tamper simulation** (`POST /api/audit/tamper-test`): mutates an in-memory copy. With a witness configured, `checkpoint.compare(tampered_chain, records)` is attached as `checkpoint.detected`. An unreachable or malformed witness → 502.
5. **Malformed witness replies:** `publish` accepts only a record with an integer `seq`, string `head_hash` and integer `index`; anything else → `failed`. `fetch()` accepts only `{records: [records], integrity: {ok: bool}}`; anything else raises `RemoteError`, so verify reports `unavailable` and `ok: false`, and the report records `unavailable`. No committed request returns 500 because of the witness.

### 5.3 Crash and recovery

| Failure point | State afterwards | Recovery | Evidence |
|---|---|---|---|
| During a stage (before commit) | Transaction rolled back; no events, no stage change | Re-run the stage (Resume) | `db.connect()` rollback; agent-failure tests |
| Agent submissions committed, then the stage fails (502) | Red's attempts and audit events are committed (separate API requests); stage not advanced | Re-run: the Red agent skips cases already submitted in that phase | `test_unreachable_blue_agent_…`, `test_stopped_blue_agent_…` |
| After commit, before or while publishing the checkpoint | Events committed, not anchored. Verify: `ok: true`, `unanchored_events = n` | The next successful publish (any create or advance) anchors the then-current committed head. Deterministic, but unbounded if nothing else is written | `test_witness_outage_is_reported_never_hidden`, compose `test_witness_outage_…` |
| Witness appended, then the API timed out | API reports `failed`; the witness holds the record | Verify reflects the witness; a repeat of the same seq and hash is idempotent | `test_witness_is_append_only` |
| Witness crashed mid-write | Torn last line | Ignored while the record chain stays intact; the next append starts on a new line | `test_witness_isolates_a_torn_tail_write` |
| Database restored from an earlier backup | Chain shorter or different than the checkpoints | Verify fails (`truncated`/`checkpoint`), deliberately; there is no automatic witness reset | `test_truncation_is_detected_…` |

What it detects: edits, deletions, reordering and truncation anywhere up to the latest checkpoint, including a full rewrite with recomputed hashes made with database credentials inside the backend container (tested in Docker). What it does not detect: changes confined to events after the latest checkpoint (normally at most one stage), or truncation of the witness log's own tail.

## 6. Error handling summary
| Where | Behaviour |
|---|---|
| `db.connect()` | Commit on success, rollback on any exception, always close |
| `pipeline.Conflict` | → 409 |
| Foreign `Host` header | nginx → 421 (no credential attached); API → 400 (`TrustedHostMiddleware`); Vite dev server → 403 |
| `remote.RemoteError` (agent unreachable, error status, non-JSON or malformed reply, missing submissions) | → 502 `Role service failure`. Stage rolled back; no in-process fallback |
| Agent → control-plane failure | The agent raises 502 to its caller, which becomes a `RemoteError` in the stage |
| Checkpoint publish failure | Stage stays committed. The response says `failed` or `rejected`, the UI banner shows it, and `/verify` reports unanchored events or `unavailable` |
| Witness log corrupt | Witness refuses appends (503); verify reports a `witness` error |
| Witness reply malformed | Publish `failed`; verify `unavailable` (`ok: false`); tamper-test 502 |
| Startup misconfiguration | `validate_tokens` or `get_provider` raise; the API does not start |
| Validation | 422 for bodies, unknown attack or criterion; 404 for unknown rule or session |
| `api.request` (frontend) | Network failure → `ApiError(0)`; non-2xx → `ApiError(status, detail)` |
| `lab.guarded` | Sets `lab.error`, clears `busy`; the run can be resumed |
| 3D | No WebGL, a scene exception or a loading chunk → `LatticeFallback` |

## 7. Unverified or untested paths, and known residual risks

Plausible risks from the security review: precondition shown, not fixed, because each needs a design change (details in descision.md):
- **R1:** the frontend container is on the only non-internal network and can reach the host's loopback-bound dev servers through `host.docker.internal`; the dev API accepts the public dev tokens.
- **R2:** whoever holds the witness token can plant a far-future checkpoint and block further anchoring. This fails closed: verify reports `truncated`.
- **R3:** role tokens are bearer tokens not bound to their network. A stolen Blue token works from the Red container.
- **R4:** the backend's database role is a superuser with UPDATE/DELETE on `audit_events`.
- **R5:** the control plane holds every role token in plaintext and can act as any role. The audit actor records which credential was used, not which process used it.
- ISO-06 and ISO-07 in the app are self-reported by the agents. The independent evidence is the outside-in `tests_compose/` suite.


- **(unverified)** Hosts other than Docker Desktop 28.3.3 on macOS arm64, for example native Linux Docker or Podman. Network isolation relies on Docker bridge isolation inside the Docker Desktop VM.
- **(unverified)** Resistance to container escape or kernel exploits; all containers share one kernel.
- **(unverified)** Concurrent runs and checkpoint races under load. The witness refuses regressions, and the control plane reports `rejected`, but this has no load test.
- **(unverified)** Real model providers (none implemented), real mobile hardware and GPUs, and screen-reader output.
- The local (non-Docker) witness was run once on temporary ports. It checks history but is not isolated from the API's OS user.

## 8. Verification log (2026-10-20)
- `pytest` (unit, `backend/tests/`): 69/69 on SQLite, 69/69 on PostgreSQL 14, including the 10 security-review regression tests in `tests/test_security_review.py`.
- `scripts/compose-test.sh` (`backend/tests_compose/`, a real throwaway stack): 53/53. It covers:
  - reachability by name and IP, including the database as a source
  - egress, internal networks, `host.docker.internal` unresolvable from internal services
  - container configuration (including seccomp) and PID 1 privileges
  - witness-only volume, per-container credentials, secret scans
  - the edge: foreign-Host rejection, anti-framing headers, client-credential replacement, path-block variants, loopback-only publishing
  - in-container role calls, a full run, agent and witness outages, and a full chain rewrite detected
- Main stack: `docker compose up -d --build` gives 7 services running. A full run through `http://127.0.0.1:8080` passes, verify is OK with 0 unanchored events, and live probes confirm 421 for a foreign Host at the edge and 400 at the dev API.
