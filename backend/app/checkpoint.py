"""External audit checkpoints held by the witness service (see witness/app.py).

After a stage commits, the control plane publishes the chain head (seq, hash) to the
witness together with every event since the witness's current head (in batches of
BATCH), so the witness can check the new head really extends the anchored one. The
witness keeps an append-only log the control plane cannot rewrite. Verification compares
the stored chain against every checkpoint, so a rewrite or truncation of any anchored
prefix is detected even if the database writer recomputes all local hashes. Events after
the latest checkpoint are not anchored and are reported as such.

If the witness head does not match the local chain, nothing is published: that needs an
operator (witness/recover.py). Checkpoints an operator superseded there are still
compared, and a mismatch against one is still an error, labelled with the recorded reason.
"""

import os

from app import remote
from app.db import DB

BATCH = 500  # the witness accepts at most this many events per checkpoint


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
        anchored = in_force(fetch()["records"])
        base = anchored["seq"] if anchored else 0
        if anchored:
            row = db.one("SELECT hash FROM audit_events WHERE seq = ?", (base,))
            if row is None or row["hash"] != anchored["head_hash"]:
                return {
                    "status": "rejected",
                    "seq": head["seq"],
                    "error": f"Witness head seq {base} does not match the local chain; nothing was published. "
                    "An operator must investigate (witness/recover.py).",
                }
        record = anchored
        while base < head["seq"]:
            events = db.all(
                "SELECT seq, ts, session_id, actor, event_type, evidence_ref, details, prev_hash, hash "
                "FROM audit_events WHERE seq > ? AND seq <= ? ORDER BY seq",
                (base, base + BATCH),
            )
            last = events[-1]
            record = remote.call(
                witness_url(),
                "POST",
                "/v1/checkpoints",
                json={"seq": last["seq"], "head_hash": last["hash"], "events": events},
                token=_token(),
            )
            if not (_is_record(record) and isinstance(record.get("index"), int)):
                return {
                    "status": "failed",
                    "seq": head["seq"],
                    "error": "witness returned a malformed record",
                }
            base = record["seq"]
    except remote.RemoteError as exc:
        # The stage is already committed; report that its events are not yet anchored.
        status = "rejected" if exc.status == 409 else "failed"
        return {"status": status, "seq": head["seq"], "error": str(exc)}
    return {"status": "anchored", "seq": record["seq"], "index": record["index"]}


def in_force(records: list[dict]) -> dict | None:
    """The latest checkpoint an operator has not superseded: what new checkpoints extend."""
    current = [r for r in records if "superseded_by" not in r]
    return current[-1] if current else None


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
            message = f"Checkpointed event {record['seq']} is absent"
        elif event["hash"] != record["head_hash"]:
            kind, message = "checkpoint", "Event hash differs from the witness checkpoint"
        else:
            continue
        superseded = record.get("superseded_by")
        if isinstance(superseded, dict):  # recovery never makes a mismatch disappear
            kind = "superseded"
            message += (
                f" (superseded by witness record {superseded.get('index')}: {superseded.get('reason')})"
            )
        errors.append({"seq": record["seq"], "kind": kind, "message": message})
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
    current = in_force(records)
    anchored = current["seq"] if current else 0
    return {
        "status": "mismatch" if errors else "ok",
        "checkpoints": len(records),
        "anchored_seq": anchored,
        "head_seq": head_seq,
        "unanchored_events": max(0, head_seq - anchored),
        "superseded": [
            {"index": r.get("index"), "seq": r["seq"], **r["superseded_by"]}
            for r in records
            if isinstance(r.get("superseded_by"), dict)
        ],
        "witness": log["integrity"],
        "errors": errors,
    }
