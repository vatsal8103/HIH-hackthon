"""Controlled recovery for the witness log. Run inside the witness container:

    docker compose exec witness .venv/bin/python -m witness.recover status
    docker compose exec witness .venv/bin/python -m witness.recover supersede \\
        --from-index 7 --expect-head-seq 1000000 --reason "far-future checkpoint, incident 2026-10-20"

`supersede` appends a record that takes every checkpoint still in force at or after
--from-index out of force, so the control plane can anchor again from the last checkpoint
before it. Nothing is deleted or rewritten: the superseded records, the reason and the time
stay in the hash-linked log, the control plane keeps reporting any mismatch against them,
and audit verification does not turn green because of a recovery.

--expect-head-seq must name the seq of the current head, so a recovery is never applied to
a log that changed since the operator looked at it. A log whose record chain is broken
cannot be recovered this way; that needs investigation of the volume itself.
"""

import argparse
import json
import sys

from witness import app as witness


def status() -> dict:
    log = witness.load()
    return {
        "integrity": log["integrity"],
        "head": log["head"] and {k: log["head"][k] for k in ("index", "seq", "head_hash")},
        "checkpoints": len(log["records"]),
        "superseded": [
            {"index": r["index"], "seq": r["seq"], **r["superseded_by"]}
            for r in log["records"]
            if "superseded_by" in r
        ],
    }


def supersede(from_index: int, expect_head_seq: int, reason: str) -> dict:
    if len(reason.strip()) < 10:
        raise ValueError("give a reason of at least 10 characters")
    with witness.locked():
        log = witness.load()
        if not log["integrity"]["ok"]:
            raise ValueError(
                f"log failed validation ({log['integrity']['reason']}); supersede cannot repair it"
            )
        head = log["head"]
        if head is None or head["seq"] != expect_head_seq:
            raise ValueError(
                f"current head is seq {head and head['seq']}, not {expect_head_seq}; re-check status"
            )
        targets = [
            r["index"] for r in log["records"] if "superseded_by" not in r and r["index"] >= from_index
        ]
        if not targets:
            raise ValueError(f"no checkpoint in force at or after index {from_index}")
        return witness.append({"type": "supersede", "supersedes": targets, "reason": reason.strip()})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Bayora witness recovery (append-only)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    sup = commands.add_parser("supersede")
    sup.add_argument("--from-index", type=int, required=True)
    sup.add_argument("--expect-head-seq", type=int, required=True)
    sup.add_argument("--reason", required=True)
    args = parser.parse_args(argv)
    try:
        result = (
            status()
            if args.command == "status"
            else supersede(args.from_index, args.expect_head_seq, args.reason)
        )
    except ValueError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
