"""Blue Team agent: reads redacted findings and applies rules through the Blue API only."""

from fastapi import FastAPI
from pydantic import BaseModel, Field

from agents import common

app = FastAPI(title="Bayora Blue Team agent", version="0.1.0")

# The Blue Team's own policy: one rule per violated criterion. It reasons only from the
# redacted finding; it never sees the attack prompt. Mirrors app.defenses.PLAYBOOK,
# which the in-process mode uses (a test keeps the two equal).
PLAYBOOK = {
    "instruction-hierarchy": "instruction-guard",
    "no-secret-disclosure": "secret-egress-filter",
    "no-pii-disclosure": "untrusted-content-fence",
}


class Act(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f-]{36}$")


@app.get("/healthz")
def health():
    return {"status": "ok", "role": "blue"}


@app.post("/v1/act")
def act(body: Act):
    token = common.role_token("blue")
    base = f"/api/blue/sessions/{body.session_id}"
    findings = common.api("GET", f"{base}/findings", token)
    applied = []
    for criterion in dict.fromkeys(f["criterion"] for f in findings):
        if criterion in PLAYBOOK:
            common.api(
                "POST", f"{base}/defenses", token, {"rule_id": PLAYBOOK[criterion], "criterion": criterion}
            )
            applied.append(PLAYBOOK[criterion])
    return {
        "findings": len(findings),
        "applied": applied,
        "fields_seen": sorted({key for finding in findings for key in finding}),
    }


@app.post("/v1/probe")
def probe():
    return common.probe("blue-agent")
