"""Target agent: runs the target model and nothing else.

It holds no API credential and never calls the control plane. It accepts a prompt only
with a valid control-plane grant for that session, and receives nothing but the prompt
text that passed the platform's input guardrails.
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field

from agents import common
from app.providers import get_provider

app = FastAPI(title="Bayora Target agent", version="0.1.0")
provider = get_provider()


class Prompt(BaseModel):
    model_config = {"extra": "forbid"}  # nothing but the prompt and its authorisation
    prompt: str = Field(max_length=8000)
    session_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    grant: str


class Probe(BaseModel):
    session_id: str
    grant: str


@app.get("/healthz")
def health():
    return {"status": "ok", "role": "target", "provider": provider.id, "kind": provider.kind}


@app.post("/v1/respond")
def respond(body: Prompt):
    common.check_grant(body.grant, "target", body.session_id, {"target:respond"})
    return {"response": provider.respond(body.prompt), "provider": provider.id, "kind": provider.kind}


@app.post("/v1/probe")
def probe(body: Probe):
    common.check_grant(body.grant, "target", common.SENTINEL, {"agent:probe"})
    return common.probe("target")
