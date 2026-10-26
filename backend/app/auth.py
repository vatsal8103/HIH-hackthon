"""Who may call what: the permission table, and how each caller proves its role.

- Operator: a bearer token. When BAYORA_OPERATOR_TOKEN_SHA256 is set (Docker) the control
  plane stores only that hash, so it can check the token but not present it.
- Red and Blue: when their public keys are configured (Docker), only tokens signed by the
  role's own key and scoped by a control-plane grant are accepted (see credentials.py).
- Static per-role tokens remain for dev mode, where the roles run inside this process.
  Their dev defaults are accepted only when BAYORA_REQUIRE_TOKENS is not set.
"""

import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass

from fastapi import Header, HTTPException, Request

from app import credentials, db, tokens

ROLES = ("operator", "red", "blue", "target")

PERMISSIONS: dict[str, set[str]] = {
    # Lab supervisor: starts runs, reads everything for review, revokes credentials.
    "operator": {
        "attacks:read",
        "runs:read",
        "runs:write",
        "audit:read",
        "isolation:probe",
        "credentials:manage",
    },
    # Red Team: reads the attack library, submits attacks, sees its own outcomes.
    "red": {"attacks:read", "red:read", "red:submit"},
    # Blue Team: sees redacted findings only, applies defensive rules.
    "blue": {"blue:read", "blue:defend"},
    # Target LLM: sees the prompts addressed to it, nothing else.
    "target": {"target:read"},
}


@dataclass
class Principal:
    role: str
    credential: str | None = None  # the role-signed token, kept as audit evidence


def _required() -> bool:
    return os.environ.get("BAYORA_REQUIRE_TOKENS") == "1"


def static_token(role: str) -> str | None:
    """The bearer token accepted for a role without signed credentials, if any."""
    if role in credentials.signed_roles():
        return None
    value = os.environ.get(f"BAYORA_TOKEN_{role.upper()}")
    if value:
        return value
    return None if _required() else f"dev-{role}-token"


def _operator_matches(token: str) -> bool:
    digest = os.environ.get("BAYORA_OPERATOR_TOKEN_SHA256")
    if digest:
        return hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), digest.lower())
    expected = static_token("operator")
    return expected is not None and hmac.compare_digest(token, expected)


def role_for(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ")
    if _operator_matches(token):
        return "operator"
    for role in ("red", "blue", "target"):
        expected = static_token(role)
        if expected is not None and hmac.compare_digest(token, expected):
            return role
    return None


def can(role: str, permission: str) -> bool:
    return permission in PERMISSIONS.get(role, set())


def validate_tokens() -> None:
    """With BAYORA_REQUIRE_TOKENS=1 (set by the Docker stack), refuse to start on weak credentials."""
    if not _required():
        return
    problems = []
    if not re.fullmatch(r"[0-9a-f]{64}", os.environ.get("BAYORA_OPERATOR_TOKEN_SHA256", "")):
        problems.append("BAYORA_OPERATOR_TOKEN_SHA256 must be the SHA-256 hex digest of the operator token")
    if os.environ.get("BAYORA_TOKEN_OPERATOR"):
        problems.append("the control plane must not hold the plaintext operator token")
    for role in credentials.SIGNED_ROLES:
        try:
            if not credentials.role_keys(role):
                problems.append(f"BAYORA_{role.upper()}_PUBLIC_KEYS must list the {role} agent's public key")
        except tokens.TokenError as exc:
            problems.append(str(exc))
        if os.environ.get(f"BAYORA_TOKEN_{role.upper()}"):
            problems.append(f"BAYORA_TOKEN_{role.upper()} must not be set: {role} uses signed credentials")
    if os.environ.get("BAYORA_TOKEN_TARGET"):
        problems.append("BAYORA_TOKEN_TARGET must not be set: the target holds no API credential")
    try:
        credentials.cp_public_keys()
    except tokens.TokenError as exc:
        problems.append(str(exc))
    if os.environ.get("BAYORA_WITNESS_URL") and len(os.environ.get("BAYORA_WITNESS_TOKEN", "")) < 24:
        problems.append("BAYORA_WITNESS_TOKEN must be set (24+ characters) when a witness is configured")
    if problems:
        raise RuntimeError("Refusing to start: " + "; ".join(problems))


def _safe_alert(role: str, path: str, code: str) -> None:
    if "00000000-0000-0000-0000-000000000000" in path:
        return
    from app import monitor

    with db.connect() as conn:
        monitor.record_alert(conn, role, path, code)


def require(permission: str):
    async def dependency(request: Request, authorization: str | None = Header(default=None)) -> Principal:
        scheme, _, credential = (authorization or "").partition(" ")
        if scheme == "Bayora-Signed" and credential:
            return await _signed(request, credential, permission)
        role = role_for(authorization)
        if role is None:
            raise HTTPException(401, "Missing or unknown credential")
        from app import monitor

        if not monitor.track_role_request(role):
            _safe_alert(role, request.url.path, "RATE_EXCEEDED")
        if not can(role, permission):
            path = request.url.path
            code = (
                "CROSS_BOUNDARY_ACCESS"
                if ((role == "red" and "/blue/" in path) or (role == "blue" and "/red/" in path))
                else "FORBIDDEN_ROUTE"
            )
            _safe_alert(role, path, code)
            raise HTTPException(403, f"Role '{role}' lacks permission '{permission}'")
        return Principal(role)

    return dependency


async def _signed(request: Request, credential: str, permission: str) -> Principal:
    body = await request.body()  # Starlette caches it for the route's own body parsing
    try:
        params = json.loads(body) if body else {}
    except ValueError as exc:
        raise HTTPException(401, "Signed request body is not JSON") from exc
    with db.connect() as conn:
        revoked = credentials.revoked_kids(conn)
    session_id = request.path_params.get("session_id")
    try:
        claims = credentials.verify_request(credential, permission, session_id, params, revoked, can)
    except PermissionError as exc:
        path = request.url.path
        role = str(exc)
        code = (
            "CROSS_BOUNDARY_ACCESS"
            if ((role == "red" and "/blue/" in path) or (role == "blue" and "/red/" in path))
            else "FORBIDDEN_ROUTE"
        )
        _safe_alert(role, path, code)
        raise HTTPException(403, f"Role '{exc}' lacks permission '{permission}'") from exc
    except tokens.TokenError as exc:
        path = request.url.path
        msg = str(exc).lower()
        if "expired" in msg:
            code = "TOKEN_EXPIRED"
        elif "replayed" in msg or "revoked" in msg:
            code = "TOKEN_REPLAYED"
        else:
            code = "INVALID_SIGNATURE"
        _safe_alert("anonymous", path, code)
        raise HTTPException(401, f"Invalid signed credential: {exc}") from exc
    return Principal(claims["role"], credential)
