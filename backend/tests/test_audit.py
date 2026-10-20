import itertools

from conftest import auth, run_to_completion

from app import db


def verify(client) -> dict:
    return client.get("/api/audit/verify", headers=auth("operator")).json()


def kinds(result) -> set[str]:
    return {e["kind"] for e in result["errors"]}


def test_chain_links_and_verifies(client):
    run_to_completion(client, ["PI-01"])
    events = client.get("/api/audit", headers=auth("operator")).json()

    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert events[0]["prev_hash"] == "0" * 64
    assert all(b["prev_hash"] == a["hash"] for a, b in itertools.pairwise(events))
    assert {
        "session.created",
        "red.baseline_submitted",
        "target.baseline_response",
        "evaluator.baseline_verdict",
        "blue.defense_applied",
        "isolation.check",
        "report.generated",
    } <= {e["event_type"] for e in events}
    assert verify(client)["ok"] is True


def test_detects_modified_event(client):
    run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        conn.execute("UPDATE audit_events SET details = ? WHERE seq = 4", ('{"verdict":"pass"}',))

    result = verify(client)
    assert result["ok"] is False
    assert any(e["seq"] == 4 and e["kind"] == "hash" for e in result["errors"])


def test_detects_deleted_event(client):
    run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        conn.execute("DELETE FROM audit_events WHERE seq = 3")

    result = verify(client)
    assert result["ok"] is False
    assert {"sequence", "link"} <= kinds(result)


def test_detects_reordered_events(client):
    run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        conn.execute("UPDATE audit_events SET seq = -1 WHERE seq = 3")
        conn.execute("UPDATE audit_events SET seq = 3 WHERE seq = 4")
        conn.execute("UPDATE audit_events SET seq = 4 WHERE seq = -1")

    result = verify(client)
    assert result["ok"] is False
    assert "link" in kinds(result)


def test_detects_tampered_evidence(client):
    run_to_completion(client, ["PI-01"])
    with db.connect() as conn:
        conn.execute(
            "UPDATE attempts SET response = 'I can''t help with that request.' WHERE phase = 'baseline'"
        )

    result = verify(client)
    assert result["ok"] is False
    assert kinds(result) == {"evidence"}


def test_tamper_simulation_leaves_stored_chain_intact(client):
    run_to_completion(client, ["PI-01"])
    for mode, expected in [
        ("modify", {"hash"}),
        ("delete", {"sequence", "link"}),
        ("reorder", {"sequence", "link"}),
    ]:
        result = client.post("/api/audit/tamper-test", json={"mode": mode}, headers=auth("operator")).json()
        assert result["verification"]["ok"] is False, mode
        assert expected <= kinds(result["verification"]), mode

    # A full rewrite passes local verification; only the changed head hash reveals it.
    rewrite = client.post("/api/audit/tamper-test", json={"mode": "rewrite"}, headers=auth("operator")).json()
    assert rewrite["verification"]["ok"] is True
    assert rewrite["tampered_head"] != rewrite["original_head"]

    assert verify(client)["ok"] is True
