"""Role-scoped bearer tokens and the permission table every route is checked against.

Tokens are static per role and come from the environment (dev defaults below).
This is a prototype authorisation layer, not an identity system.
"""

import hmac
import os

from fastapi import Header, HTTPException

ROLES = ("operator", "red", "blue", "target")

PERMISSIONS: dict[str, set[str]] = {
    # Lab supervisor: starts runs and reads everything for review.
    "operator": {"attacks:read", "runs:read", "runs:write", "audit:read", "isolation:probe"},
    # Red Team: reads the attack library, submits attacks, sees its own outcomes.
    "red": {"attacks:read", "red:read", "red:submit"},
    # Blue Team: sees redacted findings only, applies defensive rules.
    "blue": {"blue:read", "blue:defend"},
    # Target LLM: sees the prompts addressed to it, nothing else.
    "target": {"target:read"},
}


def role_tokens() -> dict[str, str]:
    return {role: os.environ.get(f"BAYORA_TOKEN_{role.upper()}", f"dev-{role}-token") for role in ROLES}


def validate_tokens() -> None:
    """With BAYORA_REQUIRE_TOKENS=1 (set by the Docker stack), refuse to start on weak credentials."""
    if os.environ.get("BAYORA_REQUIRE_TOKENS") != "1":
        return
    tokens = role_tokens()
    problems = [
        f"BAYORA_TOKEN_{role.upper()} is missing, a dev default, or shorter than 24 characters"
        for role, token in tokens.items()
        if token == f"dev-{role}-token" or len(token) < 24
    ]
    if len(set(tokens.values())) != len(tokens):
        problems.append("role tokens must be distinct")
    if os.environ.get("BAYORA_WITNESS_URL") and len(os.environ.get("BAYORA_WITNESS_TOKEN", "")) < 24:
        problems.append("BAYORA_WITNESS_TOKEN must be set (24+ characters) when a witness is configured")
    if problems:
        raise RuntimeError("Refusing to start: " + "; ".join(problems))


def role_for(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ")
    for role, expected in role_tokens().items():
        if hmac.compare_digest(token, expected):
            return role
    return None


def can(role: str, permission: str) -> bool:
    return permission in PERMISSIONS.get(role, set())


def require(permission: str):
    def dependency(authorization: str | None = Header(default=None)) -> str:
        role = role_for(authorization)
        if role is None:
            raise HTTPException(401, "Missing or unknown bearer token")
        if not can(role, permission):
            raise HTTPException(403, f"Role '{role}' lacks permission '{permission}'")
        return role

    return dependency
