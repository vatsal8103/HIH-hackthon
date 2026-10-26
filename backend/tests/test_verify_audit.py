import json
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from conftest import run_to_completion


def test_verify_audit_cli_on_valid_run(client, tmp_path):
    run_to_completion(client, ["BN-00"])

    # Locate the sqlite db created by the client fixture
    db_path = tmp_path / "test.db"
    assert db_path.exists()

    script_path = Path(__file__).resolve().parents[2] / "scripts" / "verify_audit.py"
    export_file = tmp_path / "evidence_bundle.json"

    result = subprocess.run(
        [sys.executable, str(script_path), "--db", str(db_path), "--export", str(export_file)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, f"STDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    assert "STATUS:       VERIFIED (0 errors detected)" in result.stdout
    assert "SHA-256 hash chaining unbroken" in result.stdout
    assert export_file.exists()

    bundle = json.loads(export_file.read_text(encoding="utf-8"))
    assert bundle["format"] == "bayora-audit-evidence-bundle-v1"
    assert bundle["summary"]["ok"] is True
    assert len(bundle["events"]) >= 5


def test_verify_audit_tamper_event_hash_fails(client, tmp_path):
    run_to_completion(client, ["BN-00"])
    db_path = tmp_path / "test.db"

    # Tamper directly with the details of event seq 2
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE audit_events SET details = '{\"tampered\": true}' WHERE seq = 2")
    conn.commit()
    conn.close()

    script_path = Path(__file__).resolve().parents[2] / "scripts" / "verify_audit.py"
    result = subprocess.run(
        [sys.executable, str(script_path), "--db", str(db_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "TAMPER DETECTED" in result.stdout
    assert "Calculated digest" in result.stdout
    assert "[Seq 2]" in result.stdout


def test_verify_audit_tamper_delete_event_fails(client, tmp_path):
    run_to_completion(client, ["BN-00"])
    db_path = tmp_path / "test.db"

    # Delete event seq 2
    conn = sqlite3.connect(db_path)
    conn.execute("DELETE FROM audit_events WHERE seq = 2")
    conn.commit()
    conn.close()

    script_path = Path(__file__).resolve().parents[2] / "scripts" / "verify_audit.py"
    result = subprocess.run(
        [sys.executable, str(script_path), "--db", str(db_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "TAMPER DETECTED" in result.stdout
    assert "Expected sequence 2" in result.stdout or "prev_hash" in result.stdout


def test_verify_audit_tamper_evidence_attempt_fails(client, tmp_path):
    run_to_completion(client, ["BN-00"])
    db_path = tmp_path / "test.db"

    # Tamper with an attempt record's prompt directly in sqlite
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE attempts SET prompt = 'TAMPERED PROMPT'")
    conn.commit()
    conn.close()

    script_path = Path(__file__).resolve().parents[2] / "scripts" / "verify_audit.py"
    result = subprocess.run(
        [sys.executable, str(script_path), "--db", str(db_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "TAMPER DETECTED" in result.stdout
    assert "prompt_digest_mismatch" in result.stdout


def test_verify_audit_witness_log_alignment(tmp_path):
    # Construct a minimal standalone SQLite db and matching witness log
    from scripts.verify_audit import GENESIS, compute_event_hash, verify_database

    db_path = tmp_path / "test_witness.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """CREATE TABLE audit_events (
            seq INTEGER PRIMARY KEY,
            ts TEXT NOT NULL,
            session_id TEXT,
            actor TEXT NOT NULL,
            event_type TEXT NOT NULL,
            evidence_ref TEXT,
            details TEXT NOT NULL,
            prev_hash TEXT NOT NULL,
            hash TEXT NOT NULL
        )"""
    )
    conn.execute("CREATE TABLE attempts (id TEXT PRIMARY KEY, prompt TEXT, response TEXT, verdict TEXT)")

    e1 = {
        "seq": 1,
        "ts": "2026-10-26T00:00:00.000Z",
        "session_id": "s1",
        "actor": "operator",
        "event_type": "session.created",
        "evidence_ref": None,
        "details": json.dumps({"test": 1}),
        "prev_hash": GENESIS,
    }
    e1["hash"] = compute_event_hash(e1)

    conn.execute(
        "INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            e1["seq"],
            e1["ts"],
            e1["session_id"],
            e1["actor"],
            e1["event_type"],
            e1["evidence_ref"],
            e1["details"],
            e1["prev_hash"],
            e1["hash"],
        ),
    )
    conn.commit()
    conn.close()

    # Create matching witness log
    log_path = tmp_path / "checkpoints.jsonl"
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"seq": 1, "head_hash": e1["hash"], "index": 0}) + "\n")

    summary = verify_database(db_path, witness_log_path=log_path)
    assert summary["ok"] is True
    assert len(summary["witness_errors"]) == 0

    # Tamper with witness log head_hash
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"seq": 1, "head_hash": "f" * 64, "index": 0}) + "\n")

    tampered_summary = verify_database(db_path, witness_log_path=log_path)
    assert tampered_summary["ok"] is False
    assert len(tampered_summary["witness_errors"]) == 1
    assert "disagrees with local event hash" in tampered_summary["witness_errors"][0]["message"]
