"""Agent mode: Red, Blue and Target run behind their own interfaces (in-process here).

These tests cover the control plane's wiring, data minimisation and failure handling.
They do not prove network isolation; tests_compose/ measures that against real containers.
"""

import httpx
from conftest import AGENT_URLS, SEGMENTED, auth, fake_network, run_to_completion
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_workflow import EXPECTED_RESIDUAL

from agents import blue_agent, common
from app import defenses, remote
from app.attacks import ATTACKS
from app.target import CANARY

FINDING_FIELDS = {
    "finding_id",
    "phase",
    "criterion",
    "criterion_title",
    "severity",
    "evidence",
    "response_excerpt",
}


def test_agent_mode_reproduces_the_deterministic_outcome(agents, client):
    run = run_to_completion(client)
    report = run["report"]

    assert {c["attack_id"]: c["residual_risk"] for c in report["cases"]} == EXPECTED_RESIDUAL
    assert report["deployment"]["roles"] == {"red": "agent", "blue": "agent", "target": "agent"}
    assert report["deployment"]["target_provider"] == "bayora-simulator/rules-v1"
    checks = {c["check_id"]: c for c in run["isolation"]}
    assert (checks["ISO-06"]["kind"], checks["ISO-06"]["status"]) == ("network", "pass")
    assert (checks["ISO-07"]["kind"], checks["ISO-07"]["status"]) == ("configured", "pass")

    events = client.get("/api/audit?limit=1000", headers=auth("operator")).json()
    reads = [e for e in events if e["event_type"] == "blue.findings_read"]
    assert reads and all(e["details"]["via"] == "api" for e in reads)  # read through the Blue API
    responses = [e for e in events if e["event_type"].startswith("target.")]
    assert all(e["details"]["target_runtime"] == "agent" for e in responses)


def test_each_agent_only_uses_and_sees_its_own_interface(agents, client, monkeypatch):
    calls = []
    original = common.api

    def recording(method, path, token, json=None):
        body = original(method, path, token, json)
        calls.append((token, path, str(body)))
        return body

    monkeypatch.setattr(common, "api", recording)
    run_to_completion(client)

    prompts = [a["prompt"][:40] for a in ATTACKS]
    red_token, blue_token = auth("red")["Authorization"][7:], auth("blue")["Authorization"][7:]
    assert {token for token, _, _ in calls} == {red_token, blue_token}
    assert all(path.startswith("/api/red/") for token, path, _ in calls if token == red_token)
    blue_calls = [(path, body) for token, path, body in calls if token == blue_token]
    assert blue_calls and all(path.startswith("/api/blue/") for path, _ in blue_calls)
    for _, body in blue_calls:
        assert CANARY not in body
        assert not any(prompt in body for prompt in prompts)


def test_blue_agent_receives_only_redacted_fields(agents, client):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01", "II-04"]}, headers=auth("operator")).json()
    for _ in range(3):  # attack, respond, evaluate
        client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
    reply = TestClient(blue_agent.app).post("/v1/act", json={"session_id": run["id"]}).json()
    assert set(reply["fields_seen"]) <= FINDING_FIELDS
    assert reply["applied"]


def test_target_agent_receives_guarded_prompt_text_only(agents, client, monkeypatch):
    seen = []
    provider = agents["target"].provider
    monkeypatch.setattr(
        provider, "respond", lambda prompt: seen.append(prompt) or type(provider)().respond(prompt)
    )
    run_to_completion(client, ["II-04", "PI-01"])

    assert seen, "target agent was never called"
    assert not any(a["id"] in prompt for prompt in seen for a in ATTACKS)
    # On retest the fence removed the hidden instruction before the target saw it,
    # and the instruction guard blocked PI-01 so it never reached the target at all.
    assert sum("<!--" in prompt for prompt in seen) == 1
    assert sum("Ignore previous instructions" in prompt for prompt in seen) == 1
    extra = TestClient(agents["target"].app).post("/v1/respond", json={"prompt": "hi", "attack_id": "PI-01"})
    assert extra.status_code == 422


def unreachable_client():
    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    return httpx.Client(transport=httpx.MockTransport(refuse), base_url="http://down.test")


def test_unreachable_blue_agent_fails_the_stage_without_fallback(agents, client, monkeypatch):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    sid = run["id"]
    for _ in range(3):
        client.post(f"/api/runs/{sid}/advance", headers=auth("operator"))
    monkeypatch.setitem(remote.OVERRIDES, AGENT_URLS["blue"], unreachable_client())

    response = client.post(f"/api/runs/{sid}/advance", headers=auth("operator"))
    assert response.status_code == 502
    detail = client.get(f"/api/runs/{sid}", headers=auth("operator")).json()
    assert detail["stage"] == "evaluate" and detail["defenses"] == []

    monkeypatch.setitem(remote.OVERRIDES, AGENT_URLS["blue"], TestClient(blue_agent.app))
    assert client.post(f"/api/runs/{sid}/advance", headers=auth("operator")).json()["executed"] == "defend"


def test_red_agent_that_does_not_submit_is_caught(agents, client, monkeypatch):
    lazy = FastAPI()
    lazy.post("/v1/act")(lambda: {"submitted": []})
    monkeypatch.setitem(remote.OVERRIDES, AGENT_URLS["red"], TestClient(lazy))
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()

    response = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
    assert response.status_code == 502
    assert "did not submit" in response.json()["detail"]


def test_malformed_target_reply_is_rejected(agents, client, monkeypatch):
    odd = FastAPI()
    odd.post("/v1/respond")(lambda: {"response": 42})
    monkeypatch.setitem(remote.OVERRIDES, AGENT_URLS["target"], TestClient(odd))
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))

    response = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
    assert response.status_code == 502
    detail = client.get(f"/api/runs/{run['id']}", headers=auth("operator")).json()
    assert detail["stage"] == "attack" and detail["cases"][0]["baseline"]["response"] is None


def test_network_policy_violation_fails_the_check(agents, client, monkeypatch):
    monkeypatch.setattr(common, "connect", fake_network({**SEGMENTED, "blue-agent": "connected"}))
    checks = {c["check_id"]: c for c in run_to_completion(client, ["PI-01"])["isolation"]}
    assert checks["ISO-06"]["status"] == "fail"
    assert "blue-agent reachable" in checks["ISO-06"]["detail"]


def test_root_container_fails_the_controls_check(agents, client, monkeypatch):
    from conftest import LINUX_HARDENED

    monkeypatch.setattr(
        common, "process_security", lambda: {**LINUX_HARDENED, "uid": 0, "cap_eff": "00000000a80425fb"}
    )
    checks = {c["check_id"]: c for c in run_to_completion(client, ["PI-01"])["isolation"]}
    assert checks["ISO-07"]["status"] == "fail"
    assert "runs as root" in checks["ISO-07"]["detail"]


def test_blue_agent_playbook_matches_in_process_playbook():
    assert blue_agent.PLAYBOOK == defenses.PLAYBOOK
