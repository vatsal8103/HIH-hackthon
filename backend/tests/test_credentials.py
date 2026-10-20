"""Signed, short-lived role credentials (privilege reduction milestone).

Keys are placed as in Docker: the control plane has its own signing key and only the
public keys of Red and Blue; each agent has its own private key. In these tests all of
that lives in one process, so they prove the verification rules, not key separation;
tests_compose/ checks which container holds which key.
"""

import json
import time

import pytest
from conftest import auth, run_to_completion
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from agents import red_agent, target_agent
from app import audit, credentials, db, tokens

SENTINEL = "00000000-0000-0000-0000-000000000000"


def red_token(
    session_id, act="red:read", req=None, grant=None, ttl=30, issued=None, key=None, kid=None, **extra
):
    real_kid, real_key = tokens.private_key("BAYORA_RED_SIGNING_KEY")
    grant = grant or credentials.issue_grant("red", session_id, ["red:read", "red:submit"])
    now = int(time.time()) if issued is None else issued
    claims = {
        "typ": "req",
        "role": "red",
        "act": act,
        "sid": session_id,
        "req": req or {},
        "grant": grant,
        "iat": now,
        "exp": now + ttl,
        "jti": tokens.new_id(),
        **extra,
    }
    return tokens.sign(claims, kid or real_kid, key or real_key)


def signed(token):
    return {"Authorization": f"Bayora-Signed {token}"}


@pytest.fixture
def session(agents, client):
    return client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()["id"]


def attempts(client, sid, token):
    return client.get(f"/api/red/sessions/{sid}/attempts", headers=signed(token))


def test_valid_signed_request_is_accepted_once(client, session):
    token = red_token(session)
    assert attempts(client, session, token).status_code == 200
    assert attempts(client, session, token).status_code == 401  # replay


@pytest.mark.parametrize(
    "variant",
    [
        "forged",
        "expired",
        "too_long",
        "future",
        "other_session",
        "wrong_action",
        "foreign_grant",
        "grant_other_session",
        "grant_missing_action",
        "params",
    ],
)
def test_out_of_scope_or_forged_credentials_are_refused(client, session, variant):
    now = int(time.time())
    kwargs = {
        "forged": {
            "key": Ed25519PrivateKey.generate()
        },  # same kid, wrong key: what the control plane could do
        "expired": {"issued": now - 120, "ttl": 60},
        "too_long": {"ttl": 3600},
        "future": {"issued": now + 600},
        "other_session": {},
        "wrong_action": {"act": "red:submit"},
        "foreign_grant": {
            "grant": tokens.sign(
                {"typ": "grant", "role": "red", "sid": session, "act": ["red:read"], **tokens.lifetime(60)},
                "cp-test",
                Ed25519PrivateKey.generate(),
            )
        },
        "grant_other_session": {"grant": credentials.issue_grant("red", SENTINEL, ["red:read"])},
        "grant_missing_action": {"grant": credentials.issue_grant("red", session, ["red:submit"])},
        "params": {"req": {"attack_id": "PI-01"}},
    }[variant]
    sid = SENTINEL if variant == "other_session" else session
    response = attempts(client, session, red_token(sid, **kwargs))
    assert response.status_code == 401, response.text


def test_signed_role_cannot_use_another_roles_routes(client, session):
    token = red_token(session, act="blue:read")
    assert client.get(f"/api/blue/sessions/{session}/findings", headers=signed(token)).status_code == 403


def test_static_tokens_are_refused_for_signed_roles(client, session):
    assert (
        client.get(
            f"/api/red/sessions/{session}/attempts", headers={"Authorization": "Bearer dev-red-token"}
        ).status_code
        == 401
    )


def test_a_grant_alone_is_not_a_role_credential(client, session):
    grant = credentials.issue_grant("red", session, ["red:read"])
    assert attempts(client, session, grant).status_code == 401


def test_revocation_takes_effect_immediately_and_is_audited(client, session):
    kid, _ = tokens.private_key("BAYORA_RED_SIGNING_KEY")
    assert attempts(client, session, red_token(session)).status_code == 200
    reply = client.post(
        "/api/credentials/revocations",
        json={"kid": kid, "reason": "suspected compromise"},
        headers=auth("operator"),
    )
    assert reply.status_code == 201
    assert attempts(client, session, red_token(session)).status_code == 401
    assert (
        client.post(
            "/api/credentials/revocations", json={"kid": kid, "reason": "again"}, headers=auth("operator")
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/credentials/revocations",
            json={"kid": "nope", "reason": "unknown"},
            headers=auth("operator"),
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/credentials/revocations", json={"kid": kid, "reason": "x y z"}, headers=auth("red")
        ).status_code
        == 401
    )
    listing = client.get("/api/credentials", headers=auth("operator")).json()
    assert [r["kid"] for r in listing["revoked"]] == [kid]
    events = client.get("/api/audit?limit=1000", headers=auth("operator")).json()
    assert any(e["event_type"] == "credential.revoked" and e["details"]["kid"] == kid for e in events)


def test_agents_refuse_dispatches_without_a_valid_grant(agents, client, session):
    red = TestClient(red_agent.app)
    body = {"session_id": session, "attack_ids": ["PI-01"], "phase": "baseline"}
    assert (
        red.post(
            "/v1/act",
            json={**body, "grant": credentials.issue_grant("red", SENTINEL, ["red:read", "red:submit"])},
        ).status_code
        == 401
    )
    assert (
        red.post(
            "/v1/act",
            json={**body, "grant": credentials.issue_grant("blue", session, ["red:read", "red:submit"])},
        ).status_code
        == 401
    )
    assert red.post("/v1/act", json={**body, "grant": "garbage"}).status_code == 401
    target = TestClient(target_agent.app)
    prompt = {"prompt": "hello", "session_id": session}
    assert (
        target.post(
            "/v1/respond",
            json={**prompt, "grant": credentials.issue_grant("red", session, ["target:respond"])},
        ).status_code
        == 401
    )
    assert target.post("/v1/respond", json=prompt).status_code == 422


def test_full_agent_run_records_only_signed_role_actions(agents, client):
    run = run_to_completion(client)
    result = client.get("/api/audit/verify", headers=auth("operator")).json()
    assert result["ok"] is True
    # 7 baseline + 7 retest submissions, 3 defenses, 1 findings read: all signed by the role.
    assert result["role_events"] == {"signed": 18, "unsigned": 0}
    checks = {c["check_id"]: c for c in run["isolation"]}
    assert (
        checks["ISO-01"]["status"] == "pass" and "2 forged credentials refused" in checks["ISO-01"]["detail"]
    )


def test_matrix_uses_only_credentials_the_control_plane_may_hold(agents, client):
    rows = client.post("/api/isolation/matrix", headers=auth("operator")).json()
    by_role = {r["role"]: r["credential"] for r in rows}
    assert by_role == {
        "operator": "held",
        "red": "agent-signed",
        "blue": "agent-signed",
        "target": "held",
        "anonymous": "none",
    }
    assert all(r["ok"] for r in rows), [r for r in rows if not r["ok"]]


def test_tampered_or_unsigned_role_evidence_fails_verification(agents, client):
    run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        # What a compromised control plane could do with database access: append a Red action itself.
        audit.append(
            conn,
            None,
            "red",
            "red.baseline_submitted",
            "attempt:none",
            {"attack_id": "JB-02", "phase": "baseline"},
        )
    errors = client.get("/api/audit/verify", headers=auth("operator")).json()["errors"]
    assert any(e["kind"] == "credential" and "Unsigned role event" in e["message"] for e in errors)

    with db.connect() as conn:
        event = conn.one(
            "SELECT session_id, details FROM audit_events WHERE event_type = 'red.baseline_submitted' ORDER BY seq LIMIT 1"
        )
    details = json.loads(event["details"])
    details["attack_id"] = "OB-03"  # claim Red submitted something else, keeping its real token
    errors, _ = audit.verify_credentials(
        [
            {
                "seq": 1,
                "event_type": "red.baseline_submitted",
                "session_id": event["session_id"],
                "details": json.dumps(details),
            }
        ]
    )
    assert errors and "parameters" in errors[0]["message"]
