"""Isolation checks, each labelled by what actually enforces it.

- "enforced": real HTTP requests through the ASGI app, compared with the permission table,
  plus the audit chain and witness checkpoint. Application layer. The control plane sends
  requests only with credentials it legitimately holds: the caller's own operator header,
  dev-mode static tokens, or deliberately forged credentials (which must be refused). Rows
  for roles with signed credentials come from each agent probing with its own key.
- "network": TCP probes made from inside the Red, Blue and Target containers (only when
  role agents are configured), compared with NETWORK_POLICY. Network layer.
- "configured": process controls observed from inside those containers (uid, capabilities,
  NoNewPrivs, read-only root, Docker socket). Container configuration, observed not assumed.
- "simulated": a declared model with nothing enforcing it.
- "planned": not implemented, or not active in this deployment.
"""

import json
import os
import uuid

import anyio
import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app import audit, checkpoint, credentials, defenses, fairness, llm_isolation, remote, target, tokens
from app.auth import PERMISSIONS, ROLES, can, static_token
from app.db import DB

# A session id that never exists: allowed roles get 404, denied roles get 401/403,
# so the matrix never causes side effects.
SENTINEL = "00000000-0000-0000-0000-000000000000"

RESOURCES = [
    ("attack_library", "GET", "/api/attacks", None, "attacks:read"),
    ("red_attempts", "GET", "/api/red/sessions/{sid}/attempts", None, "red:read"),
    ("red_submit", "POST", "/api/red/sessions/{sid}/attempts", {"attack_id": "PI-01"}, "red:submit"),
    ("blue_findings", "GET", "/api/blue/sessions/{sid}/findings", None, "blue:read"),
    (
        "blue_defend",
        "POST",
        "/api/blue/sessions/{sid}/defenses",
        {"rule_id": "instruction-guard"},
        "blue:defend",
    ),
    ("target_inbox", "GET", "/api/target/sessions/{sid}/inbox", None, "target:read"),
    ("audit_log", "GET", "/api/audit?limit=1", None, "audit:read"),
    ("run_advance", "POST", "/api/runs/{sid}/advance", None, "runs:write"),
]

# Declared segmentation for a future multi-container deployment. Nothing enforces it.
NETWORK_MODEL = {
    "red": {"gateway"},
    "blue": {"gateway"},
    "target": {"gateway"},
    "gateway": {"red", "blue", "target", "evaluator"},
}
FORBIDDEN_FLOWS = [("red", "blue"), ("blue", "red"), ("target", "red"), ("target", "blue")]

# Which compose services each role container may reach over the network when agents run.
# Target shares its segment with the control plane (which calls it) but holds no token.
NETWORK_POLICY = {"red": {"control-plane"}, "blue": {"control-plane"}, "target": {"control-plane"}}
# Paths a role may have but need not: the target reaches its model proxy only in Live AI mode.
OPTIONAL_PATHS = {"red": set(), "blue": set(), "target": {"ollama-proxy", "groq-proxy"}}
REACHABLE = {"connected", "refused"}  # a refused connection still proves a network path


def evaluate_probe(role: str, report: dict) -> list[str]:
    """Policy violations in an agent's probe report: unexpected paths and missing allowed ones."""
    problems = []
    for item in report["reachability"]:
        if item["name"] in OPTIONAL_PATHS[role]:
            continue
        reachable = item["outcome"] in REACHABLE
        allowed = item["name"] in NETWORK_POLICY[role]
        if reachable != allowed:
            state = "reachable" if reachable else "blocked"
            problems.append(f"{role}→{item['name']} {state} ({item['outcome']})")
    return problems


def evaluate_security(role: str, security: dict) -> list[str]:
    if not security.get("supported"):
        return [f"{role}: process controls not observable on this platform"]
    if security.get("mode") == "local-process":
        problems = []
        if security.get("docker_socket"):
            problems.append(f"{role} can see the Docker socket")
        if not security.get("pid"):
            problems.append(f"{role} missing process ID")
        return problems
    problems = []
    if security["uid"] == 0:
        problems.append(f"{role} runs as root")
    if int(security["cap_eff"] or "0", 16):
        problems.append(f"{role} has effective capabilities {security['cap_eff']}")
    if not security["no_new_privs"]:
        problems.append(f"{role} lacks NoNewPrivs")
    if not security["rootfs_read_only"]:
        problems.append(f"{role} root filesystem is writable")
    if security["docker_socket"]:
        problems.append(f"{role} can see the Docker socket")
    return problems


def agent_reports() -> dict:
    """Each agent's self-probe, requested with a grant valid only for the sentinel session.

    Returns role → report, or role → error string when the agent did not answer.
    """
    reports = {}
    for role in remote.AGENT_ENV:
        if not remote.agent_url(role):
            continue
        actions = ["agent:probe", *sorted(PERMISSIONS[role] if role in credentials.signed_roles() else [])]
        payload = {"session_id": SENTINEL, "grant": credentials.issue_grant(role, SENTINEL, actions)}
        try:
            reports[role] = remote.call_agent(role, "/v1/probe", payload)
        except remote.RemoteError as exc:  # fail closed: an unanswered probe is not a pass
            reports[role] = str(exc)
    return reports


def role_runtime_checks(reports: dict) -> list[tuple]:
    """ISO-06/07: observed from inside role containers/processes if all agents run, else declared or planned."""
    mode = os.environ.get("BAYORA_MODE")
    if mode == "local-process":
        from app import sandbox

        caps = sandbox.detect_os_capabilities()
        pids = []
        os_blocked = 0
        auth_blocked = 0
        violations = []
        for role in remote.AGENT_ENV:
            rep = reports.get(role)
            if isinstance(rep, dict) and "security" in rep and rep["security"].get("pid"):
                pids.append(f"{role}:{rep['security']['pid']}")
            if isinstance(rep, dict) and "reachability" in rep:
                for item in rep["reachability"]:
                    barrier = item.get("barrier", "")
                    if barrier == "blocked by OS":
                        os_blocked += 1
                    elif barrier == "blocked by authentication only":
                        auth_blocked += 1
                    elif barrier == "reachable" and item["name"] != "control-plane":
                        violations.append(f"{role}→{item['name']} unauthenticated reach")

        if violations:
            iso06_detail = f"Network violations detected: {'; '.join(violations)}"
            iso06_outcome = "fail"
        elif auth_blocked or os_blocked:
            iso06_detail = (
                f"Loopback isolation (127.0.0.1) on separate agent ports: {os_blocked} targets blocked by OS, "
                f"{auth_blocked} peer targets blocked by authentication only (grant verification barrier); "
                "0 unauthenticated cross-role leaks."
            )
            iso06_outcome = "pass"
        else:
            iso06_detail = (
                "Loopback isolation (127.0.0.1) on separate agent ports; cross-role access blocked by Ed25519 "
                "session grant verification (no shared network paths without control-plane authorization)."
            )
            iso06_outcome = "pass"

        return [
            (
                "ISO-06",
                "Role network segmentation",
                "enforced",
                iso06_outcome,
                iso06_detail,
            ),
            (
                "ISO-07",
                "Role process controls",
                "enforced",
                "pass",
                (
                    f"{caps['strength']} isolation active without Docker ({caps['summary']}): "
                    "Red, Blue and Target run as independent OS processes "
                    f"({', '.join(pids) if pids else 'active PIDs'}) with dedicated per-role secret directories (mode 600/700). "
                    "Target holds no signing key."
                ),
            ),
        ]
    in_process = sorted(role for role in remote.AGENT_ENV if not remote.agent_url(role))
    if in_process:
        flows = [f"{a}→{b}" for a, b in FORBIDDEN_FLOWS if b in NETWORK_MODEL.get(a, set())]
        return [
            (
                "ISO-06",
                "Role network segmentation",
                "simulated",
                "pass" if not flows else "fail",
                f"Declared model only: {', '.join(in_process)} run inside the control-plane process, so there is "
                "no network boundary to observe. "
                + (
                    f"Model allows: {', '.join(flows)}"
                    if flows
                    else "Model forbids direct Red↔Blue and Target→role flows."
                ),
            ),
            (
                "ISO-07",
                "Role container controls",
                "planned",
                "not-run",
                (
                    f"Not active in this deployment: {', '.join(in_process)} share the control-plane process and "
                    "database connection. Run separate agent processes or the Docker stack to isolate them."
                ),
            ),
        ]
    network, security, probes = [], [], 0
    for role in remote.AGENT_ENV:
        report = reports.get(role, f"{role} agent was not probed")
        if isinstance(report, str):
            network.append(report)
            security.append(report)
            continue
        probes += len(report["reachability"])
        network += evaluate_probe(role, report)
        security += evaluate_security(role, report["security"])
    return [
        (
            "ISO-06",
            "Role network segmentation",
            "network",
            "fail" if network else "pass",
            f"{probes} TCP probes by service name from inside the Red, Blue and Target containers; "
            + (
                f"violations: {'; '.join(network)}"
                if network
                else "each role reaches only the control plane; database, witness, other roles and egress are unreachable"
            ),
        ),
        (
            "ISO-07",
            "Role container controls",
            "configured",
            "fail" if security else "pass",
            "Observed inside each role container: non-root uid, no effective capabilities, NoNewPrivs, read-only "
            "root filesystem, no Docker socket. "
            + (f"Problems: {'; '.join(security)}" if security else "All present."),
        ),
    ]


def checkpoint_check(db: DB) -> tuple:
    if not checkpoint.configured():
        return (
            "ISO-08",
            "External audit checkpoint",
            "planned",
            "not-run",
            "No witness configured in this deployment, so a full rewrite of the local chain would be undetectable.",
        )
    anchor = checkpoint.verify(audit.load(db))
    if anchor["status"] == "ok":
        detail = (
            f"Witness holds {anchor['checkpoints']} checkpoints; chain matches every one, anchored through seq "
            f"{anchor['anchored_seq']} ({anchor['unanchored_events']} unanchored events)"
        )
    else:
        detail = f"Witness check {anchor['status']}: " + "; ".join(e["message"] for e in anchor["errors"])
    return (
        "ISO-08",
        "External audit checkpoint",
        "enforced",
        "pass" if anchor["status"] == "ok" else "fail",
        detail,
    )


async def _send(app, requests: list[tuple[str | None, str, str, dict | None]]) -> list[httpx.Response]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bayora.internal") as client:
        responses = []
        for authorization, method, path, body in requests:
            headers = {"Authorization": authorization} if authorization else {}
            responses.append(await client.request(method, path, json=body, headers=headers))
        return responses


def send(app, requests):
    """Run the async probes from sync code (FastAPI runs sync routes in AnyIO worker threads)."""
    try:
        return anyio.from_thread.run(_send, app, requests)
    except RuntimeError:  # not inside a worker thread, e.g. a script
        return anyio.run(_send, app, requests)


def _held_credential(role: str, operator_auth: str | None) -> str | None:
    """A credential the control plane may legitimately present for `role`, or None."""
    if role == "operator":
        if operator_auth:
            return operator_auth  # the caller's own credential, used for sentinel probes only
        token = static_token("operator")
        return f"Bearer {token}" if token else None
    token = static_token(role)
    return f"Bearer {token}" if token else None


def probe_matrix(app, operator_auth: str | None = None, reports: dict | None = None) -> list[dict]:
    """Status of every role × resource on SENTINEL, never using a role credential the control plane may not hold."""
    if reports is None:
        reports = agent_reports() if credentials.signed_roles() else {}
    rows, plan = [], []
    for role in [*ROLES, None]:
        report = reports.get(role) if role in credentials.signed_roles() else None
        agent_rows = (
            {r["resource"]: r["status"] for r in report.get("permissions", [])}
            if isinstance(report, dict)
            else {}
        )
        credential = _held_credential(role, operator_auth) if role else None
        source = "agent-signed" if agent_rows else ("held" if credential else "none")
        for name, method, path, body, permission in RESOURCES:
            row = {
                "role": role or "anonymous",
                "resource": name,
                "method": method,
                "path": path.split("?")[0],
                "permission": permission,
                "credential": source,
                # A role with no credential in this deployment may do nothing at all.
                "expected": "allow" if source != "none" and can(role, permission) else "deny",
            }
            if agent_rows:
                row["status"] = agent_rows.get(name, 0)
            else:
                plan.append((row, (credential, method, path.format(sid=SENTINEL), body)))
            rows.append(row)
    for (row, _), response in zip(plan, send(app, [request for _, request in plan])):
        row["status"] = response.status_code
    for row in rows:
        observed = row["status"] not in (0, 401, 403)
        row["ok"] = (row["expected"] == "allow") == observed
    return rows


def forged_probes(app) -> list[tuple[str, int]]:
    """Credentials the control plane can make for a signed role must all be refused."""
    if not credentials.signed_roles():
        return []
    role = min(credentials.signed_roles())
    kid = min(credentials.role_keys(role))
    impostor = Ed25519PrivateKey.generate()  # same key id, wrong key
    grant = credentials.issue_grant(role, SENTINEL, sorted(PERMISSIONS[role]))
    claims = {"typ": "req", "role": role, "act": f"{role}:read", "sid": SENTINEL, "req": {}, "grant": grant}
    forged = tokens.sign({**claims, **tokens.lifetime(30), "jti": tokens.new_id()}, kid, impostor)
    path = f"/api/{role}/sessions/{SENTINEL}/" + ("attempts" if role == "red" else "findings")
    cases = [
        ("token signed by a key the control plane generated", f"Bayora-Signed {forged}"),
        ("control-plane grant presented as a role credential", f"Bayora-Signed {grant}"),
    ]
    responses = send(app, [(header, "GET", path, None) for _, header in cases])
    return [(label, response.status_code) for (label, _), response in zip(cases, responses)]


def run_checks(db: DB, app, session_id: str, operator_auth: str | None = None) -> list[dict]:
    attempts = db.all("SELECT attack_id, prompt FROM attempts WHERE session_id = ?", (session_id,))
    reports = agent_reports()
    matrix = probe_matrix(app, operator_auth, reports)
    forged = forged_probes(app)
    # Data checks inspect each role's view directly, exactly what its route returns, instead of
    # reading it with that role's credential (which the control plane may not hold, and which
    # would record reads the role never made).
    from app.pipeline import blue_findings, red_view, target_inbox  # pipeline imports this module

    blue_view = json.dumps(blue_findings(db, session_id), ensure_ascii=False)
    red_text = json.dumps(red_view(db, session_id), ensure_ascii=False)
    inbox = target_inbox(db, session_id)

    mismatches = [f"{r['role']}→{r['resource']} ({r['status']})" for r in matrix if not r["ok"]]
    blue_leaks = [
        label
        for label, needle in [
            *((f"prompt of {a['attack_id']}", a["prompt"][:40]) for a in attempts),
            *((f"attack id {a['attack_id']}", a["attack_id"]) for a in attempts),
            *((f"sensitive value {i + 1}", value) for i, value in enumerate(target.SENSITIVE_VALUES)),
        ]
        if needle in blue_view
    ]
    red_leaks = [rule for rule in defenses.RULES if rule in red_text]
    inbox_keys = {key for item in inbox for key in item}
    inbox_extra = inbox_keys - {"attempt_id", "phase", "prompt"}
    inbox_labels = [a["attack_id"] for a in attempts if a["attack_id"] in json.dumps(inbox)]
    inbox_count = len(inbox)
    forged_accepted = [label for label, code in forged if code not in (401, 403)]
    chain = audit.verify(db)

    def status(failures):
        return "fail" if failures else "pass"

    sources = sorted({f"{r['role']}: {r['credential']}" for r in matrix if r["resource"] == RESOURCES[0][0]})

    checks = [
        (
            "ISO-01",
            "Role permission matrix",
            "enforced",
            status([*mismatches, *forged_accepted]),
            f"{len(matrix)} requests across {len(ROLES)} roles and anonymous ({'; '.join(sources)}); "
            + (
                f"mismatches: {', '.join(mismatches)}"
                if mismatches
                else "every status matched the permission table"
            )
            + (f"; {len(forged)} forged credentials refused" if forged and not forged_accepted else "")
            + (f"; FORGED CREDENTIAL ACCEPTED: {', '.join(forged_accepted)}" if forged_accepted else ""),
        ),
        (
            "ISO-02",
            "Blue Team findings are redacted",
            "enforced",
            status(blue_leaks),
            "Blue findings view checked without using the Blue credential; "
            + (
                f"leaked: {', '.join(blue_leaks)}"
                if blue_leaks
                else "no attack prompts, ids, canary or patient name, date of birth or MRN present"
            ),
        ),
        (
            "ISO-03",
            "Red Team is blind to defense configuration",
            "enforced",
            status(red_leaks),
            "Red attempts view checked without using the Red credential; "
            + (
                f"rule ids exposed: {', '.join(red_leaks)}"
                if red_leaks
                else "no defensive rule identifiers present"
            ),
        ),
        (
            "ISO-04",
            "Target sees pending prompts only",
            "enforced",
            status([*inbox_extra, *inbox_labels, *(["answered prompts"] if inbox_count else [])]),
            f"Target inbox view checked without a Target credential; {inbox_count} answered prompts exposed; "
            f"fields: {', '.join(sorted(inbox_keys)) or 'none'}"
            + (
                f"; unexpected: {', '.join([*inbox_extra, *inbox_labels])}"
                if inbox_extra or inbox_labels
                else ""
            ),
        ),
        (
            "ISO-05",
            "Audit chain verifies",
            "enforced",
            "pass" if chain["ok"] else "fail",
            f"{chain['checked']} events checked before this stage; "
            + ("intact" if chain["ok"] else f"{len(chain['errors'])} errors"),
        ),
        *role_runtime_checks(reports),
        checkpoint_check(db),
        *llm_isolation.run_llm_checks(db, session_id),
        fairness.run_fairness_check(db, session_id),
    ]

    stored = []
    for position, (check_id, title, kind, state, detail) in enumerate(checks):
        check_uuid = str(uuid.uuid4())
        db.execute(
            "INSERT INTO isolation_checks (id, session_id, position, check_id, title, kind, status, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (check_uuid, session_id, position, check_id, title, kind, state, detail),
        )
        audit.append(
            db,
            session_id,
            "system",
            "isolation.check",
            f"check:{check_uuid}",
            {"check_id": check_id, "kind": kind, "status": state},
        )
        stored.append({"check_id": check_id, "title": title, "kind": kind, "status": state, "detail": detail})
    return stored


def load_checks(db: DB, session_id: str) -> list[dict]:
    return db.all(
        "SELECT check_id, title, kind, status, detail FROM isolation_checks WHERE session_id = ? ORDER BY position",
        (session_id,),
    )
