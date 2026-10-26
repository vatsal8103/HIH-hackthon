import json

from conftest import auth, run_to_completion

from app import attacks, db, llm_isolation


def test_fresh_session_context_passes(client):
    run = run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        res = llm_isolation.check_session_context(conn, run["id"])
    assert res["ok"] is True
    assert res["status"] == "pass"
    assert "fresh context confirmed" in res["detail"]


def test_cross_session_context_leak_detected(client):
    # Setup two sessions in DB: session 1 has unique private text
    run1 = run_to_completion(client, ["BN-00"])
    unique_prior_text = "CONFIDENTIAL-SURGERY-SCHEDULE-OCTOBER-26-PRIOR-SESSION-RECORD"

    with db.connect() as conn:
        conn.execute(
            "UPDATE attempts SET response = ? WHERE session_id = ? AND attack_id = 'BN-00'",
            (f"Clinic response with {unique_prior_text}", run1["id"]),
        )

    # Create session 2, advance to attack stage, and deliberately leak the prior session's unique text into its prompt
    run2 = client.post("/api/runs", json={"attack_ids": ["BN-00"]}, headers=auth("operator")).json()
    client.post(f"/api/runs/{run2['id']}/advance", headers=auth("operator"))

    with db.connect() as conn:
        conn.execute(
            "UPDATE attempts SET prompt = ? WHERE session_id = ? AND attack_id = 'BN-00'",
            (f"Contaminated request with {unique_prior_text}", run2["id"]),
        )
        res = llm_isolation.check_session_context(conn, run2["id"])

    assert res["ok"] is False
    assert res["status"] == "fail"
    assert len(res["violations"]) > 0
    assert "Cross-session contamination detected" in res["detail"]


def test_canary_test_clean_run_passes():
    result = llm_isolation.cross_session_canary_test()
    assert result["ok"] is True
    assert result["status"] == "pass"
    assert result["leaked"] is False
    assert "zero canary residue" in result["detail"]


def test_canary_test_deliberate_leak_detected():
    # Negative test: deliberately simulate canary leakage from session A into session B
    result = llm_isolation.cross_session_canary_test(deliberate_leak=True)
    assert result["ok"] is False
    assert result["status"] == "fail"
    assert result["leaked"] is True
    assert "CROSS-SESSION LEAK DETECTED" in result["detail"]
    assert result["canary"] in result["detail"]


def test_output_isolation_scanner_clean(client):
    run = run_to_completion(client, ["BN-00"])
    with db.connect() as conn:
        res = llm_isolation.scan_output_isolation(conn, run["id"])
    assert res["ok"] is True
    assert res["status"] == "pass"
    assert "no Blue defense rules or cross-attack prompt fragments found" in res["detail"]


def test_output_isolation_scanner_detects_defense_rule_leak(client):
    # Negative test: target answer contains a Blue defense rule id
    run = run_to_completion(client, ["BN-00"])
    with db.connect() as conn:
        res = llm_isolation.scan_output_isolation(
            conn, run["id"], deliberate_leak="Configured by secret-egress-filter."
        )
    assert res["ok"] is False
    assert res["status"] == "fail"
    assert any("secret-egress-filter" in leak for leak in res["leaks"])


def test_output_isolation_scanner_detects_cross_attack_prompt_leak(client):
    # Negative test: target answer for BN-00 contains prompt fragment from another attack
    other_prompt = attacks.BY_ID["PI-01"]["prompt"][:40]
    run = run_to_completion(client, ["BN-00"])
    with db.connect() as conn:
        res = llm_isolation.scan_output_isolation(
            conn, run["id"], deliberate_leak=f"Leaked text: {other_prompt}"
        )
    assert res["ok"] is False
    assert res["status"] == "fail"
    assert any("PI-01" in leak for leak in res["leaks"])


def test_kv_cache_advisory():
    sim = llm_isolation.kv_cache_advisory("simulated", "bayora-simulator/rules-v1")
    assert sim["status"] == "pass"
    assert "stateless in-memory execution" in sim["risk_note"]

    live = llm_isolation.kv_cache_advisory("live", "groq/qwen/qwen3.8-27b")
    assert live["status"] == "pass"
    assert live["kind"] == "configured"
    assert "outside local control" in live["risk_note"]


def test_run_llm_checks_appends_to_audit_chain(client):
    run = run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        checks = llm_isolation.run_llm_checks(conn, run["id"])
        events = conn.all(
            "SELECT event_type, details FROM audit_events WHERE session_id = ? AND event_type = 'isolation.llm_check'",
            (run["id"],),
        )
    assert len(checks) == 3
    assert {c[0] for c in checks} == {"ISO-09", "ISO-10", "ISO-11"}
    assert len(events) >= 1
    details = json.loads(events[-1]["details"])
    assert details["context_guard"] == "pass"
    assert details["canary_test"] == "pass"
    assert details["output_isolation"] == "pass"


def test_end_to_end_isolation_checks_include_iso_09_10_11(client):
    run = run_to_completion(client, ["PI-01"])
    checks_by_id = {c["check_id"]: c for c in run["isolation"]}
    assert "ISO-09" in checks_by_id
    assert "ISO-10" in checks_by_id
    assert "ISO-11" in checks_by_id
    assert checks_by_id["ISO-09"]["status"] == "pass"
    assert checks_by_id["ISO-10"]["status"] == "pass"
    assert checks_by_id["ISO-11"]["status"] == "pass"
    assert client.get("/api/audit/verify", headers=auth("operator")).json()["ok"] is True
