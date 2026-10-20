"""Compact signed tokens shared by the control plane and the role agents.

Format: base64url(canonical JSON claims) "." base64url(Ed25519 signature over the first part).
Every token names the key that signed it (`kid`). Verification looks the key up in a
caller-supplied table, so a key registered for one role can never vouch for another.
This module depends on nothing else in the app and is copied into the agent image.
"""

import base64
import json
import os
import time
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

CLOCK_SKEW = 5  # seconds tolerated between containers sharing one VM clock


class TokenError(Exception):
    """The token is malformed, signed by an unknown key, forged, expired or out of scope."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(claims: dict, kid: str, key: Ed25519PrivateKey) -> str:
    body = _b64(json.dumps({**claims, "kid": kid}, sort_keys=True, separators=(",", ":")).encode())
    return f"{body}.{_b64(key.sign(body.encode()))}"


def verify(token: str, keys: dict[str, Ed25519PublicKey]) -> dict:
    try:
        body, signature = token.split(".")
        claims = json.loads(_unb64(body))
        key = keys.get(claims["kid"])
    except (ValueError, KeyError, TypeError) as exc:
        raise TokenError("malformed token") from exc
    if key is None:
        raise TokenError("unknown key id")
    try:
        key.verify(_unb64(signature), body.encode())
    except (InvalidSignature, ValueError) as exc:
        raise TokenError("signature does not verify") from exc
    return claims


def check_lifetime(claims: dict, max_ttl: int) -> None:
    now = time.time()
    issued, expires = claims.get("iat"), claims.get("exp")
    if not isinstance(issued, int | float) or not isinstance(expires, int | float):
        raise TokenError("missing iat/exp")
    if expires <= now:
        raise TokenError("expired")
    if issued > now + CLOCK_SKEW:
        raise TokenError("issued in the future")
    if expires - issued > max_ttl:
        raise TokenError("lifetime exceeds the allowed maximum")


def lifetime(ttl: int) -> dict:
    now = int(time.time())
    return {"iat": now, "exp": now + ttl}


def new_id() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------- key material
# Environment format: "kid:base64url(raw 32-byte key)"; public key lists are comma separated
# so a role can have an old and a new key during rotation.


def private_key(env_name: str) -> tuple[str, Ed25519PrivateKey]:
    spec = os.environ.get(env_name, "")
    try:
        kid, raw = spec.split(":", 1)
        return kid, Ed25519PrivateKey.from_private_bytes(_unb64(raw))
    except ValueError as exc:
        raise TokenError(f"{env_name} is missing or malformed") from exc


def public_keys(env_name: str) -> dict[str, Ed25519PublicKey]:
    keys = {}
    for spec in filter(None, (s.strip() for s in os.environ.get(env_name, "").split(","))):
        try:
            kid, raw = spec.split(":", 1)
            keys[kid] = Ed25519PublicKey.from_public_bytes(_unb64(raw))
        except ValueError as exc:
            raise TokenError(f"{env_name} contains a malformed key") from exc
    return keys


def generate(kid: str) -> tuple[str, str]:
    """A new keypair as (private spec, public spec)."""
    key = Ed25519PrivateKey.generate()
    raw_private = key.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    raw_public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return f"{kid}:{_b64(raw_private)}", f"{kid}:{_b64(raw_public)}"
