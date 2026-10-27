import json

from conftest import auth

from app import db, monitor
from app.target import CANARY, PATIENT_RECORD


def test_alert_created_on_forbidden_call(client):
    # Blue role attempting to call Red endpoint (/api/red/sessions/...)
    fake_sid = "11111111-2222-3333-4444-555555555555"
    response = client.get(f"/api/red/sessions/{fake_sid}/attempts", headers=auth("blue"))
    assert response.status_code == 403

    # Check alert list as operator
    alerts_res = client.get("/api/alerts", headers=auth("operator"))
    assert alerts_res.status_code == 200
    data = alerts_res.json()
    assert data["counts"]["total"] >= 1
    recent = data["alerts"][0]
    assert recent["role"] == "blue"
    assert "CROSS_BOUNDARY_ACCESS" in recent["reason_code"]


def test_alert_contains_no_secret_text(client):
    # Trigger a forbidden call that attempts to submit secret canary text
    fake_sid = "11111111-2222-3333-4444-555555555555"
    payload = {"attack_id": "PI-01", "secret": CANARY, "patient": PATIENT_RECORD}
    _ = client.post(f"/api/blue/sessions/{fake_sid}/defenses", json=payload, headers=auth("red"))

    alerts_res = client.get("/api/alerts", headers=auth("operator")).json()
    assert alerts_res["counts"]["total"] >= 1

    # Verify that nowhere in the alert JSON does the canary or patient record appear
    alert_text = json.dumps(alerts_res)
    assert CANARY not in alert_text
    assert PATIENT_RECORD not in alert_text
    assert "PI-01" not in alert_text

    # Verify allowed fields only
    for alert in alerts_res["alerts"]:
        assert set(alert.keys()).issubset({"id", "created_at", "role", "route", "reason_code", "description"})


def test_alert_is_written_to_audit_chain(client):
    # Trigger demo alert
    res = client.post("/api/alerts/demo", headers=auth("operator"))
    assert res.status_code == 201
    alert_info = res.json()
    alert_id = alert_info["id"]

    # Verify audit chain has monitor.alert event with the alert_id
    with db.connect() as conn:
        event = conn.one(
            "SELECT * FROM audit_events WHERE event_type = 'monitor.alert' AND evidence_ref = ?",
            (f"alert:{alert_id}",),
        )
    assert event is not None
    details = json.loads(event["details"])
    assert details["alert_id"] == alert_id
    assert details["role"] == "red"
    assert details["reason_code"] == "CROSS_BOUNDARY_ACCESS"

    # Local audit verification must pass
    verify_res = client.get("/api/audit/verify", headers=auth("operator")).json()
    assert verify_res["ok"] is True


def test_alerts_endpoint_operator_only(client):
    # Non-operator roles are refused
    assert client.get("/api/alerts", headers=auth("red")).status_code == 403
    assert client.get("/api/alerts", headers=auth("blue")).status_code == 403
    assert client.get("/api/alerts", headers=auth("target")).status_code == 403
    assert client.get("/api/alerts").status_code == 401


def test_alerts_endpoint_rate_limiting(client, monkeypatch):
    # Test rate limiter
    monitor._ALERTS_ENDPOINT_CALLS.clear()
    for _ in range(60):
        client.get("/api/alerts", headers=auth("operator"))

    # 61st call should trigger 429
    limited = client.get("/api/alerts", headers=auth("operator"))
    assert limited.status_code == 429
    assert "rate limit exceeded" in limited.json()["detail"].lower()
    monitor._ALERTS_ENDPOINT_CALLS.clear()


def test_remote_failure_records_process_crash_alert(agents, client):
    from unittest.mock import patch

    from app import remote

    res = client.post("/api/runs", json={"attack_ids": ["BN-00"]}, headers=auth("operator"))
    run_id = res.json()["id"]

    with patch("app.remote.call_agent", side_effect=remote.RemoteError("red agent unreachable")):
        advance_res = client.post(f"/api/runs/{run_id}/advance", headers=auth("operator"))
        assert advance_res.status_code == 502

    alerts_res = client.get("/api/alerts", headers=auth("operator")).json()
    crash_alerts = [a for a in alerts_res["alerts"] if a["reason_code"] == "PROCESS_CRASH"]
    assert len(crash_alerts) >= 1
    assert crash_alerts[0]["role"] == "red"
