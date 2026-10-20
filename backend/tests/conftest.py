import os

import pytest
from fastapi.testclient import TestClient

from app import remote
from app.auth import role_tokens

API_URL = "http://api.test"
WITNESS_URL = "http://witness.test"
WITNESS_TOKEN = "w" * 32
AGENT_URLS = {
    "red": "http://red-agent.test",
    "blue": "http://blue-agent.test",
    "target": "http://target.test",
}

# Outcomes a correctly segmented Docker stack produces, for unit tests of the control
# plane's policy evaluation. Real reachability is measured in tests_compose/ only.
SEGMENTED = {"control-plane": "connected", "egress": "unreachable"}
LINUX_HARDENED = {
    "supported": True,
    "uid": 10001,
    "cap_eff": "0000000000000000",
    "no_new_privs": True,
    "rootfs_read_only": True,
    "docker_socket": False,
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    # TEST_DATABASE_URL runs the suite against PostgreSQL; tables are emptied first.
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        monkeypatch.setenv("DATABASE_URL", url)
        from app import db

        db.init_db()
        with db.connect() as conn:
            for table in ("audit_events", "isolation_checks", "defenses", "attempts", "sessions"):
                conn.execute(f"DELETE FROM {table}")
    else:
        monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def auth(role: str) -> dict:
    return {"Authorization": f"Bearer {role_tokens()[role]}"}


def run_to_completion(client, attack_ids=None) -> dict:
    body = {} if attack_ids is None else {"attack_ids": attack_ids}
    run = client.post("/api/runs", json=body, headers=auth("operator")).json()
    executed = []
    while run["next_stage"]:
        response = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
        assert response.status_code == 200, response.text
        executed.append(response.json()["executed"])
        run = response.json()["run"]
    run["executed"] = executed
    return run


@pytest.fixture
def witness(tmp_path, monkeypatch):
    """The witness app in-process with its own data dir. Tests its logic, not its isolation."""
    from witness.app import app as witness_app

    monkeypatch.setenv("BAYORA_WITNESS_DATA", str(tmp_path / "witness"))
    monkeypatch.setenv("BAYORA_WITNESS_TOKEN", WITNESS_TOKEN)
    monkeypatch.setenv("BAYORA_WITNESS_URL", WITNESS_URL)
    witness_client = TestClient(witness_app, base_url=WITNESS_URL)
    monkeypatch.setitem(remote.OVERRIDES, WITNESS_URL, witness_client)
    return witness_client


def fake_network(outcomes: dict):
    """A stand-in for agents.common.connect that answers from a table keyed by service name."""
    from agents import common

    names = {host: name for name, host, _ in common.PROBE_TARGETS}
    return lambda host, port, timeout=1.5: outcomes.get(names[host], "dns")


@pytest.fixture
def agents(client, monkeypatch):
    """Role agents in-process, wired like the Docker stack: control plane → agent → role API."""
    from agents import blue_agent, common, red_agent, target_agent
    from app.main import app

    monkeypatch.setenv("BAYORA_API_URL", API_URL)
    monkeypatch.setenv("BAYORA_TOKEN_RED", role_tokens()["red"])
    monkeypatch.setenv("BAYORA_TOKEN_BLUE", role_tokens()["blue"])
    # Keyed by API_URL, but sent with TestClient's default Host, which the API allowlists.
    monkeypatch.setitem(common.OVERRIDES, API_URL, TestClient(app))
    monkeypatch.setattr(common, "connect", fake_network(SEGMENTED))
    monkeypatch.setattr(common, "process_security", lambda: LINUX_HARDENED)
    modules = {"red": red_agent, "blue": blue_agent, "target": target_agent}
    for role, url in AGENT_URLS.items():
        monkeypatch.setenv(remote.AGENT_ENV[role], url)
        monkeypatch.setitem(remote.OVERRIDES, url, TestClient(modules[role].app, base_url=url))
    return modules
