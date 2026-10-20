"""External audit checkpoints: witness rules and verification against the stored chain.

The witness runs in-process here, so these tests prove its logic and the control plane's
comparison, not that its storage is out of the database writer's reach. That separation
is a deployment property, checked in tests_compose/.
"""

import json
from pathlib import Path

import httpx
from conftest import WITNESS_TOKEN, WITNESS_URL, auth, run_to_completion, tamper

from app import audit, db, remote

TOKEN = {"Authorization": f"Bearer {WITNESS_TOKEN}"}


def fake_chain(n: int) -> list[dict]:
    """A valid audit chain, hashed with the control plane's own function (so the witness's must agree)."""
    events, prev = [], audit.GENESIS
    for seq in range(1, n + 1):
        event = {
            "seq": seq,
            "ts": "2026-10-20T00:00:00.000+00:00",
            "session_id": None,
            "actor": "system",
            "event_type": "test.event",
            "evidence_ref": None,
            "details": "{}",
            "prev_hash": prev,
        }
        event["hash"] = audit.event_hash(event)
        events.append(event)
        prev = event["hash"]
    return events


CHAIN = fake_chain(20)


def log_file() -> Path:
    import os

    return Path(os.environ["BAYORA_WITNESS_DATA"]) / "checkpoints.jsonl"


def post(witness, seq, head_hash=None, since=0, events=None, headers=TOKEN):
    """Checkpoint CHAIN[seq] with the proof of events since..seq unless told otherwise."""
    body = {
        "seq": seq,
        "head_hash": head_hash or CHAIN[seq - 1]["hash"],
        "events": CHAIN[since:seq] if events is None else events,
    }
    return witness.post("/v1/checkpoints", json=body, headers=headers)


def verify(client) -> dict:
    return client.get("/api/audit/verify", headers=auth("operator")).json()


def rewrite_chain(from_seq: int) -> None:
    """What an attacker with full database control could do: edit an event, recompute every later hash."""
    with tamper() as conn:
        events = audit.load(conn)
        for i, event in enumerate(events):
            if event["seq"] < from_seq:
                continue
            if event["seq"] == from_seq:
                details = json.loads(event["details"])
                details["note"] = "rewritten"
                event["details"] = json.dumps(details, sort_keys=True, separators=(",", ":"))
            event["prev_hash"] = events[i - 1]["hash"] if i else audit.GENESIS
            event["hash"] = audit.event_hash(event)
            conn.execute(
                "UPDATE audit_events SET details = ?, prev_hash = ?, hash = ? WHERE seq = ?",
                (event["details"], event["prev_hash"], event["hash"], event["seq"]),
            )


# ---------------------------------------------------------------- witness rules


def test_witness_is_append_only(witness):
    assert post(witness, 5).json()["index"] == 0
    assert post(witness, 3).status_code == 409  # regression
    assert post(witness, 5).json()["index"] == 0  # idempotent repeat
    assert post(witness, 5, "b" * 64).status_code == 409  # rewrite of an anchored seq
    assert post(witness, 6, since=5).json()["index"] == 1
    assert post(witness, 7, since=6, headers={}).status_code == 401
    assert post(witness, 7, since=6, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert post(witness, 8, "not-a-hash", since=6).status_code == 422
    assert len(witness.get("/v1/checkpoints").json()["records"]) == 2


def test_witness_refuses_checkpoints_without_a_valid_extension_proof(witness):
    assert post(witness, 3).status_code == 200
    tampered = [dict(e) for e in CHAIN[3:8]]
    tampered[2]["details"] = '{"note":"edited"}'
    relinked = [dict(e) for e in CHAIN[3:8]]
    relinked[0]["prev_hash"] = "e" * 64
    cases = {
        "far future, no proof": post(witness, 10**6, "d" * 64, events=[]),
        "proof skips ahead": post(witness, 8, since=4),
        "proof restarts from genesis": post(witness, 8, since=0),
        "event edited": post(witness, 8, events=tampered),
        "does not link to the head": post(witness, 8, events=relinked),
        "head is not the last event": post(witness, 8, "d" * 64, since=3),
    }
    for label, reply in cases.items():
        assert reply.status_code == 409, (label, reply.text)
    oversized = post(witness, 504, CHAIN[0]["hash"], events=[CHAIN[0]] * 501)
    assert oversized.status_code == 422
    log = witness.get("/v1/checkpoints").json()
    assert [r["seq"] for r in log["records"]] == [3] and log["integrity"]["ok"]


def test_witness_isolates_a_torn_tail_write(witness):
    post(witness, 1)
    post(witness, 2, since=1)
    with log_file().open("a") as handle:
        handle.write('{"index": 2, "seq": 3, "head_ha')  # process died mid-write
    log = witness.get("/v1/checkpoints").json()
    assert log["integrity"]["ok"] and log["integrity"]["torn_tail"] and len(log["records"]) == 2

    assert post(witness, 3, since=2).status_code == 200
    log = witness.get("/v1/checkpoints").json()
    assert log["integrity"] == {"ok": True, "reason": None, "ignored_lines": 1, "torn_tail": False}
    assert [r["seq"] for r in log["records"]] == [1, 2, 3]


def test_witness_fails_closed_when_a_record_is_removed(witness):
    for seq in (1, 2, 3):
        post(witness, seq, since=seq - 1)
    lines = log_file().read_text().splitlines()
    log_file().write_text("\n".join([lines[0], lines[2]]) + "\n")

    assert witness.get("/v1/checkpoints").json()["integrity"]["ok"] is False
    assert post(witness, 4, since=3).status_code == 503


def test_witness_fails_closed_when_a_record_is_edited(witness):
    post(witness, 1)
    record = json.loads(log_file().read_text())
    record["head_hash"] = "f" * 64
    log_file().write_text(json.dumps(record) + "\n")
    assert witness.get("/v1/checkpoints").json()["integrity"]["ok"] is False


# ---------------------------------------------------------------- control plane


def test_every_committed_stage_is_checkpointed(client, witness):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    assert run["checkpoint"]["status"] == "anchored"
    while run["next_stage"]:
        reply = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator")).json()
        assert reply["checkpoint"]["status"] == "anchored", reply["checkpoint"]
        run = reply["run"]

    result = verify(client)
    assert result["ok"] is True
    anchor = result["checkpoint"]
    assert (anchor["status"], anchor["checkpoints"], anchor["unanchored_events"]) == ("ok", 8, 0)
    assert run["report"]["audit"]["checkpoint"] == "ok"


def test_whole_chain_rewrite_passes_locally_but_fails_the_checkpoint(client, witness):
    run_to_completion(client, ["PI-01"])
    rewrite_chain(from_seq=2)

    with db.connect() as conn:
        assert audit.verify(conn)["ok"] is True  # the local chain alone cannot tell
    result = verify(client)
    assert result["ok"] is False
    assert {e["kind"] for e in result["checkpoint"]["errors"]} == {"checkpoint"}


def test_truncation_is_detected_against_the_checkpoint(client, witness):
    run_to_completion(client, ["PI-01"])
    with tamper() as conn:
        head = conn.one("SELECT MAX(seq) AS seq FROM audit_events")["seq"]
        conn.execute("DELETE FROM audit_events WHERE seq > ?", (head - 4,))
        assert audit.verify(conn)["ok"] is True  # a shorter chain is still internally valid

    result = verify(client)
    assert result["ok"] is False
    assert "truncated" in {e["kind"] for e in result["checkpoint"]["errors"]}


def test_deleting_a_checkpointed_event_is_reported(client, witness):
    run_to_completion(client, ["PI-01"])
    anchored = witness.get("/v1/checkpoints").json()["records"][2]["seq"]
    with tamper() as conn:
        conn.execute("DELETE FROM audit_events WHERE seq = ?", (anchored,))

    result = verify(client)
    assert result["ok"] is False
    assert "missing" in {e["kind"] for e in result["checkpoint"]["errors"]}


def test_witness_outage_is_reported_never_hidden(client, witness, monkeypatch):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    monkeypatch.setitem(remote.OVERRIDES, WITNESS_URL, httpx.Client(transport=httpx.MockTransport(refuse)))

    reply = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator"))
    assert reply.status_code == 200  # the stage itself committed
    assert reply.json()["checkpoint"]["status"] == "failed"
    result = verify(client)
    assert result["ok"] is False and result["checkpoint"]["status"] == "unavailable"

    monkeypatch.setitem(remote.OVERRIDES, WITNESS_URL, witness)
    assert verify(client)["checkpoint"]["unanchored_events"] > 0  # the gap is visible
    reply = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator")).json()
    assert reply["checkpoint"]["status"] == "anchored"
    assert verify(client)["checkpoint"]["unanchored_events"] == 0


def test_tamper_simulation_shows_the_checkpoint_catching_a_rewrite(client, witness):
    run_to_completion(client, ["PI-01"])
    result = client.post("/api/audit/tamper-test", json={"mode": "rewrite"}, headers=auth("operator")).json()
    assert result["verification"]["ok"] is True
    assert result["checkpoint"]["detected"] is True


def test_without_a_witness_the_status_says_so(client):
    run_to_completion(client, ["PI-01"])
    result = verify(client)
    assert result["ok"] is True and result["checkpoint"]["status"] == "not-configured"
