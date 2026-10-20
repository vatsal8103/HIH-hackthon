"""External audit checkpoints held by the witness service (see witness/app.py).

After a stage commits, the control plane publishes the chain head (seq, hash) to the
witness, which keeps an append-only log the control plane cannot rewrite. Verification
compares the stored chain against every checkpoint, so a rewrite or truncation of any
anchored prefix is detected even if the database writer recomputes all local hashes.
Events after the latest checkpoint are not anchored and are reported as such.
"""

import os

from app import remote
from app.db import DB


def witness_url() -> str | None:
    return os.environ.get("BAYORA_WITNESS_URL") or None


def configured() -> bool:
    return witness_url() is not None


def _token() -> str:
    return os.environ.get("BAYORA_WITNESS_TOKEN", "")


def publish(db: DB) -> dict:
    """Anchor the current head. Call only after the transaction that wrote it has committed."""
    if not configured():
        return {"status": "not-configured"}
    head = db.one("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
    if head is None:
        return {"status": "empty"}
    try:
        record = remote.call(
            witness_url(),
            "POST",
            "/v1/checkpoints",
            json={"seq": head["seq"], "head_hash": head["hash"]},
            token=_token(),
        )
    except remote.RemoteError as exc:
        # The stage is already committed; report that its events are not yet anchored.
        status = "rejected" if exc.status == 409 else "failed"
        return {"status": status, "seq": head["seq"], "error": str(exc)}
    if not (_is_record(record) and isinstance(record.get("index"), int)):
        return {"status": "failed", "seq": head["seq"], "error": "witness returned a malformed record"}
    return {"status": "anchored", "seq": record["seq"], "index": record["index"]}


def _is_record(value) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("seq"), int)
        and isinstance(value.get("head_hash"), str)
    )


def compare(events: list[dict], records: list[dict]) -> list[dict]:
    """Errors where the chain disagrees with witness checkpoints."""
    by_seq = {event["seq"]: event for event in events}
    head_seq = events[-1]["seq"] if events else 0
    errors = []
    for record in records:
        event = by_seq.get(record["seq"])
        if event is None:
            kind = "truncated" if record["seq"] > head_seq else "missing"
            errors.append(
                {
                    "seq": record["seq"],
                    "kind": kind,
                    "message": f"Checkpointed event {record['seq']} is absent",
                }
            )
        elif event["hash"] != record["head_hash"]:
            errors.append(
                {
                    "seq": record["seq"],
                    "kind": "checkpoint",
                    "message": "Event hash differs from the witness checkpoint",
                }
            )
    return errors


def fetch() -> dict:
    """The witness log. A malformed reply raises RemoteError, exactly like an unreachable witness."""
    log = remote.call(witness_url(), "GET", "/v1/checkpoints")
    records = log.get("records") if isinstance(log, dict) else None
    integrity = log.get("integrity") if isinstance(log, dict) else None
    well_formed = (
        isinstance(records, list)
        and all(_is_record(r) for r in records)
        and isinstance(integrity, dict)
        and isinstance(integrity.get("ok"), bool)
    )
    if not well_formed:
        raise remote.RemoteError("witness returned a malformed checkpoint log")
    return log


def verify(events: list[dict]) -> dict:
    if not configured():
        return {"status": "not-configured", "errors": []}
    try:
        log = fetch()
    except remote.RemoteError as exc:
        return {"status": "unavailable", "errors": [{"seq": None, "kind": "witness", "message": str(exc)}]}
    records = log["records"]
    errors = compare(events, records)
    if not log["integrity"]["ok"]:
        reason = log["integrity"].get("reason") or "witness log failed its integrity check"
        errors.append({"seq": None, "kind": "witness", "message": reason})
    head_seq = events[-1]["seq"] if events else 0
    anchored = records[-1]["seq"] if records else 0
    return {
        "status": "mismatch" if errors else "ok",
        "checkpoints": len(records),
        "anchored_seq": anchored,
        "head_seq": head_seq,
        "unanchored_events": max(0, head_seq - anchored),
        "witness": log["integrity"],
        "errors": errors,
    }
