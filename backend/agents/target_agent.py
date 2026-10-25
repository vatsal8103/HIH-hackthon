"""Target agent: runs the target model and nothing else.

It holds no API credential and never calls the control plane. It accepts a prompt only
with a valid control-plane grant for that session, and receives nothing but the prompt
text that passed the platform's input guardrails. With BAYORA_TARGET_PROVIDER=ollama it
calls a local model through the restricted ollama-proxy (Docker) and nothing else; a model
failure is a 502 with the reason, never a silent fallback to the simulator.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from agents import common
from app.providers import ProviderError, get_provider

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
    return {
        "status": "ok",
        "role": "target",
        "provider": provider.id,
        "kind": provider.kind,
        **provider.status(),
    }


@app.post("/v1/respond")
def respond(body: Prompt):
    common.check_grant(body.grant, "target", body.session_id, {"target:respond"})  # before any model call
    try:
        answer, metadata = provider.respond_with_metadata(body.prompt)
    except ProviderError as exc:
        raise HTTPException(502, f"Target provider failure: {exc}") from exc
    # metadata is whitelisted by the provider: finish reason and token counts, never reasoning.
    return {"response": answer, "provider": provider.id, "kind": provider.kind, "metadata": metadata}


@app.post("/v1/probe")
def probe(body: Probe):
    common.check_grant(body.grant, "target", common.SENTINEL, {"agent:probe"})
    return common.probe("target")
