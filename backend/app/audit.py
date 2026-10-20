"""Sequential, hash-linked audit log.

Each event stores the previous event's hash and a SHA-256 over its own fields,
so editing, deleting or reordering stored events breaks verification. A local
chain cannot stop someone who controls the database from rewriting every event
and recomputing all hashes; detecting that needs the head hash anchored
somewhere the attacker cannot write (not implemented).
"""

import hashlib
import json
from datetime import UTC, datetime

from app.db import DB

GENESIS = "0" * 64
HASHED_FIELDS = ("seq", "ts", "session_id", "actor", "event_type", "evidence_ref", "details", "prev_hash")


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def event_hash(event: dict) -> str:
    material = json.dumps(
        {field: event[field] for field in HASHED_FIELDS}, sort_keys=True, separators=(",", ":")
    )
    return sha256(material)


def append(
    db: DB, session_id: str | None, actor: str, event_type: str, evidence_ref: str | None, details: dict
) -> dict:
    db.lock_audit()
    head = db.one("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
    event = {
        "seq": head["seq"] + 1 if head else 1,
        "ts": now(),
        "session_id": session_id,
        "actor": actor,
        "event_type": event_type,
        "evidence_ref": evidence_ref,
        "details": json.dumps(details, sort_keys=True, separators=(",", ":")),
        "prev_hash": head["hash"] if head else GENESIS,
    }
    event["hash"] = event_hash(event)
    db.execute(
        "INSERT INTO audit_events (seq, ts, session_id, actor, event_type, evidence_ref, details, prev_hash, hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        tuple(event[f] for f in (*HASHED_FIELDS, "hash")),
    )
    return event


def load(db: DB) -> list[dict]:
    """All events in stored sequence order (the order an auditor would replay)."""
    return db.all("SELECT * FROM audit_events ORDER BY seq")


def verify_events(events: list[dict]) -> dict:
    """Check sequence continuity, hash links and per-event hashes, in the given order."""
    errors = []
    expected_seq, expected_prev = 1, GENESIS
    for event in events:
        seq = event["seq"]
        if seq != expected_seq:
            problem = "missing event(s) before this one" if seq > expected_seq else "event out of order"
            errors.append(
                {"seq": seq, "kind": "sequence", "message": f"Expected seq {expected_seq}: {problem}"}
            )
        if event["prev_hash"] != expected_prev:
            errors.append(
                {"seq": seq, "kind": "link", "message": "prev_hash does not match the preceding event"}
            )
        if event_hash(event) != event["hash"]:
            errors.append(
                {"seq": seq, "kind": "hash", "message": "Event contents do not match its stored hash"}
            )
        expected_seq, expected_prev = seq + 1, event["hash"]
    return {
        "ok": not errors,
        "checked": len(events),
        "head_hash": events[-1]["hash"] if events else GENESIS,
        "errors": errors,
    }


def verify_evidence(db: DB, events: list[dict]) -> list[dict]:
    """Check that referenced attempt records still match the digests recorded in the chain."""
    errors = []
    for event in events:
        ref = event["evidence_ref"] or ""
        if not ref.startswith("attempt:"):
            continue
        details = json.loads(event["details"])
        row = db.one("SELECT prompt, response, verdict FROM attempts WHERE id = ?", (ref.split(":", 1)[1],))
        if row is None:
            errors.append({"seq": event["seq"], "kind": "evidence", "message": f"{ref} no longer exists"})
            continue
        mismatched = (
            ("prompt_sha256" in details and details["prompt_sha256"] != sha256(row["prompt"]))
            or ("response_sha256" in details and details["response_sha256"] != sha256(row["response"] or ""))
            or ("verdict" in details and details["verdict"] != row["verdict"])
        )
        if mismatched:
            errors.append(
                {"seq": event["seq"], "kind": "evidence", "message": f"{ref} differs from recorded digest"}
            )
    return errors


# Role actions and what the signing role must have authorised for each.
ROLE_EVENTS = {
    "red.baseline_submitted": ("red", "red:submit", ("attack_id", "phase")),
    "red.retest_submitted": ("red", "red:submit", ("attack_id", "phase")),
    "blue.defense_applied": ("blue", "blue:defend", ("rule_id",)),
    "blue.findings_read": ("blue", "blue:read", ()),
}


def verify_credentials(events: list[dict]) -> tuple[list[dict], dict]:
    """Check role-signed tokens embedded in role-action events.

    A signed event must verify against that role's public key, name that role, action and
    session, and authorise exactly the recorded parameters. Once the chain holds a signed
    role event, every later role event must be signed too: an unsigned one would be a role
    action the control plane recorded without the role's own authorisation.
    """
    from app import credentials, tokens  # local: credentials imports db, which this module also uses

    errors, signed, unsigned, signing_started = [], 0, 0, False
    for event in events:
        spec = ROLE_EVENTS.get(event["event_type"])
        if spec is None:
            continue
        role, action, fields = spec
        details = json.loads(event["details"])
        token = details.get("credential")
        if token is None:
            unsigned += 1
            if signing_started:
                errors.append(
                    {
                        "seq": event["seq"],
                        "kind": "credential",
                        "message": "Unsigned role event after signing began",
                    }
                )
            continue
        signing_started, problem = True, None
        try:
            claims = tokens.verify(token, credentials.role_keys(role))
            grant = tokens.verify(claims.get("grant", ""), credentials.cp_public_keys())
            if (claims.get("role"), claims.get("act"), claims.get("sid")) != (
                role,
                action,
                event["session_id"],
            ):
                problem = "token was issued for another role, action or session"
            elif grant.get("role") != role or grant.get("sid") != event["session_id"]:
                problem = "embedded grant does not cover this role and session"
            elif any(
                claims.get("req", {}).get(f, "baseline" if f == "phase" else None) != details.get(f)
                for f in fields
            ):
                problem = "token does not authorise the recorded parameters"
        except tokens.TokenError as exc:
            problem = f"credential does not verify ({exc})"
        if problem:
            errors.append({"seq": event["seq"], "kind": "credential", "message": problem})
        else:
            signed += 1
    return errors, {"signed": signed, "unsigned": unsigned}


def verify(db: DB) -> dict:
    events = load(db)
    result = verify_events(events)
    credential_errors, role_events = verify_credentials(events)
    result["errors"] += verify_evidence(db, events) + credential_errors
    result["role_events"] = role_events
    result["ok"] = not result["errors"]
    return result


def tamper_test(events: list[dict], mode: str, seq: int | None, check=None) -> dict:
    """Apply a simulated tampering to an in-memory copy of the chain and verify it.

    The stored chain is never modified. `check`, if given, compares the tampered copy
    with the witness checkpoints and returns the disagreements.
    """
    if len(events) < 3:
        raise ValueError("Need at least three audit events; run a test first")
    chain = [dict(e) for e in events]
    index = next((i for i, e in enumerate(chain) if e["seq"] == seq), len(chain) // 2)
    index = min(index, len(chain) - 2)
    target_seq = chain[index]["seq"]

    if mode == "modify":
        details = json.loads(chain[index]["details"])
        if "verdict" in details:
            details["verdict"] = "pass" if details["verdict"] == "fail" else "fail"
        else:
            details["note"] = "edited"
        chain[index]["details"] = json.dumps(details, sort_keys=True, separators=(",", ":"))
        summary = f"Edited the details of event {target_seq} without updating its hash."
    elif mode == "delete":
        del chain[index]
        summary = f"Deleted event {target_seq} from the chain."
    elif mode == "reorder":
        chain[index], chain[index + 1] = chain[index + 1], chain[index]
        summary = f"Swapped events {target_seq} and {chain[index]['seq']}."
    elif mode == "rewrite":
        details = json.loads(chain[index]["details"])
        details["note"] = "rewritten"
        chain[index]["details"] = json.dumps(details, sort_keys=True, separators=(",", ":"))
        for i in range(index, len(chain)):
            chain[i]["prev_hash"] = chain[i - 1]["hash"] if i else GENESIS
            chain[i]["hash"] = event_hash(chain[i])
        summary = (
            f"Edited event {target_seq} and recomputed every later hash, as an attacker with full "
            "database control could. Local verification cannot detect this; only comparison with an "
            "externally anchored head hash would."
        )
    else:
        raise ValueError(f"Unknown tamper mode {mode}")

    result = verify_events(chain)
    outcome = {
        "mode": mode,
        "seq": target_seq,
        "summary": summary,
        "original_head": events[-1]["hash"],
        "tampered_head": result["head_hash"],
        "verification": result,
    }
    if check is not None:
        errors = check(chain)
        outcome["checkpoint"] = {"detected": bool(errors), "errors": errors}
    return outcome
