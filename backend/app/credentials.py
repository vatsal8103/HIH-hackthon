"""Control-plane side of role credentials.

When a role's public keys are configured (BAYORA_<ROLE>_PUBLIC_KEYS), that role must
authenticate every request with a token signed by its own private key, which only the
role's agent holds. The control plane can verify such tokens but cannot produce them, so
it cannot act as that role through the role interfaces, and audit events carrying the
token are evidence the role itself authorised the action.

Each role token must also embed a grant: a short-lived capability signed by the control
plane (BAYORA_CP_SIGNING_KEY) naming the role, one session and the allowed actions. A
role therefore acts only inside the session and window the orchestrator dispatched it to.
"""

import threading
import time

from app import tokens
from app.db import DB

GRANT_TTL = 120
REQUEST_TTL = 60
SIGNED_ROLES = ("red", "blue")  # the target holds no API credential at all

_seen: dict[str, float] = {}  # jti → expiry, to refuse replays within a token's lifetime
_seen_lock = threading.Lock()


def role_keys(role: str):
    return tokens.public_keys(f"BAYORA_{role.upper()}_PUBLIC_KEYS")


def signed_roles() -> set[str]:
    return {role for role in SIGNED_ROLES if role_keys(role)}


def _cp_key():
    return tokens.private_key("BAYORA_CP_SIGNING_KEY")


def cp_public_keys() -> dict:
    """The current grant key, plus retired ones (BAYORA_CP_PUBLIC_KEYS) so old evidence still verifies."""
    kid, key = _cp_key()
    return {**tokens.public_keys("BAYORA_CP_PUBLIC_KEYS"), kid: key.public_key()}


def issue_grant(role: str, session_id: str, actions: list[str]) -> str:
    kid, key = _cp_key()
    claims = {"typ": "grant", "role": role, "sid": session_id, "act": sorted(actions), "gid": tokens.new_id()}
    return tokens.sign({**claims, **tokens.lifetime(GRANT_TTL)}, kid, key)


def revoked_kids(db: DB) -> set[str]:
    return {row["kid"] for row in db.all("SELECT kid FROM credential_revocations")}


def check_grant(grant: str, role: str, session_id: str | None, permission: str) -> dict:
    claims = tokens.verify(grant, cp_public_keys())
    if claims.get("typ") != "grant" or claims.get("role") != role:
        raise tokens.TokenError("grant is for another role")
    if session_id is not None and claims.get("sid") != session_id:
        raise tokens.TokenError("grant is for another session")
    if permission not in claims.get("act", []):
        raise tokens.TokenError(f"grant does not allow {permission}")
    tokens.check_lifetime(claims, GRANT_TTL)
    return claims


def verify_request(
    token: str, permission: str, session_id: str | None, params: dict, revoked: set[str], allowed
) -> dict:
    """Validate a role-signed request token. `allowed(role, permission)` is the permission table."""
    claims = _claims_for_any_role(token)
    role = claims.get("role")
    if role not in signed_roles():
        raise tokens.TokenError("role does not use signed credentials")
    if claims["kid"] in revoked:
        raise tokens.TokenError("key id has been revoked")
    if not allowed(role, permission):
        raise PermissionError(role)
    if claims.get("typ") != "req" or claims.get("act") != permission:
        raise tokens.TokenError(f"token was not issued for {permission}")
    if claims.get("sid") != session_id:
        raise tokens.TokenError("token is for another session")
    if claims.get("req") != params:
        raise tokens.TokenError("token does not match the request parameters")
    tokens.check_lifetime(claims, REQUEST_TTL)
    check_grant(claims.get("grant", ""), role, session_id, permission)
    _consume(claims.get("jti"), claims["exp"])
    return claims


def _claims_for_any_role(token: str) -> dict:
    """Verify against the keys of the role the token claims, and only that role's keys."""
    for role in SIGNED_ROLES:
        keys = role_keys(role)
        try:
            claims = tokens.verify(token, keys)
        except tokens.TokenError:
            continue
        if claims.get("role") == role:
            return claims
    raise tokens.TokenError("signature does not verify for any configured role key")


def _consume(jti, expires: float) -> None:
    if not isinstance(jti, str) or not jti:
        raise tokens.TokenError("missing jti")
    now = time.time()
    with _seen_lock:
        for stale in [k for k, exp in _seen.items() if exp < now]:
            del _seen[stale]
        if jti in _seen:
            raise tokens.TokenError("token already used")
        _seen[jti] = expires
