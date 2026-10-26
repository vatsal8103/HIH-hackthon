import time

import pytest
from conftest import auth

from app import db, fairness, isolation


def test_evaluate_target_fairness_default():
    result = fairness.evaluate_target_fairness()
    assert result["passed"] is True
    assert result["deterministic"] is True
    assert isinstance(result["baseline_ms"], float)
    assert isinstance(result["burst_ms"], float)
    assert result["threshold_pct"] == fairness.LATENCY_THRESHOLD_PCT


def test_evaluate_target_fairness_latency_drift_fail():
    call_count = 0

    def slow_on_burst(prompt: str) -> str:
        nonlocal call_count
        call_count += 1
        # First 3 are baseline: fast
        if call_count <= 3:
            return "Clinic hours: 9am - 5pm"
        # Burst calls: simulate significant latency slowdown (e.g. 50ms)
        time.sleep(0.02)
        return "Clinic hours: 9am - 5pm"

    result = fairness.evaluate_target_fairness(
        target_fn=slow_on_burst,
        burst_count=4,
        threshold_pct=20.0,
    )
    assert result["passed"] is False
    assert result["delta_pct"] > 20.0
    assert result["deterministic"] is True


def test_evaluate_target_fairness_nondeterministic_fail():
    call_count = 0

    def nondeterministic_target(prompt: str) -> str:
        nonlocal call_count
        call_count += 1
        return f"Answer variation {call_count}"

    result = fairness.evaluate_target_fairness(
        target_fn=nondeterministic_target,
        burst_count=3,
        threshold_pct=1000.0,  # huge threshold so latency alone wouldn't fail
    )
    assert result["passed"] is False
    assert result["deterministic"] is False


def test_pad_response_time_sync():
    t0 = time.perf_counter()
    padded_elapsed = fairness.pad_response_time(t0, quantum_ms=15.0)
    assert padded_elapsed >= 14.5  # Account for minor clock resolution variations


@pytest.mark.anyio
async def test_pad_response_time_async():
    t0 = time.perf_counter()
    padded_elapsed = await fairness.async_pad_response_time(t0, quantum_ms=15.0)
    assert padded_elapsed >= 14.5


def test_timing_protection_header_on_role_routes(client):
    run = client.post("/api/runs", json={"attack_ids": ["BN-00"]}, headers=auth("operator")).json()
    sid = run["id"]

    # Red route
    res_red = client.get(f"/api/red/sessions/{sid}/attempts", headers=auth("red"))
    assert res_red.status_code == 200
    assert res_red.headers.get("x-timing-protection") == "quantized"

    # Blue route
    res_blue = client.get("/api/blue/rules", headers=auth("blue"))
    assert res_blue.status_code == 200
    assert res_blue.headers.get("x-timing-protection") == "quantized"

    # Non-role route (operator / general) should not have timing padding header
    res_health = client.get("/api/health")
    assert res_health.status_code == 200
    assert "x-timing-protection" not in res_health.headers


def test_container_limits_evaluation():
    limits = fairness.evaluate_container_limits()
    assert limits["cpus"] == 0.5
    assert limits["mem_limit_mb"] == 256
    assert limits["pids_limit"] == 128
    assert limits["enforced"] is True


def test_run_fairness_check_tuple(client):
    with db.connect() as conn:
        check_id, title, kind, status, detail = fairness.run_fairness_check(conn, "session-test")
    assert check_id == "ISO-12"
    assert title == "Resource fairness & timing mitigation"
    assert kind == "enforced"
    assert status == "pass"
    assert "Target latency under burst" in detail
    assert "100% deterministic" in detail
    assert "Timing side channels are reduced, not eliminated." in detail


def test_iso12_integrated_in_isolation_run_checks(client):
    run = client.post("/api/runs", json={"attack_ids": ["BN-00"]}, headers=auth("operator")).json()
    session_id = run["id"]

    with db.connect() as conn:
        checks = isolation.run_checks(
            conn, client.app, session_id, operator_auth=auth("operator")["Authorization"]
        )
    checks_by_id = {c["check_id"]: c for c in checks}

    assert "ISO-12" in checks_by_id
    iso12 = checks_by_id["ISO-12"]
    assert iso12["status"] == "pass"
    assert iso12["kind"] == "enforced"
    assert "Resource fairness & timing mitigation" in iso12["title"]
    assert "Timing side channels are reduced, not eliminated." in iso12["detail"]
