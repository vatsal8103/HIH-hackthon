"""Container and network tests against a running Docker stack.

These run real `docker exec` and `docker inspect` calls from outside the containers, so
they verify isolation independently of what the agents report about themselves. Run with
scripts/compose-test.sh, which builds a throwaway stack (project bayora-test, UI on
127.0.0.1:18080), runs this file and removes the stack and its volumes afterwards.
Only stack services and the TEST-NET-1 documentation address are ever contacted.
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from http.client import HTTPConnection
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("BAYORA_COMPOSE_TESTS"), reason="needs a running stack; use scripts/compose-test.sh"
)

PROJECT = os.environ.get("BAYORA_COMPOSE_PROJECT", "bayora-test")
PORT = int(os.environ.get("BAYORA_UI_PORT", "18080"))
UI = f"http://127.0.0.1:{PORT}"
ROOT = Path(__file__).resolve().parents[2]
SECRETS = dict(line.split("=", 1) for line in (ROOT / ".env").read_text().split() if "=" in line)

PORTS = {
    "backend": 8000,
    "db": 5432,
    "red-agent": 8000,
    "blue-agent": 8000,
    "target": 8000,
    "witness": 8000,
    "frontend": 8080,
    "edge-relay": 8080,
}
ALLOWED = {
    "edge-relay": {"frontend"},  # holds the published port, nothing else
    "frontend": {"backend", "edge-relay"},
    "backend": {"db", "red-agent", "blue-agent", "target", "witness", "frontend"},
    "red-agent": {"backend"},
    "blue-agent": {"backend"},
    "target": {"backend"},
    "witness": {"backend"},
    "db": {"backend"},  # shares only the data segment with the backend
}
PYTHON = {"backend", "red-agent", "blue-agent", "target", "witness"}
SERVICES = [*PYTHON, "frontend", "edge-relay", "db"]
# Values that must stay with their holders. BAYORA_TOKEN_RED/BLUE/TARGET may remain in an
# older .env but no container receives them any more.
PRIVATE = {
    "BAYORA_TOKEN_OPERATOR",
    "BAYORA_TOKEN_RED",
    "BAYORA_TOKEN_BLUE",
    "BAYORA_TOKEN_TARGET",
    "BAYORA_WITNESS_TOKEN",
    "POSTGRES_PASSWORD",
    "BAYORA_APP_DB_PASSWORD",
    "BAYORA_CP_SIGNING_KEY",
    "BAYORA_RED_SIGNING_KEY",
    "BAYORA_BLUE_SIGNING_KEY",
}
PUBLIC = {
    "BAYORA_OPERATOR_TOKEN_SHA256",
    "BAYORA_CP_PUBLIC_KEYS",
    "BAYORA_RED_PUBLIC_KEYS",
    "BAYORA_BLUE_PUBLIC_KEYS",
}
SENTINEL = "00000000-0000-0000-0000-000000000000"
# Static role tokens an older .env may still hold; every one must now be refused.
LEGACY_RED = SECRETS.get("BAYORA_TOKEN_RED", "legacy-red-token-0000000000000")
LEGACY_BLUE = SECRETS.get("BAYORA_TOKEN_BLUE", "legacy-blue-token-000000000000")
APP_GRANTS = {
    "sessions": {"SELECT", "INSERT", "UPDATE"},
    "attempts": {"SELECT", "INSERT", "UPDATE"},
    "defenses": {"SELECT", "INSERT"},
    "isolation_checks": {"SELECT", "INSERT"},
    "audit_events": {"SELECT", "INSERT"},
    "credential_revocations": {"SELECT", "INSERT"},
}

PROBE = """
import json, socket, sys
out = {}
for label, host, port in json.loads(sys.argv[1]):
    try:
        socket.create_connection((host, port), 2).close(); out[label] = "open"
    except ConnectionRefusedError:
        out[label] = "open"  # refused still proves a network path
    except Exception as exc:
        out[label] = type(exc).__name__ + ":" + str(getattr(exc, "errno", ""))
print(json.dumps(out))
"""


def compose(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "compose", "-p", PROJECT, *args], cwd=ROOT, capture_output=True, text=True, check=check
    )


def run_in(service: str, *cmd: str) -> subprocess.CompletedProcess:
    return compose("exec", "-T", service, *cmd, check=False)


def inspect(service: str) -> dict:
    container = compose("ps", "-a", "-q", service).stdout.strip()  # -a: includes the exited migrate job
    return json.loads(
        subprocess.run(["docker", "inspect", container], capture_output=True, text=True, check=True).stdout
    )[0]


def addresses(service: str) -> list[str]:
    return [net["IPAddress"] for net in inspect(service)["NetworkSettings"]["Networks"].values()]


def probe_from(source: str, targets: list[tuple[str, str, int]]) -> dict:
    if source in PYTHON:
        result = run_in(source, ".venv/bin/python", "-c", PROBE, json.dumps(targets))
        return json.loads(result.stdout)
    script = "; ".join(
        f'nc -z -w 2 {host} {port} && echo "{label} open" || echo "{label} closed"'
        for label, host, port in targets
    )
    lines = run_in(source, "sh", "-c", script).stdout.split("\n")
    return {line.rsplit(" ", 1)[0]: line.rsplit(" ", 1)[1] for line in lines if line.strip()}


def http(method: str, path: str, body=None, headers=None):
    request = urllib.request.Request(
        UI + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def run_full(attack_ids=None) -> dict:
    status, run = http("POST", "/api/runs", {"attack_ids": attack_ids} if attack_ids else {})
    assert status == 201, run
    while run.get("next_stage", run.get("run", {}).get("next_stage")):
        status, run = http("POST", f"/api/runs/{run.get('id') or run['run']['id']}/advance")
        assert status == 200, run
    return run


# ---------------------------------------------------------------- network isolation


@pytest.mark.parametrize("source", sorted(ALLOWED))
def test_network_reachability_by_name_and_address(source):
    targets = []
    for dest, port in PORTS.items():
        if dest == source:
            continue
        targets.append((f"{dest} by name", dest, port))
        targets += [(f"{dest} at {ip}", ip, port) for ip in addresses(dest)]
    outcome = probe_from(source, targets)
    for dest in PORTS:
        if dest == source:
            continue
        by_name = outcome[f"{dest} by name"] == "open"
        by_ip = [outcome[f"{dest} at {ip}"] == "open" for ip in addresses(dest)]
        if dest in ALLOWED[source]:
            assert by_name and any(by_ip), f"{source} → {dest} should be reachable: {outcome}"
        else:
            assert not by_name and not any(by_ip), f"{source} → {dest} must be blocked: {outcome}"


@pytest.mark.parametrize("source", sorted(PYTHON))
def test_internal_services_have_no_egress(source):
    outcome = probe_from(source, [("egress", "192.0.2.1", 80)])  # TEST-NET-1: never a real host
    assert outcome["egress"] != "open"
    assert outcome["egress"].startswith("OSError"), f"expected no route (unreachable), got {outcome}"


def test_internal_networks_are_internal():
    networks = {name for name in inspect("backend")["NetworkSettings"]["Networks"]}
    for network in networks:
        details = json.loads(
            subprocess.run(
                ["docker", "network", "inspect", network], capture_output=True, text=True, check=True
            ).stdout
        )[0]
        assert details["Internal"] is True, network
    for service in ("frontend", "backend", "red-agent", "blue-agent", "target", "witness", "db"):
        attached = inspect(service)["NetworkSettings"]["Networks"]
        assert not [n for n in attached if n.endswith("_public")], service
    # Only the credential-free relay has outside connectivity.
    assert [n for n in inspect("edge-relay")["NetworkSettings"]["Networks"] if n.endswith("_public")]


def test_credential_holding_proxy_has_no_egress_or_host_route():
    outcome = probe_from("frontend", [("egress", "192.0.2.1", 80), ("host", "host.docker.internal", 8000)])
    assert outcome == {"egress": "closed", "host": "closed"}


# ---------------------------------------------------------------- container controls


@pytest.mark.parametrize("service", SERVICES)
def test_container_security_configuration(service):
    config = inspect(service)
    host = config["HostConfig"]
    assert host["Privileged"] is False
    assert host["NetworkMode"] != "host"
    assert host["ReadonlyRootfs"] is True
    assert "ALL" in host["CapDrop"]
    assert not any("unconfined" in option for option in host["SecurityOpt"] or []), (
        "seccomp/apparmor disabled"
    )
    assert "no-new-privileges:true" in host["SecurityOpt"]
    assert host["PidsLimit"] and host["Memory"]
    assert not [m for m in config["Mounts"] if m["Type"] == "bind"], "no host bind mounts"
    assert not [m for m in config["Mounts"] if "docker.sock" in m.get("Source", "")]
    added = {cap.removeprefix("CAP_") for cap in host.get("CapAdd") or []}
    assert added <= ({"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"} if service == "db" else set())


@pytest.mark.parametrize("service", SERVICES)
def test_main_process_is_unprivileged(service):
    status = run_in(service, "cat", "/proc/1/status").stdout
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    uid = int(fields["Uid"].split()[0])
    assert uid != 0, f"{service} PID 1 runs as root"
    if service != "db":  # postgres drops privileges itself; its PID 1 keeps the bounding set it was granted
        assert int(fields["CapEff"].strip(), 16) == 0
    assert fields["NoNewPrivs"].strip() == "1"


def test_witness_storage_is_mounted_only_by_the_witness():
    assert [m["Destination"] for m in inspect("witness")["Mounts"]] == ["/data"]
    for service in ["backend", "red-agent", "blue-agent", "target", "frontend", "edge-relay", "migrate"]:
        assert inspect(service)["Mounts"] == [], service
    assert run_in("backend", "ls", "/data").returncode != 0


# ---------------------------------------------------------------- secrets


def test_each_container_holds_only_its_own_credentials():
    expected = {
        "backend": {
            "BAYORA_OPERATOR_TOKEN_SHA256",  # a hash: can check the operator, cannot present the token
            "BAYORA_CP_SIGNING_KEY",
            "BAYORA_CP_PUBLIC_KEYS",
            "BAYORA_RED_PUBLIC_KEYS",
            "BAYORA_BLUE_PUBLIC_KEYS",
            "BAYORA_WITNESS_TOKEN",
            "BAYORA_APP_DB_PASSWORD",  # runtime role only, inside DATABASE_URL
        },
        "migrate": {"POSTGRES_PASSWORD", "BAYORA_APP_DB_PASSWORD"},
        "db": {"POSTGRES_PASSWORD"},
        "red-agent": {"BAYORA_RED_SIGNING_KEY", "BAYORA_CP_PUBLIC_KEYS"},
        "blue-agent": {"BAYORA_BLUE_SIGNING_KEY", "BAYORA_CP_PUBLIC_KEYS"},
        "target": {"BAYORA_CP_PUBLIC_KEYS"},
        "witness": {"BAYORA_WITNESS_TOKEN"},
        "frontend": {"BAYORA_TOKEN_OPERATOR"},
        "edge-relay": set(),
    }
    for service, allowed in expected.items():
        env = " ".join(inspect(service)["Config"]["Env"])
        held = {name for name in PRIVATE | PUBLIC if name in SECRETS and SECRETS[name] in env}
        assert held == allowed, (service, held ^ allowed)


def test_no_secret_in_bundle_images_or_logs():
    secrets = [SECRETS[name] for name in PRIVATE if name in SECRETS]
    bundle = run_in(
        "frontend", "sh", "-c", "cat /usr/share/nginx/html/assets/* /usr/share/nginx/html/index.html"
    ).stdout
    logs = compose("logs", "--no-color").stdout
    for service in PYTHON | {"frontend", "edge-relay"}:
        image = inspect(service)["Config"]["Image"]
        image_env = json.loads(
            subprocess.run(
                ["docker", "image", "inspect", image], capture_output=True, text=True, check=True
            ).stdout
        )[0]["Config"]["Env"]
        assert not any(secret in " ".join(image_env) for secret in secrets), image
    assert not any(secret in bundle for secret in secrets)
    assert "dev-operator-token" not in bundle
    assert not any(secret in logs for secret in secrets)


# ---------------------------------------------------------------- application boundary over real networks


def test_edge_proxy_only_ever_acts_as_operator():
    assert http("GET", "/api/attacks")[0] == 200  # credential injected by nginx
    assert http("GET", "/api/red/sessions/x/attempts")[0] == 403
    assert http("GET", "/api/blue/rules", headers={"Authorization": f"Bearer {LEGACY_BLUE}"})[0] == 403
    assert compose("port", "backend", "8000", check=False).stdout.strip() in ("", ":0")  # not published


def raw_status(path: str, headers: dict | None = None) -> int:
    """Send `path` exactly as written (no client-side normalisation) and return the status."""
    connection = HTTPConnection("127.0.0.1", PORT, timeout=10)  # `http` below is a helper
    connection.request("GET", path, headers=headers or {})
    return connection.getresponse().status


def test_edge_answers_only_loopback_host_names():
    # Regression for review finding V2: a DNS-rebinding page sends its own Host header.
    assert raw_status("/api/attacks", {"Host": f"127.0.0.1:{PORT}"}) == 200
    assert raw_status("/api/attacks", {"Host": f"localhost:{PORT}"}) == 200
    for host in ("rebind.attacker.example", "127.0.0.1.attacker.example", "backend"):
        assert raw_status("/api/runs", {"Host": host}) == 421, host


def test_edge_forbids_framing():
    with urllib.request.urlopen(UI + "/", timeout=10) as response:
        headers = response.headers
    assert headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert headers["X-Content-Type-Options"] == "nosniff"


def test_edge_replaces_client_credentials():
    # /api/runs is operator-only: if nginx forwarded the client's Red token it would be 403.
    assert raw_status("/api/runs", {"Authorization": f"Bearer {LEGACY_RED}"}) == 200


@pytest.mark.parametrize(
    "path",
    [
        "/api/red/sessions/x/attempts",
        "/api/%72ed/sessions/x/attempts",
        "/api//red/sessions/x/attempts",
        "/api/./red/sessions/x/attempts",
        "/api/blue/../red/sessions/x/attempts",
        "/api/RED/sessions/x/attempts",
        "/api/target%2Fsessions/x/inbox",
    ],
)
def test_role_paths_stay_blocked_at_the_edge(path):
    assert raw_status(path) in (403, 404)


def test_ui_is_published_on_loopback_only():
    assert compose("port", "edge-relay", "8080").stdout.strip().startswith("127.0.0.1:")
    for service in ("frontend", "backend", "db", "witness"):
        assert not inspect(service)["HostConfig"]["PortBindings"], service


@pytest.mark.parametrize("service", sorted(PYTHON))
def test_internal_services_cannot_resolve_the_docker_host(service):
    script = (
        "import socket\n"
        "try: socket.getaddrinfo('host.docker.internal', 8000); print('resolved')\n"
        "except socket.gaierror: print('unresolvable')\n"
    )
    assert run_in(service, ".venv/bin/python", "-c", script).stdout.strip() == "unresolvable"


def test_database_has_no_egress_or_host_access():
    outcome = probe_from("db", [("egress", "192.0.2.1", 80), ("host", "host.docker.internal", 8000)])
    assert outcome == {"egress": "closed", "host": "closed"}


def call_from(service: str, path: str, token: str | None) -> int:
    script = (
        "import sys, urllib.request, urllib.error\n"
        "req = urllib.request.Request('http://backend:8000' + sys.argv[1])\n"
        "if sys.argv[2]: req.add_header('Authorization', 'Bearer ' + sys.argv[2])\n"
        "try: print(urllib.request.urlopen(req, timeout=5).status)\n"
        "except urllib.error.HTTPError as e: print(e.code)\n"
    )
    return int(run_in(service, ".venv/bin/python", "-c", script, path, token or "").stdout.strip())


SIGNED_CALL = """
import sys, urllib.request, urllib.error
from app import tokens
role, act, path, mode, sid = sys.argv[1:6]
if mode == "cp-as-red":  # the control plane: a genuine grant, but it can sign only with its own key
    from app import credentials
    grant = credentials.issue_grant("red", sid, [act])
    _, key = tokens.private_key("BAYORA_CP_SIGNING_KEY")
    kid = next(iter(tokens.public_keys("BAYORA_RED_PUBLIC_KEYS")))  # claims Red's key id
else:  # an agent minting its own grant with its own key
    kid, key = tokens.private_key(f"BAYORA_{role.upper()}_SIGNING_KEY")
    grant = tokens.sign({"typ": "grant", "role": role, "sid": sid, "act": [act], **tokens.lifetime(60)}, kid, key)
claims = {"typ": "req", "role": role, "act": act, "sid": sid, "req": {}, "grant": grant, "jti": tokens.new_id()}
token = tokens.sign({**claims, **tokens.lifetime(30)}, kid, key)
req = urllib.request.Request("http://backend:8000" + path, headers={"Authorization": "Bayora-Signed " + token})
try: print(urllib.request.urlopen(req, timeout=5).status)
except urllib.error.HTTPError as e: print(e.code)
"""


def signed_call(service: str, role: str, act: str, path: str, grant_kind: str = "self") -> int:
    result = run_in(service, ".venv/bin/python", "-c", SIGNED_CALL, role, act, path, grant_kind, SENTINEL)
    assert result.returncode == 0, result.stderr
    return int(result.stdout.strip())


def test_role_credentials_are_scoped_from_inside_each_container():
    attempts = f"/api/red/sessions/{SENTINEL}/attempts"
    # Static role tokens are no longer accepted, even the values an older .env still holds.
    assert call_from("red-agent", attempts, LEGACY_RED) == 401
    assert call_from("blue-agent", "/api/attacks", LEGACY_BLUE) == 401
    # An agent's own key is not enough: it cannot mint the control-plane grant.
    assert signed_call("red-agent", "red", "red:read", attempts) == 401
    assert signed_call("red-agent", "red", "blue:read", f"/api/blue/sessions/{SENTINEL}/findings") == 403
    assert signed_call("blue-agent", "blue", "blue:read", f"/api/blue/sessions/{SENTINEL}/findings") == 401
    assert call_from("target", "/api/attacks", None) == 401  # the target holds no credential at all
    assert call_from("target", "/api/audit", "forged-token-value-0000000000") == 401


def test_control_plane_cannot_act_as_a_signed_role():
    # It holds a genuine grant key but not Red's private key, so a request it signs as Red is refused.
    attempts = f"/api/red/sessions/{SENTINEL}/attempts"
    assert signed_call("backend", "red", "red:read", attempts, "cp-as-red") == 401


DB_PROBE = """
import sys, psycopg
with psycopg.connect(__import__("os").environ["DATABASE_URL"], autocommit=True) as conn:
    print(conn.execute("SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user").fetchone())
    for statement in sys.argv[1:]:
        try:
            conn.execute(statement); print("allowed")
        except psycopg.Error as exc:
            print("refused:" + type(exc).__name__)
"""


def test_runtime_database_role_has_exact_grants_and_cannot_rewrite_audit():
    rows = run_in(
        "db",
        "psql",
        "-U",
        "bayora",
        "-d",
        "bayora",
        "-Atc",
        "SELECT table_name, privilege_type FROM information_schema.role_table_grants "
        "WHERE grantee = 'bayora_app' AND table_schema = 'public'",
    ).stdout.split()
    grants: dict[str, set[str]] = {}
    for row in rows:
        table, privilege = row.split("|")
        grants.setdefault(table, set()).add(privilege)
    assert grants == APP_GRANTS

    statements = [
        "UPDATE audit_events SET details = '{}' WHERE seq = 1",
        "DELETE FROM audit_events WHERE seq = 1",
        "TRUNCATE audit_events",
        "DELETE FROM sessions",
        "CREATE TABLE sneaky (id int)",
        "ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only",
    ]
    lines = run_in("backend", ".venv/bin/python", "-c", DB_PROBE, *statements).stdout.splitlines()
    assert lines[0] == "('bayora_app', False)"
    assert lines[1:] == ["refused:InsufficientPrivilege"] * len(statements), lines


def test_full_run_with_isolated_agents_and_checkpoint():
    run = run_full()
    report = run["run"]["report"]
    residual = {c["attack_id"]: c["residual_risk"] for c in report["cases"]}
    assert residual == {
        "BN-00": "none",
        "PI-01": "low",
        "JB-02": "medium",
        "OB-03": "high",
        "II-04": "low",
        "PS-05": "high",
        "PR-06": "none",
    }
    assert report["deployment"]["roles"] == {"red": "agent", "blue": "agent", "target": "agent"}
    checks = {c["check_id"]: c for c in run["run"]["isolation"]}
    assert checks["ISO-01"]["status"] == "pass" and "forged credentials refused" in checks["ISO-01"]["detail"]
    assert (checks["ISO-06"]["kind"], checks["ISO-06"]["status"]) == ("network", "pass")
    assert (checks["ISO-07"]["kind"], checks["ISO-07"]["status"]) == ("configured", "pass")
    assert checks["ISO-08"]["status"] == "pass"
    status, result = http("GET", "/api/audit/verify")
    assert status == 200
    assert result["ok"] is True and result["checkpoint"]["status"] == "ok"
    assert result["checkpoint"]["unanchored_events"] == 0
    assert result["role_events"]["unsigned"] == 0 and result["role_events"]["signed"] > 0
    status, controls = http("GET", "/api/meta")
    by_name = {c["name"]: c["status"] for c in controls["controls"]}
    assert by_name["Database least privilege"] == "implemented"
    assert by_name["Signed, short-lived role credentials"] == "implemented"


# ---------------------------------------------------------------- failure handling (mutates the test stack)


def wait_until_healthy(service: str) -> None:
    for _ in range(40):
        if (
            run_in(
                service,
                ".venv/bin/python",
                "-c",
                "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=1)",
            ).returncode
            == 0
        ):
            return
        time.sleep(0.5)
    raise AssertionError(f"{service} did not become healthy")


def test_stopped_blue_agent_fails_closed_then_recovers():
    status, run = http("POST", "/api/runs", {"attack_ids": ["PI-01"]})
    sid = run["id"]
    for _ in range(3):
        assert http("POST", f"/api/runs/{sid}/advance")[0] == 200
    compose("stop", "blue-agent")
    try:
        status, body = http("POST", f"/api/runs/{sid}/advance")
        assert status == 502, body
        detail = http("GET", f"/api/runs/{sid}")[1]
        assert detail["stage"] == "evaluate" and detail["defenses"] == []
    finally:
        compose("start", "blue-agent")
        wait_until_healthy("blue-agent")
    status, body = http("POST", f"/api/runs/{sid}/advance")
    assert status == 200 and body["executed"] == "defend"


def test_witness_outage_is_reported_then_closed():
    status, run = http("POST", "/api/runs", {"attack_ids": ["PI-01"]})
    sid = run["id"]
    compose("stop", "witness")
    try:
        status, body = http("POST", f"/api/runs/{sid}/advance")
        assert status == 200 and body["checkpoint"]["status"] == "failed"
        status, result = http("GET", "/api/audit/verify")
        assert result["ok"] is False and result["checkpoint"]["status"] == "unavailable"
    finally:
        compose("start", "witness")
        wait_until_healthy("witness")
    status, body = http("POST", f"/api/runs/{sid}/advance")
    assert body["checkpoint"]["status"] == "anchored"
    assert http("GET", "/api/audit/verify")[1]["checkpoint"]["unanchored_events"] == 0


REWRITE = """
import json
from app import audit, db
with db.connect() as conn:
    conn.execute("SET session_replication_role = replica")  # owner/superuser only: bypasses the trigger
    events = audit.load(conn)
    for i, event in enumerate(events):
        if i == 1:
            details = json.loads(event["details"]); details["note"] = "rewritten"
            event["details"] = json.dumps(details, sort_keys=True, separators=(",", ":"))
        if i >= 1:
            event["prev_hash"] = events[i - 1]["hash"]
            event["hash"] = audit.event_hash(event)
            conn.execute("UPDATE audit_events SET details = ?, prev_hash = ?, hash = ? WHERE seq = ?",
                         (event["details"], event["prev_hash"], event["hash"], event["seq"]))
    print(audit.verify_events(audit.load(conn))["ok"])  # the hash chain alone
"""


def test_runtime_role_cannot_rewrite_the_chain():
    rewrite = run_in("backend", ".venv/bin/python", "-c", REWRITE)
    assert rewrite.returncode != 0 and "permission denied" in rewrite.stderr, rewrite.stderr


def test_database_owner_rewriting_the_whole_chain_is_detected():
    # The strongest attacker this prototype considers for audit integrity: the database
    # owner (a superuser), run from a one-off migrate container that holds that password.
    rewrite = compose(
        "run", "--rm", "--no-deps", "-T", "migrate", ".venv/bin/python", "-c", REWRITE, check=False
    )
    assert rewrite.stdout.strip().endswith("True"), rewrite.stderr  # locally the forged chain is consistent
    status, result = http("GET", "/api/audit/verify")
    assert status == 200
    assert result["ok"] is False
    assert {e["kind"] for e in result["checkpoint"]["errors"]} == {"checkpoint"}


def recover(*args: str) -> subprocess.CompletedProcess:
    return run_in("witness", ".venv/bin/python", "-m", "witness.recover", *args)


def test_witness_recovery_resumes_anchoring_but_keeps_reporting_the_conflict():
    # Continues from the rewrite above: the witness head no longer matches the chain.
    run = http("POST", "/api/runs", {"attack_ids": ["PI-01"]})[1]
    assert run["checkpoint"]["status"] == "rejected", run["checkpoint"]
    before = json.loads(recover("status").stdout)
    log = http("GET", "/api/audit/verify")[1]["checkpoint"]
    first_bad = min(e["seq"] for e in log["errors"])
    lines = run_in("witness", "cat", "/data/checkpoints.jsonl").stdout.splitlines()
    index = next(json.loads(line)["index"] for line in lines if json.loads(line).get("seq", 0) >= first_bad)

    refused = recover(
        "supersede", "--from-index", str(index), "--expect-head-seq", "1", "--reason", "stale view"
    )
    assert refused.returncode == 1 and "re-check status" in refused.stderr
    done = recover(
        "supersede",
        "--from-index",
        str(index),
        "--expect-head-seq",
        str(before["head"]["seq"]),
        "--reason",
        "compose drill: owner rewrote the chain",
    )
    assert done.returncode == 0, done.stderr
    after_lines = run_in("witness", "cat", "/data/checkpoints.jsonl").stdout.splitlines()
    assert after_lines[: len(lines)] == lines  # nothing removed or rewritten

    body = http("POST", f"/api/runs/{run['id']}/advance")[1]
    assert body["checkpoint"]["status"] == "anchored", body["checkpoint"]
    result = http("GET", "/api/audit/verify")[1]
    assert result["ok"] is False and {e["kind"] for e in result["checkpoint"]["errors"]} == {"superseded"}
    assert result["checkpoint"]["superseded"] and result["checkpoint"]["unanchored_events"] == 0
