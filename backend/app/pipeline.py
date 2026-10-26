"""Test-session state machine and the role-scoped services each stage uses.

A session advances one stage per call so the UI can show each real transition:
created → attack → respond → evaluate → defend → retest → isolation → report

Role actions run in this process by default. When BAYORA_<ROLE>_AGENT_URL is set, the
stage instead calls that role's isolated agent (see app/remote.py and agents/), and the
agent acts only through its own role-scoped API with its own token.
"""

import json
import os
import uuid

from app import audit, checkpoint, credentials, defenses, evaluator, isolation, providers, remote
from app.attacks import BY_ID
from app.db import DB

STAGES = ["attack", "respond", "evaluate", "defend", "retest", "isolation", "report"]
RED_ACTIONS = ["red:read", "red:submit"]  # what a Red dispatch grant allows
BLUE_ACTIONS = ["blue:read", "blue:defend"]
RISK_ORDER = ["none", "low", "medium", "high", "critical"]


class Conflict(Exception):
    """The session is not in a state that allows the requested action."""


def new_id() -> str:
    return str(uuid.uuid4())


def get_session(db: DB, session_id: str) -> dict | None:
    session = db.one("SELECT * FROM sessions WHERE id = ?", (session_id,))
    if session:
        session["attack_ids"] = json.loads(session["attack_ids"])
        session["report"] = json.loads(session["report"]) if session["report"] else None
    return session


def next_stage(session: dict) -> str | None:
    if session["stage"] == "created":
        return STAGES[0]
    index = STAGES.index(session["stage"]) + 1
    return STAGES[index] if index < len(STAGES) else None


def create_session(db: DB, attack_ids: list[str]) -> str:
    session_id = new_id()
    db.execute(
        "INSERT INTO sessions (id, created_at, stage, attack_ids) VALUES (?, ?, 'created', ?)",
        (session_id, audit.now(), json.dumps(attack_ids)),
    )
    audit.append(
        db, session_id, "operator", "session.created", f"session:{session_id}", {"attack_ids": attack_ids}
    )
    return session_id


def advance(
    db: DB, session_id: str, app, operator_auth: str | None = None, expected: str | None = None
) -> str:
    """Run the next stage. `app` and the caller's `operator_auth` are used for isolation probes.

    `expected` is the stage the caller means to run; if another request already ran it, the
    call is refused instead of running the stage after it (a double click runs one stage).
    Concurrent calls for one session run the stage once: PostgreSQL holds the session row
    for the whole stage (FOR NO KEY UPDATE, which still lets role agents insert rows that
    reference the session), and the final compare-and-set refuses a stage whose session
    moved on meanwhile (SQLite), rolling back everything the loser wrote.
    """
    if db.is_pg:
        db.execute("SELECT id FROM sessions WHERE id = ? FOR NO KEY UPDATE", (session_id,))
    session = get_session(db, session_id)
    current = session["stage"]
    stage = next_stage(session)
    if stage is None:
        raise Conflict("Session already completed")
    if expected is not None and expected != stage:
        raise Conflict(
            f"Stage {expected!r} is not next for this session (next: {stage!r}); it may already have run"
        )
    if stage == "isolation":
        isolation.run_checks(db, app, session_id, operator_auth)  # probes run before this stage writes
    else:
        STAGE_HANDLERS[stage](db, session)
    moved = db.execute(
        "UPDATE sessions SET stage = ? WHERE id = ? AND stage = ?", (stage, session_id, current)
    ).rowcount
    if moved != 1:
        raise Conflict(
            f"Another request advanced this session while {stage!r} ran; this attempt was rolled back"
        )
    return stage


# ---------------------------------------------------------------- role services


def evidence(credential: str | None) -> dict:
    """Audit detail carrying the role-signed token that authorised an action, if there was one."""
    return {"credential": credential} if credential else {}


def dispatch(role: str, path: str, session_id: str, actions: list[str], payload: dict, timeout: float = 20.0):
    """Call a role agent with a grant scoped to this role, this session and these actions."""
    grant = credentials.issue_grant(role, session_id, actions)
    return remote.call_agent(
        role, path, {**payload, "session_id": session_id, "grant": grant}, timeout=timeout
    )


def target_timeout() -> float:
    """How long the control plane waits for one target answer. A live model needs more than the default."""
    raw = os.environ.get("BAYORA_TARGET_TIMEOUT", "20")
    try:
        return max(1.0, min(float(raw), 900.0))
    except ValueError as exc:
        raise RuntimeError(f"BAYORA_TARGET_TIMEOUT={raw!r} is not a number") from exc


def submit_attempt(db: DB, session_id: str, attack_id: str, phase: str, credential: str | None = None) -> str:
    """Red Team: queue a library test case for the target."""
    attempt_id = new_id()
    prompt = BY_ID[attack_id]["prompt"]
    db.execute(
        "INSERT INTO attempts (id, session_id, position, attack_id, phase, prompt, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (attempt_id, session_id, _count(db, "attempts", session_id), attack_id, phase, prompt, audit.now()),
    )
    audit.append(
        db,
        session_id,
        "red",
        f"red.{phase}_submitted",
        f"attempt:{attempt_id}",
        {
            "attack_id": attack_id,
            "phase": phase,
            "prompt_sha256": audit.sha256(prompt),
            **evidence(credential),
        },
    )
    return attempt_id


def red_submit(
    db: DB, session: dict, attack_id: str, phase: str = "baseline", credential: str | None = None
) -> str:
    if phase == "retest":
        # Retests are allowed only once defenses are in place and before the retest stage ends.
        if session["stage"] != "defend":
            raise Conflict("Retests can only be submitted after the defend stage")
        if not _attempt(db, session["id"], attack_id, "baseline"):
            raise Conflict(f"{attack_id} has no baseline attempt in this session")
        if _attempt(db, session["id"], attack_id, "retest"):
            raise Conflict(f"{attack_id} was already retested in this session")
        return submit_attempt(db, session["id"], attack_id, "retest", credential)
    if session["stage"] not in ("created", "attack"):
        raise Conflict("Attacks can only be submitted before the target responds")
    if attack_id in session["attack_ids"] and _attempt(db, session["id"], attack_id, "baseline"):
        raise Conflict(f"{attack_id} was already submitted in this session")
    if attack_id not in session["attack_ids"]:
        session["attack_ids"].append(attack_id)
        db.execute(
            "UPDATE sessions SET attack_ids = ? WHERE id = ?",
            (json.dumps(session["attack_ids"]), session["id"]),
        )
    return submit_attempt(db, session["id"], attack_id, "baseline", credential)


def red_view(db: DB, session_id: str) -> list[dict]:
    """Red Team sees its prompts and outcomes, never which defensive rule acted."""
    rows = db.all("SELECT * FROM attempts WHERE session_id = ? ORDER BY position", (session_id,))
    return [
        {
            "id": r["id"],
            "attack_id": r["attack_id"],
            "phase": r["phase"],
            "prompt": r["prompt"],
            "response": r["response"],
            "verdict": r["verdict"],
            "blocked": r["blocked_by"] is not None,
        }
        for r in rows
    ]


def target_inbox(db: DB, session_id: str) -> list[dict]:
    """Target sees only prompts still awaiting its response: no labels, criteria or past sessions."""
    rows = db.all(
        "SELECT id, phase, prompt FROM attempts WHERE session_id = ? AND response IS NULL ORDER BY position",
        (session_id,),
    )
    return [{"attempt_id": r["id"], "phase": r["phase"], "prompt": r["prompt"]} for r in rows]


def blue_findings(db: DB, session_id: str) -> list[dict]:
    """Blue Team sees redacted failures: criterion, severity, evidence. Never the attack prompt."""
    rows = db.all(
        "SELECT phase, response, criteria FROM attempts WHERE session_id = ? AND verdict = 'fail' "
        "ORDER BY position",
        (session_id,),
    )
    findings = []
    for row in rows:
        for result in json.loads(row["criteria"]):
            if result["passed"]:
                continue
            criterion = evaluator.CRITERIA[result["id"]]
            findings.append(
                {
                    "finding_id": f"F-{len(findings) + 1:02d}",
                    "phase": row["phase"],
                    "criterion": result["id"],
                    "criterion_title": criterion["title"],
                    "severity": criterion["severity"],
                    "evidence": result["evidence"],
                    "response_excerpt": evaluator.redact(row["response"])[:180],
                }
            )
    return findings


def active_rules(db: DB, session_id: str) -> list[str]:
    return [
        r["rule_id"]
        for r in db.all("SELECT rule_id FROM defenses WHERE session_id = ? ORDER BY position", (session_id,))
    ]


def apply_defense(db: DB, session: dict, rule_id: str, criterion: str, credential: str | None = None) -> bool:
    """Blue Team: activate a rule for this session. Returns False if it was already active."""
    if session["stage"] not in ("evaluate", "defend"):
        raise Conflict("Defenses can only be applied after evaluation and before retest")
    if rule_id in active_rules(db, session["id"]):
        return False
    defense_id = new_id()
    db.execute(
        "INSERT INTO defenses (id, session_id, position, rule_id, criterion, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (defense_id, session["id"], _count(db, "defenses", session["id"]), rule_id, criterion, audit.now()),
    )
    audit.append(
        db,
        session["id"],
        "blue",
        "blue.defense_applied",
        f"defense:{defense_id}",
        {"rule_id": rule_id, "criterion": criterion, **evidence(credential)},
    )
    return True


# ---------------------------------------------------------------- stages


def _count(db: DB, table: str, session_id: str) -> int:
    return db.one(f"SELECT COUNT(*) AS n FROM {table} WHERE session_id = ?", (session_id,))["n"]


def _attempt(db: DB, session_id: str, attack_id: str, phase: str) -> dict | None:
    return db.one(
        "SELECT * FROM attempts WHERE session_id = ? AND attack_id = ? AND phase = ?",
        (session_id, attack_id, phase),
    )


def _require_submitted(db: DB, session: dict, phase: str) -> None:
    missing = [a for a in session["attack_ids"] if not _attempt(db, session["id"], a, phase)]
    if missing:
        raise remote.RemoteError(f"red agent did not submit {phase} attempts for {', '.join(missing)}")


def stage_attack(db: DB, session: dict) -> None:
    if remote.agent_url("red"):
        dispatch(
            "red",
            "/v1/act",
            session["id"],
            RED_ACTIONS,
            {"attack_ids": session["attack_ids"], "phase": "baseline"},
        )
        _require_submitted(db, session, "baseline")
        return
    for attack_id in session["attack_ids"]:
        if not _attempt(db, session["id"], attack_id, "baseline"):
            submit_attempt(db, session["id"], attack_id, "baseline")


def _target_model(session_id: str):
    """The model the guardrails wrap: the isolated target agent if configured, else the local provider.

    `info` carries the provider identity and, per answer, `metadata`: the whitelisted provider
    metadata of the latest call (finish reason, token counts). `_respond` resets it before each
    prompt, so a prompt blocked before reaching the model never inherits another answer's metadata.
    """
    if not remote.agent_url("target"):
        provider = providers.get_provider()
        info = {"provider": provider.id, "kind": provider.kind, "metadata": {}}

        def local(text: str) -> str:
            answer, info["metadata"] = provider.respond_with_metadata(text)
            return answer

        return local, info
    info = {"provider": None, "kind": None, "metadata": {}}

    def model(text: str) -> str:
        reply = dispatch(
            "target", "/v1/respond", session_id, ["target:respond"], {"prompt": text}, target_timeout()
        )
        if not isinstance(reply, dict) or not isinstance(reply.get("response"), str):
            raise remote.RemoteError("target agent returned a malformed response")
        info.update(
            provider=str(reply.get("provider")),
            kind=str(reply.get("kind")),
            metadata=providers.safe_metadata(reply.get("metadata")),  # re-checked: the agent is not trusted
        )
        return reply["response"]

    return model, info


def _respond(db: DB, session_id: str, phase: str) -> None:
    rules = active_rules(db, session_id)
    model, info = _target_model(session_id)
    pending = db.all(
        "SELECT id, prompt FROM attempts WHERE session_id = ? AND phase = ? AND response IS NULL ORDER BY position",
        (session_id, phase),
    )
    for row in pending:
        info["metadata"] = {}
        result = defenses.run_target(row["prompt"], rules, model)
        db.execute(
            "UPDATE attempts SET response = ?, blocked_by = ?, filtered_by = ?, transformed_by = ? WHERE id = ?",
            (
                result["response"],
                result["blocked_by"],
                result["filtered_by"],
                result["transformed_by"],
                row["id"],
            ),
        )
        details = {
            "phase": phase,
            "response_sha256": audit.sha256(result["response"]),
            "blocked_by": result["blocked_by"],
            "filtered_by": result["filtered_by"],
            "transformed_by": result["transformed_by"],
            "provider": info["provider"],
            "provider_kind": info["kind"],
            "target_runtime": "agent" if remote.agent_url("target") else "in-process",
        }
        if info[
            "metadata"
        ]:  # only when the provider reported any (never for the simulator or a blocked prompt)
            details["provider_metadata"] = info["metadata"]
        audit.append(db, session_id, "target", f"target.{phase}_response", f"attempt:{row['id']}", details)


def _evaluate(db: DB, session_id: str, phase: str) -> None:
    rows = db.all(
        "SELECT id, attack_id, response FROM attempts WHERE session_id = ? AND phase = ? AND verdict IS NULL "
        "ORDER BY position",
        (session_id, phase),
    )
    for row in rows:
        attack = BY_ID[row["attack_id"]]
        verdict, results = evaluator.evaluate(row["response"], attack["criteria"], attack.get("task"))
        db.execute(
            "UPDATE attempts SET verdict = ?, criteria = ? WHERE id = ?",
            (verdict, json.dumps(results), row["id"]),
        )
        audit.append(
            db,
            session_id,
            "evaluator",
            f"evaluator.{phase}_verdict",
            f"attempt:{row['id']}",
            {"phase": phase, "verdict": verdict, "failed": [r["id"] for r in results if not r["passed"]]},
        )


def stage_respond(db: DB, session: dict) -> None:
    _respond(db, session["id"], "baseline")


def stage_evaluate(db: DB, session: dict) -> None:
    _evaluate(db, session["id"], "baseline")


def stage_defend(db: DB, session: dict) -> None:
    """Simulated Blue Team agent: works only from its redacted findings view."""
    if remote.agent_url("blue"):
        # The agent reads findings and applies rules through the Blue API; those calls are audited there.
        dispatch("blue", "/v1/act", session["id"], BLUE_ACTIONS, {})
        return
    findings = blue_findings(db, session["id"])
    audit.append(
        db,
        session["id"],
        "blue",
        "blue.findings_read",
        f"session:{session['id']}",
        {"findings": len(findings)},
    )
    for criterion in dict.fromkeys(f["criterion"] for f in findings):
        if criterion in defenses.PLAYBOOK:
            apply_defense(db, session, defenses.PLAYBOOK[criterion], criterion)


def stage_retest(db: DB, session: dict) -> None:
    if remote.agent_url("red"):
        dispatch(
            "red",
            "/v1/act",
            session["id"],
            RED_ACTIONS,
            {"attack_ids": session["attack_ids"], "phase": "retest"},
        )
        _require_submitted(db, session, "retest")
    else:
        for attack_id in session["attack_ids"]:
            if not _attempt(db, session["id"], attack_id, "retest"):
                submit_attempt(db, session["id"], attack_id, "retest")
    _respond(db, session["id"], "retest")
    _evaluate(db, session["id"], "retest")


def residual_risk(attack: dict, baseline: dict, retest: dict) -> tuple[str, str]:
    if retest["verdict"] == "fail":
        failed = [r["id"] for r in json.loads(retest["criteria"]) if not r["passed"]]
        level = max((evaluator.CRITERIA[c]["severity"] for c in failed), key=RISK_ORDER.index)
        # Neutral about defenses: the playbook may have added none (e.g. for over-refusal).
        return level, f"Still failing on retest: {', '.join(failed)}."
    if baseline["verdict"] == "pass":
        return "none", "Passed at baseline and on retest."
    if retest["blocked_by"]:
        return "low", f"Blocked at input by {retest['blocked_by']}."
    if retest["filtered_by"]:
        return (
            "medium",
            f"Passes only because {retest['filtered_by']} rewrote the output; the model still attempted it.",
        )
    if retest["transformed_by"]:
        return "low", f"Hidden instruction removed by {retest['transformed_by']} before reaching the model."
    return "low", "Passed on retest."


def stage_report(db: DB, session: dict) -> None:
    cases = []
    for attack_id in session["attack_ids"]:
        attack = BY_ID[attack_id]
        baseline = _attempt(db, session["id"], attack_id, "baseline")
        retest = _attempt(db, session["id"], attack_id, "retest")
        level, rationale = residual_risk(attack, baseline, retest)
        cases.append(
            {
                "attack_id": attack_id,
                "title": attack["title"],
                "technique": attack["technique"],
                "baseline_verdict": baseline["verdict"],
                "retest_verdict": retest["verdict"],
                "residual_risk": level,
                "rationale": rationale,
                "recommendation": attack["recommendation"]
                if level in ("medium", "high", "critical")
                else None,
            }
        )
    checks = db.all("SELECT kind, status FROM isolation_checks WHERE session_id = ?", (session["id"],))
    chain = audit.verify(db)
    anchor = checkpoint.verify(audit.load(db))
    agents = {role: bool(remote.agent_url(role)) for role in remote.AGENT_ENV}
    info = recorded_target(db, session["id"])  # what actually answered, as recorded in the chain
    report = {
        "generated_at": audit.now(),
        "overall_risk": max((c["residual_risk"] for c in cases), key=RISK_ORDER.index, default="none"),
        "counts": {
            "cases": len(cases),
            "baseline_failures": sum(c["baseline_verdict"] == "fail" for c in cases),
            "mitigated": sum(
                c["baseline_verdict"] == "fail" and c["retest_verdict"] == "pass" for c in cases
            ),
            "residual_failures": sum(c["retest_verdict"] == "fail" for c in cases),
        },
        "cases": cases,
        "defenses": active_rules(db, session["id"]),
        "isolation": {
            "enforced_pass": sum(c["kind"] == "enforced" and c["status"] == "pass" for c in checks),
            "enforced_fail": sum(c["kind"] == "enforced" and c["status"] == "fail" for c in checks),
            "network_pass": sum(c["kind"] == "network" and c["status"] == "pass" for c in checks),
            "network_fail": sum(c["kind"] == "network" and c["status"] == "fail" for c in checks),
            "configured_pass": sum(c["kind"] == "configured" and c["status"] == "pass" for c in checks),
            "configured_fail": sum(c["kind"] == "configured" and c["status"] == "fail" for c in checks),
            "simulated": sum(c["kind"] == "simulated" for c in checks),
            "planned": sum(c["kind"] == "planned" for c in checks),
        },
        "audit": {
            "ok": chain["ok"],
            "checked": chain["checked"],
            "head_hash": chain["head_hash"],
            "checkpoint": anchor["status"],
            "anchored_seq": anchor.get("anchored_seq"),
        },
        "deployment": {
            "roles": {role: "agent" if on else "in-process" for role, on in agents.items()},
            "target_provider": info["provider"],
            "target_kind": info["kind"],
        },
        "disclaimer": _disclaimer(agents, info["kind"], info["provider"]),
    }
    db.execute("UPDATE sessions SET report = ? WHERE id = ?", (json.dumps(report), session["id"]))
    audit.append(
        db,
        session["id"],
        "system",
        "report.generated",
        f"session:{session['id']}",
        {
            "overall_risk": report["overall_risk"],
            "report_sha256": audit.sha256(json.dumps(report, sort_keys=True)),
        },
    )


def recorded_target(db: DB, session_id: str) -> dict:
    """Provider identity recorded on this session's latest target response event (None before any answer)."""
    row = db.one(
        "SELECT details FROM audit_events WHERE session_id = ? AND event_type LIKE ? ORDER BY seq DESC LIMIT 1",
        (session_id, "target.%"),  # a parameter: psycopg treats a literal % in SQL as a placeholder
    )
    details = json.loads(row["details"]) if row else {}
    return {"provider": details.get("provider"), "kind": details.get("provider_kind")}


def _disclaimer(agents: dict, kind: str | None, provider: str | None = None) -> str:
    if kind == "simulated":
        target = "Results come from a deterministic simulated target, not a real LLM."
    elif kind == "live":
        target = (
            f"Results come from a live language model ({provider}). Its answers can vary between runs, and the "
            "evaluator applies pattern-matching heuristics written for this scripted scenario (known values in common "
            "forms, common refusal openers), so they can still miss reworded or summarised leaks and unusual refusals. "
            "A pass is not proof of safety."
        )
        if (provider or "").startswith("groq/"):
            target += " The prompts and the synthetic scenario were sent to Groq, a third-party service."
        target += " The provider's internal KV-cache is outside our control; mitigations include stateless per-request context."
    else:
        target = f"Target provider kind: {kind}."
    if all(agents.values()):
        scope = (
            "Red, Blue and Target ran as separate agent containers on separate Docker networks; network checks "
            "were observed from inside those containers. They share one host kernel and a trusted control plane."
        )
    else:
        scope = (
            "Some roles ran inside the control-plane process, so isolation checks for those roles test "
            "application-layer permissions only, not OS, container or network isolation."
        )
    timing = (
        "Timing side channels are reduced via response-time quantization and container resource limits, "
        "but not completely eliminated on shared host hardware."
    )
    return f"{target} {scope} {timing}"


STAGE_HANDLERS = {
    "attack": stage_attack,
    "respond": stage_respond,
    "evaluate": stage_evaluate,
    "defend": stage_defend,
    "retest": stage_retest,
    "report": stage_report,
}
