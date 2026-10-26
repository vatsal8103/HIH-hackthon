"""Unit and negative tests for Phase 1: Real Process Isolation Without Docker.

Tests:
1. Isolated directory creation and per-role key segregation (Target holds NO signing key).
2. Agent rejects requests signed with another role's private key (Negative test).
3. Target rejects prompts without a valid grant, or with a forged/cross-role grant (Negative test).
4. Stage fails loudly with RemoteError when an agent is unreachable / killed (Negative test).
5. Deployment metadata reports BAYORA_MODE="local-process".
"""

import httpx
from conftest import AGENT_URLS, auth
from fastapi.testclient import TestClient

from agents import red_agent, target_agent
from app import credentials, local_setup, remote

SENTINEL = "00000000-0000-0000-0000-000000000000"


def test_setup_provisions_isolated_per_role_secrets(tmp_path):
    dirs = local_setup.setup_local_env(tmp_path)
    assert set(dirs.keys()) == {"cp", "red", "blue", "target", "witness", "frontend"}

    # Target directory must NOT hold any private signing key
    target_env = (dirs["target"] / "env").read_text(encoding="utf-8")
    assert "SIGNING_KEY" not in target_env
    assert "BAYORA_CP_PUBLIC_KEYS" in target_env

    # Red and Blue must each hold ONLY their own signing key
    red_env = (dirs["red"] / "env").read_text(encoding="utf-8")
    assert "BAYORA_RED_SIGNING_KEY" in red_env
    assert "BAYORA_BLUE_SIGNING_KEY" not in red_env

    blue_env = (dirs["blue"] / "env").read_text(encoding="utf-8")
    assert "BAYORA_BLUE_SIGNING_KEY" in blue_env
    assert "BAYORA_RED_SIGNING_KEY" not in blue_env


def test_agent_rejects_cross_role_grant_and_keys(agents):
    """Negative test: Red agent rejects a dispatch accompanied by a Blue grant."""
    client = TestClient(red_agent.app)

    # Issue a grant for Blue
    blue_grant = credentials.issue_grant("blue", SENTINEL, ["red:read", "red:submit"])

    # Attempt to call Red with Blue's grant
    res = client.post(
        "/v1/act",
        json={
            "session_id": SENTINEL,
            "attack_ids": ["PI-01"],
            "phase": "baseline",
            "grant": blue_grant,
        },
    )
    assert res.status_code == 401
    assert "grant is for another role" in res.json()["detail"]


def test_target_rejects_dispatch_without_valid_grant(agents):
    """Negative test: Target model rejects prompts without a valid grant or with a forged grant."""
    client = TestClient(target_agent.app)

    # 1. No grant
    res_no_grant = client.post(
        "/v1/respond",
        json={"prompt": "Hello", "session_id": SENTINEL, "grant": "invalid-token"},
    )
    assert res_no_grant.status_code == 401
    assert "Rejected dispatch" in res_no_grant.json()["detail"]

    # 2. Grant issued for Red, not Target
    red_grant = credentials.issue_grant("red", SENTINEL, ["target:respond"])
    res_cross = client.post(
        "/v1/respond",
        json={"prompt": "Hello", "session_id": SENTINEL, "grant": red_grant},
    )
    assert res_cross.status_code == 401
    assert "grant is for another role" in res_cross.json()["detail"]

    # 3. Valid Target grant succeeds
    valid_grant = credentials.issue_grant("target", SENTINEL, ["target:respond"])
    res_ok = client.post(
        "/v1/respond",
        json={"prompt": "Hello clinic assistant", "session_id": SENTINEL, "grant": valid_grant},
    )
    assert res_ok.status_code == 200
    assert "response" in res_ok.json()
    assert res_ok.json()["kind"] == "simulated"


def test_killed_agent_causes_stage_to_fail_loudly(agents, client, monkeypatch):
    """Negative test: When an agent is unreachable / killed, stage fails loudly with 502 RemoteError."""
    res = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator"))
    assert res.status_code == 201
    session_id = res.json()["id"]

    # Advance to attack stage (calls red agent)
    adv_attack = client.post(f"/api/runs/{session_id}/advance", headers=auth("operator"))
    assert adv_attack.status_code == 200
    assert adv_attack.json()["executed"] == "attack"

    # Simulate killing the target agent by making its URL refuse connections
    target_url = AGENT_URLS["target"]

    def refuse(request):
        raise httpx.ConnectError("Connection refused: target agent down", request=request)

    monkeypatch.setitem(
        remote.OVERRIDES, target_url, httpx.Client(transport=httpx.MockTransport(refuse), base_url=target_url)
    )

    # Next stage is 'respond': calls target agent. Must fail loudly with 502 (Role service failure)
    # and NEVER fall back to in-process execution!
    adv_respond = client.post(f"/api/runs/{session_id}/advance", headers=auth("operator"))
    assert adv_respond.status_code == 502
    assert "Role service failure" in adv_respond.json()["detail"]
    assert "target agent:" in adv_respond.json()["detail"] or "unreachable" in adv_respond.json()["detail"]

    # Verify session stage did NOT advance and remained 'attack'
    session_res = client.get(f"/api/runs/{session_id}", headers=auth("operator"))
    assert session_res.json()["stage"] == "attack"


def test_deployment_mode_reporting(client, monkeypatch):
    """Verify BAYORA_MODE='local-process' is properly reported in /api/meta."""
    monkeypatch.setenv("BAYORA_MODE", "local-process")
    res = client.get("/api/meta", headers=auth("operator")).json()
    assert res["deployment"]["mode"] == "local-process"
