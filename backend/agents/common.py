"""Shared helpers for the isolated role agents.

Agents talk to the control plane only through their role-scoped API. Each request is
signed with the agent's own Ed25519 key (which only this agent holds) and embeds the
short-lived grant the control plane sent with the dispatch. Agents hold no database
credentials, no other role's key and no static API token.
"""

import errno
import os
import socket
from pathlib import Path

import httpx
from fastapi import HTTPException

from app import tokens

# Tests route the API base URL to an in-process app (an httpx.Client such as TestClient).
OVERRIDES: dict[str, httpx.Client] = {}

GRANT_TTL = 120
REQUEST_TTL = 60
SENTINEL = "00000000-0000-0000-0000-000000000000"  # a session that never exists

# Fixed probe targets (compose service names). Agents never probe caller-supplied hosts.
PROBE_TARGETS = [
    ("control-plane", "backend", 8000),
    ("database", "db", 5432),
    ("red-agent", "red-agent", 8000),
    ("blue-agent", "blue-agent", 8000),
    ("target", "target", 8000),
    ("witness", "witness", 8000),
    ("egress", "192.0.2.1", 80),  # TEST-NET-1 (RFC 5737): never a real host
]

# The permission self-probe: every protected resource, always against SENTINEL, so an
# allowed request ends in 404 and nothing is ever written. Mirrors app.isolation.RESOURCES.
PERMISSION_PROBES = [
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


def api_url() -> str:
    return os.environ.get("BAYORA_API_URL", "http://backend:8000")


def check_grant(grant: str, role: str, session_id: str, needed: set[str]) -> None:
    """Accept a dispatch only with a valid control-plane grant for this role, session and actions."""
    try:
        claims = tokens.verify(grant, tokens.public_keys("BAYORA_CP_PUBLIC_KEYS"))
        if claims.get("typ") != "grant" or claims.get("role") != role or claims.get("sid") != session_id:
            raise tokens.TokenError("grant is for another role or session")
        if not needed <= set(claims.get("act", [])):
            raise tokens.TokenError("grant does not cover the requested actions")
        tokens.check_lifetime(claims, GRANT_TTL)
    except tokens.TokenError as exc:
        raise HTTPException(401, f"Rejected dispatch: {exc}") from exc


def _signed_request(role: str, act: str, session_id: str | None, params: dict, grant: str) -> str:
    kid, key = tokens.private_key(f"BAYORA_{role.upper()}_SIGNING_KEY")
    claims = {"typ": "req", "role": role, "act": act, "sid": session_id, "req": params, "grant": grant}
    return tokens.sign({**claims, **tokens.lifetime(REQUEST_TTL), "jti": tokens.new_id()}, kid, key)


def _send(method: str, path: str, headers: dict, json=None) -> httpx.Response:
    base = api_url()
    try:
        if base in OVERRIDES:
            return OVERRIDES[base].request(method, path, json=json, headers=headers)
        with httpx.Client(base_url=base, timeout=10) as client:
            return client.request(method, path, json=json, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"control plane unreachable ({exc.__class__.__name__})") from exc


def api(method: str, path: str, role: str, act: str, session_id: str, grant: str, json=None):
    """Call the control plane as this role. Any failure becomes a 502 so the calling stage fails loudly."""
    token = _signed_request(role, act, session_id, json or {}, grant)
    response = _send(method, path, {"Authorization": f"Bayora-Signed {token}"}, json)
    if response.status_code >= 400:
        raise HTTPException(502, f"control plane answered {response.status_code} for {method} {path}")
    return response.json()


def permission_probe(role: str, grant: str) -> list[dict]:
    """Status of each protected resource for this role's real credential, on SENTINEL only."""
    rows = []
    for name, method, template, body, permission in PERMISSION_PROBES:
        session_id = SENTINEL if "{sid}" in template else None
        token = _signed_request(role, permission, session_id, body or {}, grant)
        response = _send(
            method, template.format(sid=SENTINEL), {"Authorization": f"Bayora-Signed {token}"}, body
        )
        rows.append({"resource": name, "status": response.status_code})
    return rows


def connect(host: str, port: int, timeout: float = 1.5) -> str:
    """TCP reachability outcome: connected, refused (path exists), dns, unreachable or timeout."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return "connected"
    except socket.gaierror:
        return "dns"
    except ConnectionRefusedError:
        return "refused"
    except TimeoutError:
        return "timeout"
    except OSError as exc:
        return "unreachable" if exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH) else f"error:{exc.errno}"


def process_security() -> dict:
    """Controls observed from inside this process. Linux only; elsewhere reported as unsupported."""
    status_file = Path("/proc/self/status")
    if not status_file.exists():
        return {"supported": False}
    fields = dict(line.split(":", 1) for line in status_file.read_text().splitlines() if ":" in line)
    probe = Path("/.bayora-write-probe")
    try:
        probe.write_text("x")
        probe.unlink()
        read_only = False
    except OSError:
        read_only = True
    return {
        "supported": True,
        "uid": os.getuid(),
        "cap_eff": fields.get("CapEff", "").strip(),
        "no_new_privs": fields.get("NoNewPrivs", "").strip() == "1",
        "rootfs_read_only": read_only,
        "docker_socket": Path("/var/run/docker.sock").exists(),
    }


def probe(self_name: str, role: str | None = None, grant: str | None = None) -> dict:
    reach = [
        {"name": name, "host": host, "port": port, "outcome": connect(host, port)}
        for name, host, port in PROBE_TARGETS
        if name != self_name
    ]
    report = {"agent": self_name, "reachability": reach, "security": process_security()}
    if role and grant:
        report["permissions"] = permission_probe(role, grant)
    return report
