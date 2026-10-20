"""Witness recovery: conflicting or far-future checkpoints are superseded, never discarded.

A record written straight to the log with witness.append() stands in for a checkpoint
anchored before extension proofs existed (or by a compromised writer), which is exactly
the situation recovery exists for.
"""

import json

import pytest
from conftest import auth, run_to_completion
from test_checkpoint import log_file, rewrite_chain, verify

from witness import app as witness_app
from witness import recover


def plant(seq: int, head_hash: str) -> dict:
    with witness_app.locked():
        return witness_app.append({"seq": seq, "head_hash": head_hash})


def publish(client, run_id):
    return client.post(f"/api/runs/{run_id}/advance", headers=auth("operator")).json()["checkpoint"]


def test_far_future_checkpoint_blocks_publishing_until_superseded(client, witness):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    bogus = plant(10**6, "d" * 64)
    lines_before = log_file().read_text().splitlines()

    anchor = publish(client, run["id"])
    assert anchor["status"] == "rejected" and "does not match the local chain" in anchor["error"]
    assert log_file().read_text().splitlines() == lines_before  # nothing published, nothing removed

    with pytest.raises(ValueError, match="not 5"):
        recover.supersede(bogus["index"], 5, "operator looked at an old status")
    with pytest.raises(ValueError, match="reason"):
        recover.supersede(bogus["index"], 10**6, "short")
    record = recover.supersede(bogus["index"], 10**6, "far-future checkpoint planted, drill 2026-10-20")
    assert record["supersedes"] == [bogus["index"]]

    assert publish(client, run["id"])["status"] == "anchored"
    lines = log_file().read_text().splitlines()
    assert lines[: len(lines_before)] == lines_before  # history kept byte for byte
    assert any(json.loads(line).get("seq") == 10**6 for line in lines)

    result = verify(client)
    assert result["ok"] is False  # recovery does not make verification pass
    assert [e["kind"] for e in result["checkpoint"]["errors"]] == ["superseded"]
    assert "drill 2026-10-20" in result["checkpoint"]["errors"][0]["message"]
    assert result["checkpoint"]["superseded"][0]["seq"] == 10**6
    assert result["checkpoint"]["unanchored_events"] == 0


def test_rewritten_chain_stays_reported_after_recovery(client, witness):
    run = run_to_completion(client, ["PI-01"])
    rewrite_chain(from_seq=2)
    log = witness.get("/v1/checkpoints").json()
    first_bad = next(r for r in log["records"] if r["seq"] >= 2)

    with_stage = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    assert with_stage["checkpoint"]["status"] == "rejected"

    recover.supersede(first_bad["index"], log["head"]["seq"], "chain rewritten in a tamper drill")
    assert publish(client, with_stage["id"])["status"] == "anchored"
    result = verify(client)
    assert result["ok"] is False
    assert {e["kind"] for e in result["checkpoint"]["errors"]} == {"superseded"}
    assert run["report"]  # the original run is untouched by recovery


def test_supersede_refuses_a_broken_log_and_an_empty_target(client, witness):
    assert recover.status()["head"] is None
    with pytest.raises(ValueError, match="current head"):
        recover.supersede(0, 1, "nothing anchored yet at all")
    plant(1, "a" * 64)
    with pytest.raises(ValueError, match="no checkpoint in force"):
        recover.supersede(5, 1, "index beyond the last checkpoint")
    record = json.loads(log_file().read_text())
    record["seq"] = 2
    log_file().write_text(json.dumps(record) + "\n")
    with pytest.raises(ValueError, match="cannot repair"):
        recover.supersede(0, 1, "the record chain is broken")


def test_a_supersede_record_that_skips_newer_checkpoints_breaks_integrity(client, witness):
    plant(1, "a" * 64)
    plant(2, "b" * 64)
    with witness_app.locked():  # hash-valid but names an older checkpoint while a newer one stays in force
        witness_app.append({"type": "supersede", "supersedes": [0], "reason": "hand-written record"})
    integrity = witness.get("/v1/checkpoints").json()["integrity"]
    assert integrity["ok"] is False and "latest checkpoints" in integrity["reason"]


def test_recovery_cli_reports_status(client, witness, capsys):
    plant(1, "a" * 64)
    assert recover.main(["status"]) == 0
    assert json.loads(capsys.readouterr().out)["head"]["seq"] == 1
    assert (
        recover.main(["supersede", "--from-index", "0", "--expect-head-seq", "9", "--reason", "x" * 12]) == 1
    )
