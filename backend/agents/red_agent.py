"""Red Team agent: submits attack cases through the Red API with the Red token only."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field

from agents import common

app = FastAPI(title="Bayora Red Team agent", version="0.1.0")


class Act(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    attack_ids: list[str] = Field(max_length=50)
    phase: Literal["baseline", "retest"]


@app.get("/healthz")
def health():
    return {"status": "ok", "role": "red"}


@app.post("/v1/act")
def act(body: Act):
    token = common.role_token("red")
    base = f"/api/red/sessions/{body.session_id}/attempts"
    # Idempotent: skip cases already submitted in this phase (e.g. after an interrupted stage).
    done = {a["attack_id"] for a in common.api("GET", base, token) if a["phase"] == body.phase}
    submitted = []
    for attack_id in body.attack_ids:
        if attack_id not in done:
            common.api("POST", base, token, {"attack_id": attack_id, "phase": body.phase})
            submitted.append(attack_id)
    return {"submitted": submitted, "skipped": sorted(done & set(body.attack_ids))}


@app.post("/v1/probe")
def probe():
    return common.probe("red-agent")
