"""Bayora API. Every route declares the single permission it needs (see auth.PERMISSIONS)."""

import json
import os
from contextlib import asynccontextmanager
from typing import Literal

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
    isolation,
    pipeline,
    providers,
    remote,
)
from app.attacks import ATTACKS, BY_ID
from app.auth import PERMISSIONS, Principal, require, validate_tokens


def deployment() -> dict:
    agents = {role: "agent" if remote.agent_url(role) else "in-process" for role in remote.AGENT_ENV}
    return {
        "roles": agents,
        "checkpoint": "witness" if checkpoint.configured() else "not-configured",
        "credentials": "signed" if credentials.signed_roles() else "static",
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
        "Answers can vary between runs; the scripted checks are string-match heuristics, not a full audit."
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
            "detail": "Red, Blue and Target run as separate non-root, read-only agent containers holding only "
            "their own credential."
            if isolated
            else f"Not active here: {', '.join(in_process)} run inside the control-plane process. The Docker "
            "stack runs them as separate containers.",
        },
        {
            "name": "Role network segmentation",
            "status": "implemented" if isolated else "simulated",
            "detail": "One internal Docker network per role path; probed from inside each role container."
            if isolated
            else "Declared model only in this deployment.",
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


@app.exception_handler(pipeline.Conflict)
def conflict_handler(_request: Request, exc: pipeline.Conflict):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(providers.ProviderError)
def provider_handler(_request: Request, exc: providers.ProviderError):
    # In-process target only (the agent maps the same error to its own 502). The stage rolled back.
    return JSONResponse(status_code=502, content={"detail": f"Target provider failure: {exc}"})


@app.exception_handler(remote.RemoteError)
def remote_handler(_request: Request, exc: remote.RemoteError):
    # The stage's transaction has rolled back; nothing was done in-process instead.
    return JSONResponse(status_code=502, content={"detail": f"Role service failure: {exc}"})


class RunCreate(BaseModel):
    attack_ids: list[str] | None = None


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
        "status": "completed" if session["stage"] == "report" else "running",
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
    return {"status": "ok", "storage": db.engine(), "target": "simulated"}


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
    return ATTACKS


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
            "status": "completed" if s["stage"] == "report" else "running",
            "attack_ids": s["attack_ids"],
            "overall_risk": s["report"]["overall_risk"] if s["report"] else None,
            "counts": s["report"]["counts"] if s["report"] else None,
        }
        for s in sessions
    ]


@app.post("/api/runs", status_code=201)
def create_run(body: RunCreate, _role: str = Depends(require("runs:write"))):
    requested = body.attack_ids if body.attack_ids is not None else [a["id"] for a in ATTACKS]
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


@app.post("/api/runs/{session_id}/advance")
def advance_run(session_id: str, request: Request, _role: str = Depends(require("runs:write"))):
    with db.connect() as conn:
        _session(conn, session_id)
        stage = pipeline.advance(conn, session_id, request.app, request.headers.get("authorization"))
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
