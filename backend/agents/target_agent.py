"""Target agent: runs the target model and nothing else.

It holds no API token and never calls the control plane. It receives only the prompt
text that passed the platform's input guardrails and returns the model's answer.
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field

from agents import common
from app.providers import get_provider

app = FastAPI(title="Bayora Target agent", version="0.1.0")
provider = get_provider()


class Prompt(BaseModel):
    model_config = {"extra": "forbid"}  # nothing but the prompt text is accepted
    prompt: str = Field(max_length=8000)


@app.get("/healthz")
def health():
    return {"status": "ok", "role": "target", "provider": provider.id, "kind": provider.kind}


@app.post("/v1/respond")
def respond(body: Prompt):
    return {"response": provider.respond(body.prompt), "provider": provider.id, "kind": provider.kind}


@app.post("/v1/probe")
def probe():
    return common.probe("target")
