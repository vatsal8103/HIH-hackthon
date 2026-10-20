"""Shared helpers for the isolated role agents.

Agents talk to the control plane only through their role-scoped API, with only their
own role token. They hold no database credentials and no other role's token.
"""

import errno
import os
import socket
from pathlib import Path

import httpx
from fastapi import HTTPException

# Tests route the API base URL to an in-process app (an httpx.Client such as TestClient).
OVERRIDES: dict[str, httpx.Client] = {}

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


def api_url() -> str:
    return os.environ.get("BAYORA_API_URL", "http://backend:8000")


def role_token(role: str) -> str:
    token = os.environ.get(f"BAYORA_TOKEN_{role.upper()}", "")
    if not token:
        raise RuntimeError(f"BAYORA_TOKEN_{role.upper()} must be set for the {role} agent")
    return token


def api(method: str, path: str, token: str, json=None):
    """Call the control plane. Any failure becomes a 502 so the calling stage fails loudly."""
    headers = {"Authorization": f"Bearer {token}"}
    base = api_url()
    try:
        if base in OVERRIDES:
            response = OVERRIDES[base].request(method, path, json=json, headers=headers)
        else:
            with httpx.Client(base_url=base, timeout=10) as client:
                response = client.request(method, path, json=json, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"control plane unreachable ({exc.__class__.__name__})") from exc
    if response.status_code >= 400:
        raise HTTPException(502, f"control plane answered {response.status_code} for {method} {path}")
    return response.json()


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


def probe(self_name: str) -> dict:
    reach = [
        {"name": name, "host": host, "port": port, "outcome": connect(host, port)}
        for name, host, port in PROBE_TARGETS
        if name != self_name
    ]
    return {"agent": self_name, "reachability": reach, "security": process_security()}
