"""Red Team agent: submits attack cases through the Red API, signing each request with its own key."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field

from agents import common

app = FastAPI(title="Bayora Red Team agent", version="0.1.0")
ACTIONS = {"red:read", "red:submit"}


class Act(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    attack_ids: list[str] = Field(max_length=50)
    phase: Literal["baseline", "retest"]
    grant: str


class Probe(BaseModel):
    session_id: str
    grant: str


@app.get("/healthz")
def health():
    return {"status": "ok", "role": "red"}


@app.post("/v1/act")
def act(body: Act):
    common.check_grant(body.grant, "red", body.session_id, ACTIONS)
    sid, grant = body.session_id, body.grant
    base = f"/api/red/sessions/{sid}/attempts"
    # Idempotent: skip cases already submitted in this phase (e.g. after an interrupted stage).
    attempts = common.api("GET", base, "red", "red:read", sid, grant)
    done = {a["attack_id"] for a in attempts if a["phase"] == body.phase}
    submitted = []
    for attack_id in body.attack_ids:
        if attack_id not in done:
            common.api(
                "POST", base, "red", "red:submit", sid, grant, {"attack_id": attack_id, "phase": body.phase}
            )
            submitted.append(attack_id)
    return {"submitted": submitted, "skipped": sorted(done & set(body.attack_ids))}


@app.post("/v1/probe")
def probe(body: Probe):
    common.check_grant(body.grant, "red", common.SENTINEL, {"agent:probe"})
    return common.probe("red-agent", "red", body.grant)
