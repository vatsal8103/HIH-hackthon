"""Bayora audit witness: an append-only log of audit-chain checkpoints.

Runs as its own service with its own storage, which the control plane does not mount.
Each checkpoint record is one JSON line holding the checkpointed (seq, head_hash), the hash
of the previous record and its own hash. The witness only ever appends:

- a new checkpoint must come with an extension proof: every audit event from the anchored
  head + 1 to the new seq (at most MAX_EVENTS), contiguous, linked to the anchored head
  hash, each with a recomputed hash, ending at the claimed head_hash. A checkpoint that
  skips ahead, does not link, or names a hash its events do not produce is refused, so
  a caller cannot anchor a far-future or unrelated head;
- a lower seq is refused (regression); the same seq with a different hash is refused
  (rewrite); the same seq with the same hash is an idempotent repeat.

The proof shows the new head extends the anchored one. It cannot show the events are
true: a compromised control plane can still append fabricated events, but it cannot
change anything already anchored without that being detected.

Recovery (witness/recover.py) never deletes: an operator appends a `supersede` record,
with a reason, that takes the latest checkpoints out of force so appends can resume from
the last one still in force. Superseded records stay in the log and the control plane
keeps reporting any mismatch against them.

The whole log is re-read and re-validated on every request. A torn line left by an
interrupted write is ignored as long as the chain of valid records around it is intact;
a missing or altered record breaks that chain and the witness then refuses all appends
(fail closed) until an operator investigates. This is integrity by isolation, not
tamper-proof storage: anyone with write access to the witness volume can still alter it,
and such changes are detected only if they break the record chain.
"""

import fcntl
import hashlib
import hmac
import json
import os
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

GENESIS = "0" * 64
MAX_EVENTS = 500
CHECKPOINT_FIELDS = ("index", "seq", "head_hash", "received_at", "prev_record")
# Must equal app.audit.HASHED_FIELDS (tests/test_witness.py checks they agree).
EVENT_FIELDS = ("seq", "ts", "session_id", "actor", "event_type", "evidence_ref", "details", "prev_hash")

app = FastAPI(title="Bayora audit witness", version="0.2.0")


class Event(BaseModel):
    seq: int
    ts: str
    session_id: str | None
    actor: str
    event_type: str
    evidence_ref: str | None
    details: str
    prev_hash: str
    hash: str


class Checkpoint(BaseModel):
    seq: int = Field(ge=1)
    head_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    events: list[Event] = Field(default_factory=list, max_length=MAX_EVENTS)


def log_path() -> Path:
    return Path(os.environ.get("BAYORA_WITNESS_DATA", "/data")) / "checkpoints.jsonl"


def _digest(material: dict) -> str:
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def record_hash(record: dict) -> str:
    if record.get("type") == "supersede":
        return _digest({k: v for k, v in record.items() if k != "record_hash"})
    return _digest({k: record[k] for k in CHECKPOINT_FIELDS})


def event_hash(event: dict) -> str:
    return _digest({field: event[field] for field in EVENT_FIELDS})


def _record_problem(record: dict, in_force: list[dict]) -> str | None:
    """Why this (hash-valid, correctly linked) record may not follow the ones before it."""
    if record.get("type") == "supersede":
        targets, reason = record.get("supersedes"), record.get("reason")
        suffix = (
            [r["index"] for r in in_force][-len(targets) :] if isinstance(targets, list) and targets else None
        )
        if suffix != targets:
            return "supersede record must name the latest checkpoints still in force"
        if not isinstance(reason, str) or len(reason.strip()) < 10:
            return "supersede record lacks a reason"
        return None
    if set(record) != {*CHECKPOINT_FIELDS, "record_hash"}:
        return "checkpoint record has unexpected fields"
    if in_force and record["seq"] <= in_force[-1]["seq"]:
        return "checkpoint seq does not increase"
    return None


def _parse() -> tuple[dict, int, str]:
    """Validate the log. Returns (log, number of records, hash of the last record)."""
    path = log_path()
    text = path.read_text() if path.exists() else ""
    checkpoints, recoveries, in_force, ignored = [], [], [], 0
    count, prev = 0, GENESIS
    for line in text.splitlines():
        try:
            record = json.loads(line)
            valid = record_hash(record) == record["record_hash"]
        except (ValueError, KeyError, TypeError, AttributeError):
            ignored += 1  # torn or garbage line; harmless only if the chain below stays intact
            continue
        if not valid or record["prev_record"] != prev or record["index"] != count:
            problem = f"record chain broken at index {count}"
        else:
            problem = _record_problem(record, in_force)
        if problem:
            integrity = {"ok": False, "reason": f"{problem} (index {count})", "ignored_lines": ignored}
            log = {"records": checkpoints, "recoveries": recoveries, "head": None, "integrity": integrity}
            return log, count, prev
        if record.get("type") == "supersede":
            recoveries.append(record)
            for target in in_force[-len(record["supersedes"]) :]:
                target["superseded_by"] = {"index": record["index"], "reason": record["reason"]}
            del in_force[-len(record["supersedes"]) :]
        else:
            checkpoints.append(record)
            in_force.append(record)
        count, prev = count + 1, record["record_hash"]
    integrity = {
        "ok": True,
        "reason": None,
        "ignored_lines": ignored,
        "torn_tail": bool(text) and not text.endswith("\n"),
    }
    head = in_force[-1] if in_force else None
    return (
        {"records": checkpoints, "recoveries": recoveries, "head": head, "integrity": integrity},
        count,
        prev,
    )


def load() -> dict:
    return _parse()[0]


@contextmanager
def locked():
    """Serialise writers across processes (the API and the recovery CLI)."""
    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def append(fields: dict) -> dict:
    """Append one record after the current tail. Call while holding `locked()`."""
    log, count, prev = _parse()
    if not log["integrity"]["ok"]:
        raise RuntimeError(f"Witness log failed validation ({log['integrity']['reason']}); refusing appends")
    record = {
        "index": count,
        **fields,
        "received_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
        "prev_record": prev,
    }
    record["record_hash"] = record_hash(record)
    path = log_path()
    with path.open("a") as handle:
        if path.stat().st_size and not path.read_text().endswith("\n"):
            handle.write("\n")  # isolate a torn line from an interrupted earlier write
        handle.write(json.dumps(record, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return record


def extension_problem(body: Checkpoint, base_seq: int, base_hash: str) -> str | None:
    """Why body.events do not prove body.head_hash extends the anchored head, if they don't."""
    expected = list(range(base_seq + 1, body.seq + 1))
    if [event.seq for event in body.events] != expected:
        return (
            f"extension proof must carry exactly events {base_seq + 1}..{body.seq} "
            f"(at most {MAX_EVENTS} per checkpoint)"
        )
    prev = base_hash
    for event in body.events:
        data = event.model_dump()
        if data["prev_hash"] != prev:
            return f"event {event.seq} does not link to {'the anchored head' if prev == base_hash else 'its predecessor'}"
        if event_hash(data) != data["hash"]:
            return f"event {event.seq} hash does not match its contents"
        prev = data["hash"]
    if prev != body.head_hash:
        return "head_hash is not the hash of the last proven event"
    return None


def _authorised(authorization: str | None) -> bool:
    expected = os.environ.get("BAYORA_WITNESS_TOKEN", "")
    return bool(expected) and hmac.compare_digest(authorization or "", f"Bearer {expected}")


@app.get("/healthz")
def health():
    return {"status": "ok", "integrity": load()["integrity"]}


@app.get("/v1/checkpoints")
def list_checkpoints():
    return load()


@app.post("/v1/checkpoints")
def append_checkpoint(body: Checkpoint, authorization: str | None = Header(default=None)):
    if not _authorised(authorization):
        raise HTTPException(401, "Missing or invalid witness token")
    with locked():
        log = load()
        if not log["integrity"]["ok"]:
            raise HTTPException(
                503, f"Witness log failed validation ({log['integrity']['reason']}); refusing appends"
            )
        head = log["head"]
        base_seq, base_hash = (head["seq"], head["head_hash"]) if head else (0, GENESIS)
        if body.seq < base_seq:
            raise HTTPException(409, f"Checkpoint regression: seq {body.seq} < anchored {base_seq}")
        if body.seq == base_seq:
            if body.head_hash == base_hash:
                return head  # idempotent repeat
            raise HTTPException(409, f"Conflicting hash for already anchored seq {body.seq}")
        problem = extension_problem(body, base_seq, base_hash)
        if problem:
            raise HTTPException(409, f"Checkpoint refused: {problem}")
        return append({"seq": body.seq, "head_hash": body.head_hash})
