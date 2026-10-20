"""Isolation checks, each labelled by what actually enforces it.

- "enforced": real HTTP requests through the ASGI app with each role's token, compared
  with the permission table, plus the audit chain and witness checkpoint. Application layer.
- "network": TCP probes made from inside the Red, Blue and Target containers (only when
  role agents are configured), compared with NETWORK_POLICY. Network layer.
- "configured": process controls observed from inside those containers (uid, capabilities,
  NoNewPrivs, read-only root, Docker socket). Container configuration, observed not assumed.
- "simulated": a declared model with nothing enforcing it.
- "planned": not implemented, or not active in this deployment.
"""

import json
import uuid

import anyio
import httpx

from app import audit, checkpoint, defenses, remote, target
from app.auth import ROLES, can, role_tokens
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
REACHABLE = {"connected", "refused"}  # a refused connection still proves a network path


def evaluate_probe(role: str, report: dict) -> list[str]:
    """Policy violations in an agent's probe report: unexpected paths and missing allowed ones."""
    problems = []
    for item in report["reachability"]:
        reachable = item["outcome"] in REACHABLE
        allowed = item["name"] in NETWORK_POLICY[role]
        if reachable != allowed:
            state = "reachable" if reachable else "blocked"
            problems.append(f"{role}→{item['name']} {state} ({item['outcome']})")
    return problems


def evaluate_security(role: str, security: dict) -> list[str]:
    if not security.get("supported"):
        return [f"{role}: process controls not observable on this platform"]
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


def role_runtime_checks() -> list[tuple]:
    """ISO-06/07: observed from inside role containers if all agents run, else declared or planned."""
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
                    "database connection. Run the Docker stack to isolate them."
                ),
            ),
        ]
    network, security, probes = [], [], 0
    for role in remote.AGENT_ENV:
        try:
            report = remote.call_agent(role, "/v1/probe", {})
        except remote.RemoteError as exc:  # fail closed: an unanswered probe is not a pass
            network.append(str(exc))
            security.append(str(exc))
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
    tokens = role_tokens()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bayora.internal") as client:
        responses = []
        for role, method, path, body in requests:
            headers = {"Authorization": f"Bearer {tokens[role]}"} if role else {}
            responses.append(await client.request(method, path, json=body, headers=headers))
        return responses


def send(app, requests):
    """Run the async probes from sync code (FastAPI runs sync routes in AnyIO worker threads)."""
    try:
        return anyio.from_thread.run(_send, app, requests)
    except RuntimeError:  # not inside a worker thread, e.g. a script
        return anyio.run(_send, app, requests)


def probe_matrix(app) -> list[dict]:
    roles = [*ROLES, None]
    plan = [(role, *resource) for role in roles for resource in RESOURCES]
    responses = send(
        app, [(role, method, path.format(sid=SENTINEL), body) for role, _, method, path, body, _ in plan]
    )
    rows = []
    for (role, name, method, path, _, permission), response in zip(plan, responses):
        expected = role is not None and can(role, permission)
        observed = response.status_code not in (401, 403)
        rows.append(
            {
                "role": role or "anonymous",
                "resource": name,
                "method": method,
                "path": path.split("?")[0],
                "permission": permission,
                "expected": "allow" if expected else "deny",
                "status": response.status_code,
                "ok": expected == observed,
            }
        )
    return rows


def run_checks(db: DB, app, session_id: str) -> list[dict]:
    attempts = db.all("SELECT attack_id, prompt FROM attempts WHERE session_id = ?", (session_id,))
    matrix = probe_matrix(app)
    red, inbox = send(
        app,
        [
            ("red", "GET", f"/api/red/sessions/{session_id}/attempts", None),
            ("target", "GET", f"/api/target/sessions/{session_id}/inbox", None),
        ],
    )
    # ISO-02 inspects the Blue view directly. Reading it through the Blue API with the Blue
    # token would record a Blue read that Blue never made; the route returns exactly this.
    from app.pipeline import blue_findings  # local import: pipeline imports this module

    blue_view = json.dumps(blue_findings(db, session_id), ensure_ascii=False)

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
    red_leaks = [rule for rule in defenses.RULES if rule in red.text]
    inbox_keys = {key for item in inbox.json() for key in item} if inbox.status_code == 200 else set()
    inbox_extra = inbox_keys - {"attempt_id", "phase", "prompt"}
    inbox_labels = [a["attack_id"] for a in attempts if a["attack_id"] in inbox.text]
    inbox_count = len(inbox.json()) if inbox.status_code == 200 else 0
    chain = audit.verify(db)

    def status(failures, expected_code=200, response=None):
        if response is not None and response.status_code != expected_code:
            return "fail"
        return "fail" if failures else "pass"

    checks = [
        (
            "ISO-01",
            "Role permission matrix",
            "enforced",
            status(mismatches),
            f"{len(matrix)} live requests across {len(ROLES)} roles and anonymous; "
            + (
                f"mismatches: {', '.join(mismatches)}"
                if mismatches
                else "every status matched the permission table"
            ),
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
            status(red_leaks, response=red),
            f"GET attempts as Red returned {red.status_code}; "
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
            status(
                [*inbox_extra, *inbox_labels, *(["answered prompts"] if inbox_count else [])], response=inbox
            ),
            f"GET inbox as Target returned {inbox.status_code}; {inbox_count} answered prompts exposed; "
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
        *role_runtime_checks(),
        checkpoint_check(db),
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
