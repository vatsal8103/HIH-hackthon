import pytest
from conftest import auth, run_to_completion
from fastapi.testclient import TestClient

from app import auth as auth_module
from app.target import CANARY


def advance(client, sid, times=1):
    for _ in range(times):
        response = client.post(f"/api/runs/{sid}/advance", headers=auth("operator"))
        assert response.status_code == 200, response.text


def test_permission_matrix_matches_policy(client):
    rows = client.post("/api/isolation/matrix", headers=auth("operator")).json()
    assert len(rows) == 40
    assert all(r["ok"] for r in rows), [r for r in rows if not r["ok"]]


def test_cross_role_access_is_denied(client):
    run = run_to_completion(client, ["PI-01"])
    sid = run["id"]

    assert client.get(f"/api/red/sessions/{sid}/attempts", headers=auth("blue")).status_code == 403
    assert (
        client.post(
            f"/api/blue/sessions/{sid}/defenses", json={"rule_id": "persona-lock"}, headers=auth("red")
        ).status_code
        == 403
    )
    assert client.get("/api/audit", headers=auth("target")).status_code == 403
    assert client.get("/api/attacks", headers=auth("blue")).status_code == 403
    assert client.post("/api/runs", json={}, headers=auth("red")).status_code == 403
    assert client.get("/api/runs").status_code == 401
    assert client.get("/api/runs", headers={"Authorization": "Bearer forged"}).status_code == 401


def test_red_cannot_reach_blue_defense_state(client):
    sid = run_to_completion(client, ["PI-01"])["id"]
    for method, path in [
        ("GET", "/api/blue/rules"),
        ("GET", f"/api/blue/sessions/{sid}/findings"),
        ("POST", f"/api/blue/sessions/{sid}/defenses"),
        ("GET", f"/api/runs/{sid}"),  # the operator view includes applied defenses
        ("GET", "/api/audit"),
    ]:
        assert (
            client.request(method, path, json={"rule_id": "persona-lock"}, headers=auth("red")).status_code
            == 403
        )


def test_blue_cannot_reach_red_prompts_or_hidden_state(client):
    sid = run_to_completion(client, ["PI-01"])["id"]
    for path in [
        f"/api/red/sessions/{sid}/attempts",
        "/api/attacks",
        f"/api/runs/{sid}",
        f"/api/target/sessions/{sid}/inbox",
        "/api/audit",
    ]:
        assert client.get(path, headers=auth("blue")).status_code == 403


def test_target_cannot_read_audit_defenses_or_other_sessions(client):
    first = run_to_completion(client, ["PI-01"])["id"]
    for path in [
        "/api/audit",
        "/api/blue/rules",
        f"/api/blue/sessions/{first}/findings",
        "/api/runs",
        "/api/meta",
    ]:
        assert client.get(path, headers=auth("target")).status_code == 403
    # A finished session exposes nothing to the target: it only ever sees prompts awaiting an answer.
    assert client.get(f"/api/target/sessions/{first}/inbox", headers=auth("target")).json() == []


def test_role_views_are_scoped(client):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01", "II-04"]}, headers=auth("operator")).json()
    sid = run["id"]
    advance(client, sid)  # attack: prompts queued for the target
    inbox = client.get(f"/api/target/sessions/{sid}/inbox", headers=auth("target")).json()
    assert len(inbox) == 2
    assert {key for item in inbox for key in item} == {"attempt_id", "phase", "prompt"}

    advance(client, sid, 6)
    prompts = [c["attack"]["prompt"] for c in run["cases"]]
    findings = client.get(f"/api/blue/sessions/{sid}/findings", headers=auth("blue"))
    assert findings.status_code == 200 and findings.json()
    assert not any(p[:40] in findings.text for p in prompts)
    assert CANARY not in findings.text and "PI-01" not in findings.text

    red = client.get(f"/api/red/sessions/{sid}/attempts", headers=auth("red"))
    assert red.status_code == 200
    assert "instruction-guard" not in red.text and "blocked_by" not in red.text
    assert client.get(f"/api/target/sessions/{sid}/inbox", headers=auth("target")).json() == []


@pytest.mark.parametrize(
    "header",
    [
        "",
        "Bearer ",
        "Bearer dev-red-token ",
        "Bearer DEV-RED-TOKEN",
        "bearer dev-red-token",
        "Basic dev-red-token",
        "dev-red-token",
    ],
)
def test_malformed_or_unknown_credentials_are_rejected(client, header):
    assert client.get("/api/red/sessions/x/attempts", headers={"Authorization": header}).status_code == 401


def test_auth_failure_does_not_fall_through_to_the_handler(client, monkeypatch):
    def broken():
        raise RuntimeError("token store unavailable")

    monkeypatch.setattr(auth_module, "static_token", broken)
    from app.main import app

    operator = {"Authorization": "Bearer dev-operator-token"}  # auth() itself reads static_token
    response = TestClient(app, raise_server_exceptions=False).get("/api/attacks", headers=operator)
    assert response.status_code == 500
    assert "PI-01" not in response.text


def test_red_retest_submission_window(client):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    sid = run["id"]
    retest = {"attack_id": "PI-01", "phase": "retest"}
    url = f"/api/red/sessions/{sid}/attempts"
    assert client.post(url, json=retest, headers=auth("red")).status_code == 409  # before any defense
    advance(client, sid, 4)  # attack, respond, evaluate, defend
    assert (
        client.post(url, json={"attack_id": "JB-02", "phase": "retest"}, headers=auth("red")).status_code
        == 409
    )
    assert client.post(url, json=retest, headers=auth("red")).status_code == 201
    assert client.post(url, json=retest, headers=auth("red")).status_code == 409


def docker_like_env() -> dict:
    """A valid Docker configuration: hashes and public keys only, no role secrets."""
    import hashlib

    from app import tokens

    env = {"BAYORA_OPERATOR_TOKEN_SHA256": hashlib.sha256(b"o" * 32).hexdigest()}
    env["BAYORA_CP_SIGNING_KEY"], _ = tokens.generate("cp-1")
    for role in ("RED", "BLUE"):
        env[f"BAYORA_{role}_PUBLIC_KEYS"] = tokens.generate(f"{role.lower()}-1")[1]
    return env


@pytest.mark.parametrize(
    ("change", "ok"),
    [
        ({}, True),
        ({"BAYORA_OPERATOR_TOKEN_SHA256": None}, False),  # hash missing
        ({"BAYORA_OPERATOR_TOKEN_SHA256": "not-a-digest"}, False),
        ({"BAYORA_TOKEN_OPERATOR": "o" * 32}, False),  # control plane must not hold the plaintext
        ({"BAYORA_TOKEN_RED": "r" * 32}, False),  # static token beside signed credentials
        ({"BAYORA_TOKEN_TARGET": "t" * 32}, False),  # the target holds no API credential
        ({"BAYORA_RED_PUBLIC_KEYS": None}, False),
        ({"BAYORA_BLUE_PUBLIC_KEYS": "blue-1:not-base64!"}, False),
        ({"BAYORA_CP_SIGNING_KEY": None}, False),
        ({"BAYORA_WITNESS_URL": "http://witness:8000"}, False),  # witness without a token
    ],
)
def test_required_configuration_refuses_weak_or_excess_credentials(monkeypatch, change, ok):
    names = [
        "BAYORA_OPERATOR_TOKEN_SHA256",
        "BAYORA_CP_SIGNING_KEY",
        "BAYORA_RED_PUBLIC_KEYS",
        "BAYORA_BLUE_PUBLIC_KEYS",
        "BAYORA_WITNESS_URL",
        "BAYORA_WITNESS_TOKEN",
    ]
    names += [f"BAYORA_TOKEN_{role}" for role in ("OPERATOR", "RED", "BLUE", "TARGET")]
    for name in names:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BAYORA_REQUIRE_TOKENS", "1")
    for key, value in {**docker_like_env(), **change}.items():
        if value is not None:
            monkeypatch.setenv(key, value)
    if ok:
        auth_module.validate_tokens()
    else:
        with pytest.raises(RuntimeError):
            auth_module.validate_tokens()
