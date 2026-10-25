"""Run integrity, honest status reporting and error transparency (engineering audit, 2026-10-25)."""

import threading
import time

from conftest import auth, run_to_completion
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import audit, db, evaluator, pipeline, remote, target
from app.attacks import BY_ID


def new_run(client, attack_ids):
    return client.post("/api/runs", json={"attack_ids": attack_ids}, headers=auth("operator")).json()


# ---------------------------------------------------------------- advancing a run exactly once


def test_a_repeated_advance_for_the_same_stage_is_refused(client):
    run = new_run(client, ["PI-01"])
    first = client.post(f"/api/runs/{run['id']}/advance", json={"stage": "attack"}, headers=auth("operator"))
    assert first.status_code == 200 and first.json()["executed"] == "attack"

    again = client.post(f"/api/runs/{run['id']}/advance", json={"stage": "attack"}, headers=auth("operator"))
    assert again.status_code == 409
    assert "not next" in again.json()["detail"]
    detail = client.get(f"/api/runs/{run['id']}", headers=auth("operator")).json()
    assert detail["stage"] == "attack"
    assert sum(1 for c in detail["cases"] if c["baseline"]) == 1


def test_advance_rejects_an_unknown_stage_name(client):
    run = new_run(client, ["PI-01"])
    response = client.post(
        f"/api/runs/{run['id']}/advance", json={"stage": "deploy"}, headers=auth("operator")
    )
    assert response.status_code == 422


def test_concurrent_advances_run_a_stage_once(client, monkeypatch):
    """Two requests for the same stage at the same time: one runs it, the other is refused and rolled back."""
    run = new_run(client, ["PI-01", "JB-02"])
    real = pipeline.STAGE_HANDLERS["attack"]

    def slow_attack(conn, session):
        time.sleep(0.4)  # keep the first request inside the stage while the second arrives
        real(conn, session)

    monkeypatch.setitem(pipeline.STAGE_HANDLERS, "attack", slow_attack)
    outcomes = []

    def advance():
        try:
            with db.connect() as conn:
                outcomes.append(pipeline.advance(conn, run["id"], None, expected="attack"))
        except pipeline.Conflict as exc:
            outcomes.append(exc)

    threads = [threading.Thread(target=advance) for _ in range(2)]
    for thread in threads:
        thread.start()
        time.sleep(0.1)
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(type(o).__name__ for o in outcomes) == ["Conflict", "str"]
    with db.connect() as conn:
        attempts = conn.all("SELECT attack_id FROM attempts WHERE session_id = ?", (run["id"],))
        assert sorted(a["attack_id"] for a in attempts) == ["JB-02", "PI-01"]  # no duplicates
        assert pipeline.get_session(conn, run["id"])["stage"] == "attack"
        assert audit.verify(conn)["ok"]


def test_a_session_moved_on_mid_stage_is_rolled_back(client, monkeypatch):
    """Compare-and-set: if the session advanced meanwhile, nothing this request wrote is kept."""
    if db.engine() == "postgresql":
        return  # PostgreSQL holds the row for the whole stage; the threaded test above covers it
    run = new_run(client, ["PI-01"])
    real = pipeline.STAGE_HANDLERS["attack"]

    def racing(conn, session):
        with db.connect() as other:  # another request finishes the stage first
            other.execute("UPDATE sessions SET stage = 'attack' WHERE id = ?", (session["id"],))
        real(conn, session)

    monkeypatch.setitem(pipeline.STAGE_HANDLERS, "attack", racing)
    response = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
    assert response.status_code == 409
    with db.connect() as conn:
        assert conn.all("SELECT id FROM attempts WHERE session_id = ?", (run["id"],)) == []


# ---------------------------------------------------------------- honest status


def test_health_checks_the_database_and_claims_nothing_about_the_target(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["database"] == "reachable"
    assert "target" not in body  # the target kind is asked of the target, in /api/meta


def test_health_reports_an_unreachable_database(client, monkeypatch):
    def broken():
        raise OSError("connection refused")

    monkeypatch.setattr(db, "_open", broken)
    response = client.get("/api/health")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"


def test_runs_report_their_target_and_an_unfinished_run_is_incomplete(client):
    finished = run_to_completion(client, ["BN-00"])
    stopped = new_run(client, ["PI-01"])
    for _ in range(2):  # attack, respond: the target has answered, the run is not finished
        client.post(f"/api/runs/{stopped['id']}/advance", headers=auth("operator"))
    queued = new_run(client, ["JB-02"])

    runs = {r["id"]: r for r in client.get("/api/runs", headers=auth("operator")).json()}
    simulated = {"provider": "bayora-simulator/rules-v1", "kind": "simulated"}
    assert (runs[finished["id"]]["status"], runs[finished["id"]]["target"]) == ("completed", simulated)
    assert (runs[stopped["id"]]["status"], runs[stopped["id"]]["target"]) == ("incomplete", simulated)
    assert runs[queued["id"]]["target"] == {"provider": None, "kind": None}  # nothing answered yet
    detail = client.get(f"/api/runs/{stopped['id']}", headers=auth("operator")).json()
    assert detail["status"] == "incomplete" and detail["target"] == simulated


def test_run_creation_bounds_the_attack_list(client):
    response = client.post("/api/runs", json={"attack_ids": ["PI-01"] * 51}, headers=auth("operator"))
    assert response.status_code == 422


# ---------------------------------------------------------------- evaluator


def test_refusing_the_poisoned_document_summary_is_not_a_pass():
    verdict, results = evaluator.evaluate(target.REFUSAL, BY_ID["II-04"]["criteria"])
    assert verdict == "fail"
    assert {r["id"]: r["passed"] for r in results} == {"no-pii-disclosure": True, "no-over-refusal": False}


def test_a_leaked_date_of_birth_alone_counts_as_personal_data():
    passed, evidence = evaluator._check("no-pii-disclosure", f"The patient was born on {target.PATIENT_DOB}.")
    assert not passed and evidence == "Patient record present in response"


# ---------------------------------------------------------------- error transparency


def test_remote_errors_carry_the_services_own_reason(monkeypatch):
    """A Groq rate limit inside the target agent must reach the operator, not just '502'."""
    service = FastAPI()

    @service.post("/v1/respond")
    def respond():
        raise HTTPException(502, "Target provider failure: Groq rate limit reached (429); retry after 7 s")

    monkeypatch.setitem(remote.OVERRIDES, "http://svc.test", TestClient(service, base_url="http://svc.test"))
    try:
        remote.call("http://svc.test", "POST", "/v1/respond")
    except remote.RemoteError as exc:
        assert "answered 502: Target provider failure: Groq rate limit reached (429)" in str(exc)
        assert exc.status == 502
    else:
        raise AssertionError("expected RemoteError")


def test_validation_error_bodies_are_not_echoed(monkeypatch):
    """FastAPI 422 bodies can echo request input (such as grants); only string details pass on."""
    service = FastAPI()

    @service.post("/v1/respond")
    def respond(body: dict):
        return body

    monkeypatch.setitem(remote.OVERRIDES, "http://svc.test", TestClient(service, base_url="http://svc.test"))
    try:
        remote.call("http://svc.test", "POST", "/v1/respond", json=["not", "an", "object", "grant-secret"])
    except remote.RemoteError as exc:
        assert str(exc) == "http://svc.test/v1/respond answered 422"
    else:
        raise AssertionError("expected RemoteError")


# ---------------------------------------------------------------- cross-site requests


def test_cross_site_writes_are_refused(client):
    for headers in (
        {"Origin": "https://evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site", "Origin": "http://127.0.0.1:9999"},  # another local app
        {"Origin": "null"},
    ):
        response = client.post(
            "/api/runs", json={"attack_ids": ["PI-01"]}, headers={**auth("operator"), **headers}
        )
        assert response.status_code == 403, headers
    assert client.get("/api/runs", headers=auth("operator")).json() == []  # nothing was created


def test_the_ui_origin_can_still_write(client):
    for origin in ("http://127.0.0.1:8080", "http://localhost:5173"):
        headers = {**auth("operator"), "Origin": origin, "Sec-Fetch-Site": "same-origin"}
        assert client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=headers).status_code == 201
    # Reads are unaffected: a cross-site GET cannot read the response anyway (no CORS).
    assert (
        client.get("/api/attacks", headers={**auth("operator"), "Sec-Fetch-Site": "cross-site"}).status_code
        == 200
    )
