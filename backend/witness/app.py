"""Bayora audit witness: an append-only log of audit-chain checkpoints.

Runs as its own service with its own storage, which the control plane does not mount.
Each record is one JSON line holding the checkpointed (seq, head_hash), the hash of the
previous record and its own hash. The witness only ever appends:

- a checkpoint must not move backwards (seq lower than the latest is refused);
- the same seq with a different hash is refused (that would be a rewrite);
- the same seq with the same hash is an idempotent repeat.

The whole log is re-read and re-validated on every request. A torn line left by an
interrupted write is ignored as long as the chain of valid records around it is intact;
a missing or altered record breaks that chain and the witness then refuses all appends
(fail closed) until an operator investigates. This is integrity by isolation, not
tamper-proof storage: anyone with write access to the witness volume can still alter it,
and such changes are detected only if they break the record chain.
"""

import hashlib
import hmac
import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

GENESIS = "0" * 64
_lock = threading.Lock()

app = FastAPI(title="Bayora audit witness", version="0.1.0")


class Checkpoint(BaseModel):
    seq: int = Field(ge=1)
    head_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


def log_path() -> Path:
    return Path(os.environ.get("BAYORA_WITNESS_DATA", "/data")) / "checkpoints.jsonl"


def record_hash(record: dict) -> str:
    material = {k: record[k] for k in ("index", "seq", "head_hash", "received_at", "prev_record")}
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load() -> dict:
    """Parse and validate the log. Returns valid records plus an integrity verdict."""
    path = log_path()
    text = path.read_text() if path.exists() else ""
    records, ignored = [], 0
    prev = GENESIS
    for line in text.splitlines():
        try:
            record = json.loads(line)
            valid = record_hash(record) == record["record_hash"]
        except (ValueError, KeyError, TypeError):
            ignored += 1  # torn or garbage line; harmless only if the chain below stays intact
            continue
        if not valid or record["prev_record"] != prev or record["index"] != len(records):
            return {
                "records": records,
                "integrity": {
                    "ok": False,
                    "reason": f"record chain broken at index {len(records)}",
                    "ignored_lines": ignored,
                },
            }
        records.append(record)
        prev = record["record_hash"]
    return {
        "records": records,
        "integrity": {
            "ok": True,
            "reason": None,
            "ignored_lines": ignored,
            "torn_tail": bool(text) and not text.endswith("\n"),
        },
    }


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
    with _lock:
        log = load()
        if not log["integrity"]["ok"]:
            raise HTTPException(
                503, f"Witness log failed validation ({log['integrity']['reason']}); refusing appends"
            )
        records = log["records"]
        if records:
            latest = records[-1]
            if body.seq < latest["seq"]:
                raise HTTPException(409, f"Checkpoint regression: seq {body.seq} < anchored {latest['seq']}")
            if body.seq == latest["seq"]:
                if body.head_hash == latest["head_hash"]:
                    return latest  # idempotent repeat
                raise HTTPException(409, f"Conflicting hash for already anchored seq {body.seq}")
        record = {
            "index": len(records),
            "seq": body.seq,
            "head_hash": body.head_hash,
            "received_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "prev_record": records[-1]["record_hash"] if records else GENESIS,
        }
        record["record_hash"] = record_hash(record)
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as handle:
            if path.stat().st_size and not path.read_text().endswith("\n"):
                handle.write("\n")  # isolate a torn line from an interrupted earlier write
            handle.write(json.dumps(record, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return record
