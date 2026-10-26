"""Bayora API. Every route declares the single permission it needs (see auth.PERMISSIONS)."""

import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import (
    audit,
    checkpoint,
    credentials,
    db,
    defenses,
    evaluator,
    fairness,
    isolation,
    monitor,
    pipeline,
    providers,
    remote,
)
from app.attacks import ALL_ATTACKS, BY_ID, DEFAULT_ATTACK_IDS
from app.auth import PERMISSIONS, Principal, require, validate_tokens


def deployment() -> dict:
    from app import sandbox

    agents = {role: "agent" if remote.agent_url(role) else "in-process" for role in remote.AGENT_ENV}
    mode = os.environ.get("BAYORA_MODE")
    if not mode:
        if Path("/.dockerenv").exists():
            mode = "docker"
        elif any(remote.agent_url(role) for role in remote.AGENT_ENV):
            mode = "local-process"
        else:
            mode = "in-process"
    os_caps = sandbox.detect_os_capabilities()
    return {
        "mode": mode,
        "roles": agents,
        "checkpoint": "witness" if checkpoint.configured() else "not-configured",
        "credentials": "signed" if credentials.signed_roles() else "static",
        "os_isolation": {
            "platform": os_caps["platform"],
            "sandbox": os_caps["sandbox_tool"],
            "strength": os_caps["strength"],
            "summary": os_caps["summary"],
            "details": os_caps["details"],
        },
    }


def target_info() -> dict:
    """What answers as the target here, as the process that runs it reports. Asked, never assumed."""
    url = remote.agent_url("target")
    if url is None:
        provider = providers.get_provider()
        return {"provider": provider.id, "kind": provider.kind, "source": "in-process", **provider.status()}
    try:
        health = remote.call(url, "GET", "/healthz", timeout=4.0)
    except remote.RemoteError:
        return {
            "provider": None,
            "kind": "unknown",
            "source": "target agent unreachable",
            "ready": False,
            "detail": None,
        }
    health = health if isinstance(health, dict) else {}
    kind, provider, ready, detail = (health.get(k) for k in ("kind", "provider", "ready", "detail"))
    return {
        "provider": provider if isinstance(provider, str) else None,
        "kind": kind if isinstance(kind, str) else "unknown",
        "source": "target agent",
        "ready": ready if isinstance(ready, bool) else None,
        "detail": detail if isinstance(detail, str) else None,
    }


def _target_control(target: dict) -> dict:
    """The register entry for the target, from what the target reports (same source as the UI notice)."""
    entry = {"name": "Target model"}
    if target["kind"] == "simulated":
        detail = f"{target['provider']}: deterministic rules, not an LLM. Real providers are planned behind the same interface."
        return {**entry, "status": "simulated", "detail": detail}
    if target["kind"] == "unknown":
        detail = f"Unknown: {target['source']}, so what answers as the target cannot be stated."
        return {**entry, "status": "unknown", "detail": detail}
    detail = (
        f"{target['provider'] or target['kind']}, a real language model, as reported by the {target['source']}. "
        "Answers can vary between runs; the scripted checks are pattern-matching heuristics, not a full audit."
    )
    if (target.get("provider") or "").startswith("groq/"):
        detail += " Hosted by Groq, a third party: prompts and the synthetic scenario are sent there."
    if target.get("ready") is False:
        detail += f" Not ready: {target.get('detail') or 'the model did not answer'}"
    return {**entry, "status": "implemented", "detail": detail}


def controls(target: dict | None = None) -> list[dict]:
    """The control register, computed from what this deployment actually runs."""
    target = target or target_info()
    roles = deployment()["roles"]
    in_process = sorted(role for role, mode in roles.items() if mode == "in-process")
    signed = sorted(credentials.signed_roles())
    with db.connect() as conn:
        privileges = db.runtime_privileges(conn)
    least_privilege = bool(privileges) and not (
        privileges["superuser"]
        or privileges["can_update"]
        or privileges["can_delete"]
        or privileges["can_truncate"]
    )
    isolated = not in_process
    anchored = checkpoint.configured()
    return [
        {
            "name": "Role-scoped API permissions",
            "status": "implemented",
            "detail": "Every route checks the caller's credential against one permission table.",
        },
        {
            "name": "Signed, short-lived role credentials",
            "status": "implemented" if signed else "planned",
            "detail": f"{' and '.join(signed).capitalize()} sign each request with their own key (60 s, one-time, "
            "session-bound, inside a 120 s control-plane grant). The control plane holds only their public keys."
            if signed
            else "Not active here: dev mode uses static role tokens held by this process.",
        },
        {
            "name": "Database least privilege",
            "status": "implemented" if least_privilege else "planned",
            "detail": f"Runtime role {privileges['role']} is not a superuser and holds no update, delete or "
            f"truncate privilege on audit events; append-only trigger "
            f"{'active' if privileges['append_only_trigger'] else 'missing'}. Tested by test_migrate.py and tests_compose."
            if least_privilege
            else "Not active here: the runtime database user can modify audit rows (SQLite, or a privileged role).",
        },
        {
            "name": "Blue Team redaction",
            "status": "implemented",
            "detail": "Blue Team receives criteria, severity and masked excerpts, never attack prompts.",
        },
        {
            "name": "Hash-linked audit log",
            "status": "implemented",
            "detail": "Detects edited, deleted and reordered events, and evidence that no longer matches its digest.",
        },
        {
            "name": "External audit checkpoint",
            "status": "implemented" if anchored else "planned",
            "detail": "A separate witness service keeps an append-only checkpoint log; verification compares every "
            "checkpoint."
            if anchored
            else "Witness service exists but is not configured here, so a full chain rewrite would go undetected.",
        },
        {
            "name": "Per-role container isolation",
            "status": "implemented" if isolated else "planned",
            "detail": (
                "Red, Blue and Target run as separate non-root, read-only agent containers holding only their own credential."
                if isolated and deployment().get("mode") == "docker"
                else (
                    f"Red, Blue and Target run as separate OS processes on 127.0.0.1 with {deployment().get('os_isolation', {}).get('summary', 'process isolation')} and isolated per-role credentials."
                    if isolated and deployment().get("mode") == "local-process"
                    else (
                        "Red, Blue and Target run as separate isolated agents."
                        if isolated
                        else f"Not active here: {', '.join(in_process)} run inside the control-plane process. The Docker stack runs them as separate containers."
                    )
                )
            ),
        },
        {
            "name": "Role network segmentation",
            "status": "implemented" if isolated else "simulated",
            "detail": (
                "One internal Docker network per role path; probed from inside each role container."
                if isolated and deployment().get("mode") == "docker"
                else (
                    "Loopback isolation (127.0.0.1) per agent port; cross-role calls rejected by Ed25519 grant verification."
                    if isolated and deployment().get("mode") == "local-process"
                    else (
                        "One internal network per role path; probed from inside each role container."
                        if isolated
                        else "Declared model only in this deployment."
                    )
                )
            ),
        },
        {
            "name": "Operator credential kept out of the browser",
            "status": "implemented",
            "detail": "The proxy (nginx or the Vite dev server) injects it; the frontend bundle holds no token.",
        },
        _target_control(target),
        {
            "name": "Blue Team agent",
            "status": "simulated",
            "detail": "Fixed playbook mapping each violated criterion to a rule.",
        },
        {
            "name": "Per-user identity",
            "status": "planned",
            "detail": "Credentials identify roles, not people; the operator is one shared credential.",
        },
        {
            "name": "Kernel-level sandbox",
            "status": "planned",
            "detail": "Containers share the Docker VM kernel; gVisor or microVM runtimes are not used.",
        },
    ]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    validate_tokens()
    if not remote.agent_url("target"):
        providers.get_provider()  # refuse to start with an unknown or misconfigured provider
    pipeline.target_timeout()  # refuse to start with a malformed BAYORA_TARGET_TIMEOUT
    if os.environ.get("BAYORA_RUN_MIGRATIONS", "1") != "0":
        db.init_db()  # in Docker the migrate service owns the schema; the runtime role cannot create tables
    yield


app = FastAPI(title="Bayora API", version="0.1.0", lifespan=lifespan)

# Answer only for known host names, so a DNS-rebinding page cannot drive the API from a
# browser (dev tokens are public). Docker: nginx forwards 127.0.0.1/localhost, agents call
# "backend", isolation probes use "bayora.internal".
ALLOWED_HOSTS = os.environ.get(
    "BAYORA_ALLOWED_HOSTS", "127.0.0.1,localhost,backend,bayora.internal,testserver"
)
app.add_middleware(
    TrustedHostMiddleware, allowed_hosts=[h.strip() for h in ALLOWED_HOSTS.split(",") if h.strip()]
)


UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_HOSTS = {h.strip() for h in ALLOWED_HOSTS.split(",") if h.strip()}


@app.middleware("http")
async def refuse_cross_site_writes(request: Request, call_next):
    """The proxy attaches the operator credential to every /api request, so a page on another
    site must not be able to make the operator's browser send state-changing requests.
    Browsers mark such requests (Sec-Fetch-Site, Origin); agents and probes send neither."""
    if request.method in UNSAFE_METHODS:
        site = request.headers.get("sec-fetch-site")
        origin = request.headers.get("origin")
        foreign_origin = origin is not None and (urlsplit(origin).hostname or "") not in _HOSTS
        if site in ("cross-site", "same-site") or foreign_origin:
            return JSONResponse(status_code=403, content={"detail": "Cross-site request refused"})
    return await call_next(request)


@app.middleware("http")
async def timing_mitigation_middleware(request: Request, call_next):
    """Mitigate timing side channels on role routes (Red & Blue) via response-time quantization."""
    is_role_route = request.url.path.startswith("/api/red/") or request.url.path.startswith("/api/blue/")
    t0 = time.perf_counter()
    response = await call_next(request)
    if is_role_route:
        await fairness.async_pad_response_time(t0)
        response.headers["X-Timing-Protection"] = "quantized"
    return response


@app.exception_handler(pipeline.Conflict)
def conflict_handler(_request: Request, exc: pipeline.Conflict):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(providers.ProviderError)
def provider_handler(_request: Request, exc: providers.ProviderError):
    # In-process target only (the agent maps the same error to its own 502). The stage rolled back.
    return JSONResponse(status_code=502, content={"detail": f"Target provider failure: {exc}"})


logger = logging.getLogger(__name__)


@app.exception_handler(remote.RemoteError)
def remote_handler(_request: Request, exc: remote.RemoteError):
    # The stage's transaction has rolled back; nothing was done in-process instead.
    msg = str(exc).lower()
    role = (
        "red" if "red" in msg else ("blue" if "blue" in msg else ("target" if "target" in msg else "agent"))
    )
    try:
        with db.connect() as conn:
            monitor.record_alert(conn, role, _request.url.path, "PROCESS_CRASH")
    except (sqlite3.Error, OSError, RuntimeError) as alert_err:
        logger.warning("Failed to record crash alert: %s", alert_err)
    return JSONResponse(status_code=502, content={"detail": f"Role service failure: {exc}"})


class RunCreate(BaseModel):
    attack_ids: list[str] | None = Field(default=None, max_length=50)


class RedSubmit(BaseModel):
    attack_id: str
    phase: Literal["baseline", "retest"] = "baseline"


class DefenseApply(BaseModel):
    rule_id: str
    criterion: str | None = None


class TamperRequest(BaseModel):
    mode: Literal["modify", "delete", "reorder", "rewrite"]
    seq: int | None = None


def _session(conn: db.DB, session_id: str) -> dict:
    session = pipeline.get_session(conn, session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    return session


def _attempt_out(row: dict) -> dict:
    return {**row, "criteria": json.loads(row["criteria"]) if row["criteria"] else None}


def _event_out(row: dict) -> dict:
    return {**row, "details": json.loads(row["details"])}


def _status(session: dict) -> str:
    # Stages run only inside an advance request, so an unfinished run is incomplete, not running.
    return "completed" if session["stage"] == "report" else "incomplete"


def _run_target(conn: db.DB, session: dict) -> dict:
    """What answered as the target in this run, as recorded (report, else the latest target event)."""
    deployment = (session["report"] or {}).get("deployment") or {}
    if deployment.get("target_kind"):
        return {"provider": deployment.get("target_provider"), "kind": deployment["target_kind"]}
    return pipeline.recorded_target(conn, session["id"])


def _run_detail(conn: db.DB, session: dict) -> dict:
    attempts = conn.all("SELECT * FROM attempts WHERE session_id = ? ORDER BY position", (session["id"],))
    by_key = {(a["attack_id"], a["phase"]): _attempt_out(a) for a in attempts}
    residual = {c["attack_id"]: c for c in (session["report"] or {}).get("cases", [])}
    rules = conn.all(
        "SELECT rule_id, criterion, created_at FROM defenses WHERE session_id = ? ORDER BY position",
        (session["id"],),
    )
    return {
        "id": session["id"],
        "created_at": session["created_at"],
        "stage": session["stage"],
        "next_stage": pipeline.next_stage(session),
        "status": _status(session),
        "target": _run_target(conn, session),
        "cases": [
            {
                "attack": BY_ID[attack_id],
                "baseline": by_key.get((attack_id, "baseline")),
                "retest": by_key.get((attack_id, "retest")),
                "residual": residual.get(attack_id),
            }
            for attack_id in session["attack_ids"]
        ],
        "defenses": [{**r, **defenses.RULES[r["rule_id"]]} for r in rules],
        "isolation": isolation.load_checks(conn, session["id"]),
        "report": session["report"],
    }


# ------------------------------------------------------------------ operator


@app.get("/api/health")
def health():
    """Liveness plus one real database round trip. Unauthenticated, so it names no provider:
    what answers as the target (and whether it is ready) is in /api/meta, asked of the target."""
    try:
        with db.connect() as conn:
            conn.one("SELECT 1 AS ok")
    except db.driver_errors() as exc:  # the API cannot serve runs without its database
        return JSONResponse(
            status_code=503,
            content={
                "status": "degraded",
                "storage": db.engine(),
                "database": f"unreachable ({exc.__class__.__name__})",
            },
        )
    return {"status": "ok", "storage": db.engine(), "database": "reachable"}


@app.get("/api/meta")
def meta(_role: str = Depends(require("runs:read"))):
    target = target_info()  # asked once per request: the notice and the register must agree
    return {
        "stages": pipeline.STAGES,
        "criteria": evaluator.CRITERIA,
        "rules": defenses.RULES,
        "playbook": defenses.PLAYBOOK,
        "controls": controls(target),
        "deployment": deployment(),
        "target": target,
        "permissions": {role: sorted(perms) for role, perms in PERMISSIONS.items()},
        "storage": db.engine(),
    }


@app.get("/api/attacks")
def list_attacks(_role: str = Depends(require("attacks:read"))):
    return ALL_ATTACKS


@app.get("/api/threat-model")
def get_threat_model(_role: str = Depends(require("runs:read"))):
    doc_path = Path(__file__).resolve().parents[2] / "docs" / "THREAT_MODEL.md"
    content = doc_path.read_text(encoding="utf-8") if doc_path.exists() else ""
    return {
        "markdown": content,
        "threats": [
            {
                "threat": "Red reads Blue defenses / Blue reads Red attacks",
                "protected": True,
                "status": "Implemented",
                "how": "Strict RBAC permissions (app/auth.py), signed Ed25519 role tokens, isolated Docker bridge networks (red-net, blue-net), control plane zero-knowledge redaction.",
                "failure_mode": "Control plane kernel compromise or operator manually leaking logs.",
                "test": "backend/tests/test_permissions.py::test_role_permissions",
                "future": "Asymmetric envelope encryption of attack payloads and defense rules.",
            },
            {
                "threat": "Target contamination across sessions",
                "protected": True,
                "status": "Implemented",
                "how": "Per-request stateless context construction (app/llm_isolation.py), strict session isolation guard (ISO-09), automated session canary probe (ISO-10).",
                "failure_mode": "Underlying inference daemon retaining multi-turn memory or global conversation cache.",
                "test": "backend/tests/test_llm_isolation.py::test_cross_session_context_guard_pass",
                "future": "Per-session ephemeral container destruction and rebuild.",
            },
            {
                "threat": "Audit log tampering (including DB owner rewrite)",
                "protected": True,
                "status": "Implemented",
                "how": "Cryptographic SHA-256 hash chaining of all events; independent witness checkpoint service on dedicated network (ISO-08); DB role bayora_app denied UPDATE/DELETE.",
                "failure_mode": "Simultaneous compromise of both PostgreSQL database and witness log volume.",
                "test": "backend/tests/test_checkpoint.py, backend/tests_compose/test_stack.py::test_full_chain_rewrite_detected",
                "future": "Multi-witness Byzantine threshold consensus; public ledger transparency anchoring.",
            },
            {
                "threat": "Container escape via shared kernel",
                "protected": False,
                "status": "Partial",
                "how": "Hardened container profiles: cap_drop: ALL, no-new-privileges: true, non-root user (nobody), custom seccomp profile, read-only root filesystems (ISO-07).",
                "failure_mode": "0-day host Linux kernel privilege escalation exploit (e.g. dirty COW, eBPF bug).",
                "test": "backend/tests_compose/test_stack.py::test_container_capabilities_and_security_options",
                "future": "Hardware virtualization microVM isolation (AWS Firecracker, gVisor runsc, Kata).",
            },
            {
                "threat": "Timing & resource side channels",
                "protected": False,
                "status": "Partial",
                "how": "Discrete response-time padding middleware (timing_mitigation_middleware, 10ms quantum, X-Timing-Protection: quantized); container CPU/memory bounds (ISO-12).",
                "failure_mode": "Sub-millisecond CPU microarchitectural cache attacks (Flush+Reload, Prime+Probe), memory bus contention.",
                "test": "backend/tests/test_fairness.py::test_timing_mitigation_middleware",
                "future": "Physical CPU core pinning (cpuset) and constant-time queue processing.",
            },
            {
                "threat": "Shared KV-cache leakage in model provider",
                "protected": False,
                "status": "Simulated",
                "how": "Control plane enforces stateless single-turn calls with keep_alive: 0; output isolation scanner (ISO-11) flags prompt/defense residues; explicit UI report disclaimer.",
                "failure_mode": "Multi-tenant inference server (vLLM, Ollama) sharing GPU prefix cache blocks across tenants.",
                "test": "backend/tests/test_llm_isolation.py::test_output_isolation_scanner_clean",
                "future": "Per-tenant GPU memory partitioning or confidential computing hardware enclaves.",
            },
            {
                "threat": "Compromised signing key",
                "protected": True,
                "status": "Implemented",
                "how": "Asymmetric Ed25519 verification with Key IDs (kid); real-time key revocation endpoint (POST /api/credentials/revocations) rejects revoked credentials immediately.",
                "failure_mode": "Stolen private key used prior to revocation notice being published to audit chain.",
                "test": "backend/tests/test_credentials.py::test_revocation_lifecycle",
                "future": "Ephemeral short-lived credentials (5-minute TTL) with hardware HSM storage.",
            },
            {
                "threat": "Data leakage to third-party provider (Groq)",
                "protected": False,
                "status": "Partial",
                "how": "Default mode uses 100% offline local simulator; live cloud models require opt-in and display explicit warnings; TLS 1.3 transit encryption.",
                "failure_mode": "Third-party provider compromises, internal logging, or server-side model retention.",
                "test": "backend/tests/test_providers.py",
                "future": "Local-only offline weights (Llama 3 / Qwen) or differential privacy proxy.",
            },
            {
                "threat": "Operator credential sharing",
                "protected": True,
                "status": "Implemented",
                "how": "Fine-grained RBAC permissions (PERMISSIONS); immutable audit log of operator commands; sliding-window rate limiting on alert queries (60 req/min).",
                "failure_mode": "Multiple human operators sharing identical credentials prevents individual attribution.",
                "test": "backend/tests/test_monitor.py::test_alerts_endpoint_rate_limited",
                "future": "OIDC / SAML SSO with mandatory Multi-Factor Authentication (MFA) per operator.",
            },
            {
                "threat": "Direct Prompt Injection bypass",
                "protected": False,
                "status": "Partial",
                "how": "Multi-layer input defenses (instruction-guard, persona-lock, decode-scan) + output canary redaction (secret-egress-filter).",
                "failure_mode": "Novel token encoding, unicode homoglyphs, or semantic payload splitting (PS-05).",
                "test": "backend/tests/test_workflow.py",
                "future": "Fine-tuned classifier guard models (Llama Guard / NeMo Guardrails).",
            },
            {
                "threat": "Indirect Prompt Injection via data files",
                "protected": False,
                "status": "Partial",
                "how": "Content fence stripping hidden markup (<!-- ... -->) before document content reaches target model.",
                "failure_mode": "Multi-language hidden formatting, zero-width spaces, or Markdown image exfiltration.",
                "test": "backend/tests/test_ii04_design.py",
                "future": "Structural document parser with strict schema sanitization.",
            },
        ],
    }


@app.get("/api/runs")
def list_runs(_role: str = Depends(require("runs:read"))):
    with db.connect() as conn:
        rows = conn.all("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 50")
        sessions = [pipeline.get_session(conn, r["id"]) for r in rows]
        return [
            {
                "id": s["id"],
                "created_at": s["created_at"],
                "stage": s["stage"],
                "status": _status(s),
                "target": _run_target(conn, s),
                "attack_ids": s["attack_ids"],
                "overall_risk": s["report"]["overall_risk"] if s["report"] else None,
                "counts": s["report"]["counts"] if s["report"] else None,
            }
            for s in sessions
        ]


@app.post("/api/runs", status_code=201)
def create_run(body: RunCreate, _role: str = Depends(require("runs:write"))):
    requested = body.attack_ids if body.attack_ids is not None else DEFAULT_ATTACK_IDS
    attack_ids = list(dict.fromkeys(requested))
    unknown = [a for a in attack_ids if a not in BY_ID]
    if unknown or not attack_ids:
        raise HTTPException(
            422, f"Unknown attack ids: {', '.join(unknown)}" if unknown else "No attacks selected"
        )
    with db.connect() as conn:
        session_id = pipeline.create_session(conn, attack_ids)
    with db.connect() as conn:
        anchor = checkpoint.publish(conn)
        return {**_run_detail(conn, _session(conn, session_id)), "checkpoint": anchor}


@app.get("/api/runs/{session_id}")
def get_run(session_id: str, _role: str = Depends(require("runs:read"))):
    with db.connect() as conn:
        return _run_detail(conn, _session(conn, session_id))


class Advance(BaseModel):
    # The stage the caller means to run. Optional for older clients; when given, a repeated
    # request (double click, retry after a timeout) is refused instead of running the next stage.
    stage: Literal[tuple(pipeline.STAGES)] | None = None


@app.post("/api/runs/{session_id}/advance")
def advance_run(
    session_id: str,
    request: Request,
    body: Advance | None = None,
    _role: str = Depends(require("runs:write")),
):
    expected = body.stage if body else None
    with db.connect() as conn:
        _session(conn, session_id)
        stage = pipeline.advance(
            conn, session_id, request.app, request.headers.get("authorization"), expected
        )
    # Committed. Anchor the new head; a failure here is reported, never hidden.
    with db.connect() as conn:
        anchor = checkpoint.publish(conn)
        return {"executed": stage, "run": _run_detail(conn, _session(conn, session_id)), "checkpoint": anchor}


@app.get("/api/audit")
def list_audit(
    session_id: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    _role: str = Depends(require("audit:read")),
):
    where, params = ("WHERE session_id = ?", (session_id, limit)) if session_id else ("", (limit,))
    with db.connect() as conn:
        rows = conn.all(
            f"SELECT * FROM (SELECT * FROM audit_events {where} ORDER BY seq DESC LIMIT ?) recent ORDER BY seq",
            params,
        )
    return [_event_out(r) for r in rows]


@app.get("/api/audit/verify")
def verify_audit(_role: str = Depends(require("audit:read"))):
    with db.connect() as conn:
        result = audit.verify(conn)
        events = audit.load(conn)
    anchor = checkpoint.verify(events)
    result["checkpoint"] = anchor
    if anchor["status"] in ("mismatch", "unavailable"):
        result["errors"] = result["errors"] + anchor["errors"]
        result["ok"] = False
    return result


@app.post("/api/audit/tamper-test")
def tamper_test(body: TamperRequest, _role: str = Depends(require("audit:read"))):
    with db.connect() as conn:
        events = audit.load(conn)
    check = None
    if checkpoint.configured():
        try:
            records = checkpoint.fetch()["records"]
        except remote.RemoteError as exc:
            raise HTTPException(502, f"Witness unavailable: {exc}") from exc

        def check(chain):
            return checkpoint.compare(chain, records)

    try:
        return audit.tamper_test(events, body.mode, body.seq, check)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/isolation/matrix")
def isolation_matrix(request: Request, _role: Principal = Depends(require("isolation:probe"))):
    return isolation.probe_matrix(request.app, request.headers.get("authorization"))


# ------------------------------------------------------------------ Red Team


@app.get("/api/red/sessions/{session_id}/attempts")
def red_attempts(session_id: str, _role: str = Depends(require("red:read"))):
    with db.connect() as conn:
        _session(conn, session_id)
        return pipeline.red_view(conn, session_id)


@app.post("/api/red/sessions/{session_id}/attempts", status_code=201)
def red_submit(session_id: str, body: RedSubmit, principal: Principal = Depends(require("red:submit"))):
    if body.attack_id not in BY_ID:
        raise HTTPException(422, f"Unknown attack id: {body.attack_id}")
    with db.connect() as conn:
        session = _session(conn, session_id)
        attempt_id = pipeline.red_submit(conn, session, body.attack_id, body.phase, principal.credential)
    return {"attempt_id": attempt_id}


# ------------------------------------------------------------------ Blue Team


@app.get("/api/blue/rules")
def blue_rules(_role: str = Depends(require("blue:read"))):
    return defenses.RULES


@app.get("/api/blue/sessions/{session_id}/findings")
def blue_findings(session_id: str, principal: Principal = Depends(require("blue:read"))):
    with db.connect() as conn:
        _session(conn, session_id)
        findings = pipeline.blue_findings(conn, session_id)
        # Every Blue read of findings is evidence of what the Blue Team was shown.
        audit.append(
            conn,
            session_id,
            "blue",
            "blue.findings_read",
            f"session:{session_id}",
            {"findings": len(findings), "via": "api", **pipeline.evidence(principal.credential)},
        )
        return findings


@app.post("/api/blue/sessions/{session_id}/defenses")
def blue_defend(session_id: str, body: DefenseApply, principal: Principal = Depends(require("blue:defend"))):
    if body.rule_id not in defenses.RULES:
        raise HTTPException(404, f"Unknown rule: {body.rule_id}")
    if body.criterion is not None and body.criterion not in evaluator.CRITERIA:
        raise HTTPException(422, f"Unknown criterion: {body.criterion}")
    with db.connect() as conn:
        session = _session(conn, session_id)
        criterion = body.criterion or "manual"
        applied = pipeline.apply_defense(conn, session, body.rule_id, criterion, principal.credential)
    return {"rule_id": body.rule_id, "applied": applied}


# ------------------------------------------------------------------ credentials


class Revocation(BaseModel):
    kid: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=3, max_length=300)


@app.get("/api/credentials")
def list_credentials(_role: Principal = Depends(require("credentials:manage"))):
    """Key ids the control plane trusts per role (public material only) and revoked ids."""
    with db.connect() as conn:
        revoked = conn.all("SELECT kid, revoked_at, reason FROM credential_revocations ORDER BY revoked_at")
    return {
        "roles": {role: sorted(credentials.role_keys(role)) for role in credentials.SIGNED_ROLES},
        "revoked": revoked,
    }


@app.post("/api/credentials/revocations", status_code=201)
def revoke_credential(body: Revocation, _role: Principal = Depends(require("credentials:manage"))):
    """Refuse a role key id from now on. Takes effect on the next request; no restart needed."""
    known = {kid for role in credentials.SIGNED_ROLES for kid in credentials.role_keys(role)}
    if body.kid not in known:
        raise HTTPException(404, f"Unknown key id: {body.kid}")
    with db.connect() as conn:
        if conn.one("SELECT kid FROM credential_revocations WHERE kid = ?", (body.kid,)):
            raise HTTPException(409, f"{body.kid} is already revoked")
        conn.execute(
            "INSERT INTO credential_revocations (kid, revoked_at, reason) VALUES (?, ?, ?)",
            (body.kid, audit.now(), body.reason),
        )
        audit.append(
            conn,
            None,
            "operator",
            "credential.revoked",
            f"kid:{body.kid}",
            {"kid": body.kid, "reason": body.reason},
        )
    return {"kid": body.kid, "revoked": True}


# ------------------------------------------------------------------ Target


@app.get("/api/target/sessions/{session_id}/inbox")
def target_inbox(session_id: str, _role: str = Depends(require("target:read"))):
    with db.connect() as conn:
        _session(conn, session_id)
        return pipeline.target_inbox(conn, session_id)


# ------------------------------------------------------------------ monitoring & alerts


@app.get("/api/alerts")
def get_alerts(
    limit: int = Query(default=100, ge=1, le=500),
    _principal: Principal = Depends(require("audit:read")),
):
    """Retrieve recent redacted alerts and per-role counts (operator only, rate limited)."""
    monitor.check_alerts_rate_limit()
    with db.connect() as conn:
        return monitor.list_alerts(conn, limit)


@app.post("/api/alerts/demo", status_code=201)
def trigger_demo_alert(_principal: Principal = Depends(require("audit:read"))):
    """Trigger a safe demonstration violation to verify live alerting."""
    with db.connect() as conn:
        return monitor.trigger_demo_violation(conn)
