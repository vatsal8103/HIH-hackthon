#!/usr/bin/env python3
"""Standalone offline audit verification and evidence exporter for Bayora.

Verifies the cryptographic integrity of the append-only audit trail directly
against the SQLite database without requiring the FastAPI backend service.
Validates:
1. Genesis hash ("0"*64) and sequential sequence ordering.
2. Cryptographic SHA-256 hash chaining (each block commits to the prior block's hash).
3. Canonical field serialization digest matching stored event hashes.
4. Evidence reference consistency (matching SHA-256 digests in attempt records).
5. External witness log alignment (verifying against witness checkpoints.jsonl).
6. Evidence bundle export for third-party auditing and regulatory inspection.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

GENESIS = "0" * 64
HASHED_FIELDS = ("seq", "ts", "session_id", "actor", "event_type", "evidence_ref", "details", "prev_hash")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compute_event_hash(event: dict[str, Any]) -> str:
    material = json.dumps(
        {field: event[field] for field in HASHED_FIELDS},
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256_hex(material)


def verify_chain_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Check sequence continuity, prev_hash links, and per-event SHA-256 hashes."""
    errors: list[dict[str, Any]] = []
    expected_seq = 1
    expected_prev = GENESIS

    for event in events:
        seq = event["seq"]
        if seq != expected_seq:
            problem = "missing event(s) before this one" if seq > expected_seq else "event out of order"
            errors.append(
                {
                    "seq": seq,
                    "kind": "sequence",
                    "message": f"Expected sequence {expected_seq}: {problem}",
                }
            )

        if event["prev_hash"] != expected_prev:
            errors.append(
                {
                    "seq": seq,
                    "kind": "link",
                    "message": f"prev_hash ({event['prev_hash'][:16]}...) does not match expected ({expected_prev[:16]}...)",
                }
            )

        calculated_hash = compute_event_hash(event)
        if calculated_hash != event["hash"]:
            errors.append(
                {
                    "seq": seq,
                    "kind": "hash",
                    "message": f"Calculated digest ({calculated_hash[:16]}...) does not match stored hash ({event['hash'][:16]}...)",
                }
            )

        expected_seq = seq + 1
        expected_prev = event["hash"]

    return {
        "ok": len(errors) == 0,
        "checked": len(events),
        "head_hash": events[-1]["hash"] if events else GENESIS,
        "head_seq": events[-1]["seq"] if events else 0,
        "errors": errors,
    }


def verify_evidence_records(conn: sqlite3.Connection, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Verify that attempt records referenced by evidence_ref match recorded digests."""
    errors: list[dict[str, Any]] = []
    cursor = conn.cursor()

    for event in events:
        ref = event.get("evidence_ref") or ""
        if not ref.startswith("attempt:"):
            continue

        attempt_id = ref.split(":", 1)[1]
        cursor.execute("SELECT prompt, response, verdict FROM attempts WHERE id = ?", (attempt_id,))
        row = cursor.fetchone()

        if row is None:
            errors.append(
                {
                    "seq": event["seq"],
                    "kind": "evidence_missing",
                    "message": f"Referenced attempt {attempt_id} does not exist in database",
                }
            )
            continue

        prompt, response, verdict = row[0], row[1] or "", row[2]
        try:
            details = json.loads(event["details"])
        except (json.JSONDecodeError, TypeError):
            errors.append(
                {
                    "seq": event["seq"],
                    "kind": "details_malformed",
                    "message": "Event details is not valid JSON",
                }
            )
            continue

        if "prompt_sha256" in details and details["prompt_sha256"] != sha256_hex(prompt):
            errors.append(
                {
                    "seq": event["seq"],
                    "kind": "prompt_digest_mismatch",
                    "message": f"Attempt {attempt_id} prompt SHA-256 differs from audit digest",
                }
            )

        if "response_sha256" in details and details["response_sha256"] != sha256_hex(response):
            errors.append(
                {
                    "seq": event["seq"],
                    "kind": "response_digest_mismatch",
                    "message": f"Attempt {attempt_id} response SHA-256 differs from audit digest",
                }
            )

        if "verdict" in details and details["verdict"] != verdict:
            errors.append(
                {
                    "seq": event["seq"],
                    "kind": "verdict_mismatch",
                    "message": f"Attempt {attempt_id} verdict ({verdict}) differs from audit verdict ({details['verdict']})",
                }
            )

    return errors


def verify_witness_log(witness_log_path: Path, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compare local audit events against external witness checkpoints file."""
    errors: list[dict[str, Any]] = []
    if not witness_log_path.exists():
        return [{"kind": "witness_not_found", "message": f"Witness log file not found at {witness_log_path}"}]

    events_by_seq = {e["seq"]: e for e in events}
    checkpoints: list[dict[str, Any]] = []

    try:
        with open(witness_log_path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    checkpoints.append(record)
                except json.JSONDecodeError:
                    errors.append(
                        {
                            "kind": "witness_corrupt_record",
                            "message": f"Corrupt JSON at line {line_no} in witness log",
                        }
                    )
    except OSError as err:
        return [{"kind": "witness_io_error", "message": f"Cannot read witness log: {err}"}]

    for cp in checkpoints:
        seq = cp.get("seq")
        expected_head = cp.get("head_hash")
        if seq is None or expected_head is None:
            continue

        local_event = events_by_seq.get(seq)
        if local_event is None:
            errors.append(
                {
                    "seq": seq,
                    "kind": "witness_truncated",
                    "message": f"Witness recorded checkpoint at seq {seq}, but local chain is truncated before this sequence",
                }
            )
        elif local_event["hash"] != expected_head:
            errors.append(
                {
                    "seq": seq,
                    "kind": "witness_hash_mismatch",
                    "message": f"Witness head hash at seq {seq} ({expected_head[:16]}...) disagrees with local event hash ({local_event['hash'][:16]}...)",
                }
            )

    return errors


def export_evidence_bundle(
    conn: sqlite3.Connection,
    events: list[dict[str, Any]],
    verification_summary: dict[str, Any],
    export_path: Path,
) -> None:
    """Export complete self-contained evidence bundle for third-party auditing."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, session_id, position, attack_id, phase, prompt, response, verdict, created_at FROM attempts"
    )
    attempts = [
        {
            "id": row[0],
            "session_id": row[1],
            "position": row[2],
            "attack_id": row[3],
            "phase": row[4],
            "prompt": row[5],
            "response": row[6],
            "verdict": row[7],
            "created_at": row[8],
        }
        for row in cursor.fetchall()
    ]

    cursor.execute("SELECT id, session_id, position, rule_id, criterion, created_at FROM defenses")
    defenses = [
        {
            "id": row[0],
            "session_id": row[1],
            "position": row[2],
            "rule_id": row[3],
            "criterion": row[4],
            "created_at": row[5],
        }
        for row in cursor.fetchall()
    ]

    bundle = {
        "format": "bayora-audit-evidence-bundle-v1",
        "exported_at": events[-1]["ts"] if events else "",
        "summary": verification_summary,
        "events": events,
        "evidence": {
            "attempts": attempts,
            "defenses": defenses,
        },
    }

    export_path.parent.mkdir(parents=True, exist_ok=True)
    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2, sort_keys=True)


def verify_database(
    db_path: Path,
    witness_log_path: Path | None = None,
    export_path: Path | None = None,
) -> dict[str, Any]:
    """Execute complete offline verification of a Bayora SQLite database."""
    if not db_path.exists():
        return {
            "ok": False,
            "checked": 0,
            "errors": [{"kind": "db_not_found", "message": f"Database file not found: {db_path}"}],
        }

    try:
        # Open in URI read-only mode to prevent any writes
        conn = sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True)
    except sqlite3.Error as err:
        return {
            "ok": False,
            "checked": 0,
            "errors": [{"kind": "db_open_error", "message": f"Failed to open database: {err}"}],
        }

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'")
        if not cursor.fetchone():
            return {
                "ok": False,
                "checked": 0,
                "errors": [{"kind": "missing_table", "message": "Table 'audit_events' not found"}],
            }

        cursor.execute(
            "SELECT seq, ts, session_id, actor, event_type, evidence_ref, details, prev_hash, hash "
            "FROM audit_events ORDER BY seq ASC"
        )
        rows = cursor.fetchall()
        events = [
            {
                "seq": r[0],
                "ts": r[1],
                "session_id": r[2],
                "actor": r[3],
                "event_type": r[4],
                "evidence_ref": r[5],
                "details": r[6],
                "prev_hash": r[7],
                "hash": r[8],
            }
            for r in rows
        ]

        chain_res = verify_chain_events(events)
        evidence_errors = verify_evidence_records(conn, events)
        witness_errors: list[dict[str, Any]] = []

        if witness_log_path:
            witness_errors = verify_witness_log(witness_log_path, events)

        all_errors = chain_res["errors"] + evidence_errors + witness_errors
        is_ok = len(all_errors) == 0

        summary = {
            "ok": is_ok,
            "checked": chain_res["checked"],
            "head_seq": chain_res["head_seq"],
            "head_hash": chain_res["head_hash"],
            "chain_errors": chain_res["errors"],
            "evidence_errors": evidence_errors,
            "witness_errors": witness_errors,
            "all_errors": all_errors,
        }

        if export_path:
            export_evidence_bundle(conn, events, summary, export_path)

        return summary
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify cryptographic integrity of Bayora audit log and export evidence."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("backend/bayora.db"),
        help="Path to SQLite database file (default: backend/bayora.db)",
    )
    parser.add_argument(
        "--witness-log",
        type=Path,
        default=None,
        help="Path to external witness checkpoints.jsonl file",
    )
    parser.add_argument(
        "--export",
        type=Path,
        default=None,
        help="Export full verification evidence bundle as JSON file",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational output, exit code indicates verification status",
    )

    args = parser.parse_args()
    summary = verify_database(args.db, witness_log_path=args.witness_log, export_path=args.export)

    if not args.quiet:
        print("=" * 64)
        print("  BAYORA OFFLINE AUDIT CHAIN VERIFICATION REPORT")
        print("=" * 64)
        print(f"Database:     {args.db}")
        print(f"Events:       {summary['checked']}")
        print(f"Head Seq:     {summary.get('head_seq', 0)}")
        print(f"Head Hash:    {summary.get('head_hash', 'N/A')}")
        print(f"Witness Log:  {args.witness_log if args.witness_log else 'Not specified'}")

        if args.export:
            print(f"Exported to:  {args.export}")

        print("-" * 64)

        if summary["ok"]:
            print("STATUS:       VERIFIED (0 errors detected)")
            print("  [x] Genesis hash valid")
            print("  [x] Sequence numbers strictly monotonically increasing")
            print("  [x] SHA-256 hash chaining unbroken across all events")
            print("  [x] Evidence reference digests verified against attempt records")
            if args.witness_log:
                print("  [x] Witness checkpoint log alignment verified")
            print("=" * 64)
            return 0

        print("STATUS:       TAMPER DETECTED / VERIFICATION FAILED")
        for err in summary["all_errors"]:
            seq_prefix = f"[Seq {err['seq']}] " if "seq" in err else ""
            print(f"  [!] {seq_prefix}{err['kind']}: {err['message']}")
        print("=" * 64)
        return 1

    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
