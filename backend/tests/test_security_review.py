"""Regression tests for the issues confirmed in the 2026-10-20 security review (descision.md)."""

import pytest
from conftest import WITNESS_URL, auth, run_to_completion
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import evaluator, remote, target
from app.main import app

OPERATOR = {"Authorization": "Bearer dev-operator-token"}


# V1: Blue received the synthetic patient's date of birth because redaction missed it.
def test_blue_findings_mask_every_sensitive_value(client):
    sid = run_to_completion(client)["id"]
    findings = client.get(f"/api/blue/sessions/{sid}/findings", headers=auth("blue")).text
    assert target.PATIENT_DOB in target.PATIENT_RECORD  # the value the old redaction missed
    for value in target.SENSITIVE_VALUES:
        assert value not in findings


def test_iso02_catches_a_partial_redaction(client, monkeypatch):
    # Reinstate the old redaction (name and MRN only): ISO-02 must now notice the DOB.
    monkeypatch.setattr(
        evaluator,
        "redact",
        lambda text: text.replace(target.PATIENT_NAME, "█").replace(target.PATIENT_MRN, "█"),
    )
    checks = {c["check_id"]: c for c in run_to_completion(client, ["II-04"])["isolation"]}
    assert checks["ISO-02"]["status"] == "fail"


# V2: the API answered any Host header, so a DNS-rebinding page could use the public dev tokens.
@pytest.mark.parametrize(
    ("base_url", "status"),
    [
        ("http://rebind.attacker.example", 400),
        ("http://127.0.0.1.attacker.example", 400),
        ("http://127.0.0.1:8000", 200),
        ("http://localhost:5173", 200),
        ("http://backend:8000", 200),
    ],
)
def test_api_answers_only_known_host_names(client, base_url, status):
    assert TestClient(app, base_url=base_url).get("/api/attacks", headers=OPERATOR).status_code == status


# V3: the isolation check read findings with the Blue token, recording a Blue read Blue never made.
def blue_reads(client) -> list[dict]:
    events = client.get("/api/audit?limit=1000", headers=auth("operator")).json()
    return [e for e in events if e["event_type"] == "blue.findings_read"]


def test_isolation_checks_do_not_record_reads_as_blue_in_process(client):
    run_to_completion(client)
    assert len(blue_reads(client)) == 1  # the defend stage's own read only


def test_isolation_checks_do_not_record_reads_as_blue_with_agents(agents, client):
    run_to_completion(client)
    reads = blue_reads(client)
    assert len(reads) == 1 and reads[0]["details"]["via"] == "api"  # the Blue agent's one read


# V4: a malformed witness reply made a committed request answer 500 and broke verification.
@pytest.fixture
def malformed_witness(client, witness, monkeypatch):
    odd = FastAPI()
    odd.get("/v1/checkpoints")(lambda: {"unexpected": True})
    odd.post("/v1/checkpoints")(lambda: ["not", "a", "record"])
    monkeypatch.setitem(remote.OVERRIDES, WITNESS_URL, TestClient(odd))


def test_malformed_witness_replies_are_reported_not_500(client, malformed_witness):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator"))
    assert run.status_code == 201 and run.json()["checkpoint"]["status"] == "failed"
    run = run.json()
    while run["next_stage"]:
        reply = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
        assert reply.status_code == 200, reply.text
        run = reply.json()["run"]
    assert run["report"]["audit"]["checkpoint"] == "unavailable"

    result = client.get("/api/audit/verify", headers=auth("operator"))
    assert result.status_code == 200
    assert result.json()["ok"] is False and result.json()["checkpoint"]["status"] == "unavailable"
    tamper = client.post("/api/audit/tamper-test", json={"mode": "rewrite"}, headers=auth("operator"))
    assert tamper.status_code == 502
