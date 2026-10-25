"""Outbound HTTP from the control plane to role agents and the audit witness.

Every failure raises RemoteError. Callers never fall back to doing a role's work
in-process: a missing or broken agent fails the stage instead.
"""

import os

import httpx

AGENT_ENV = {
    "red": "BAYORA_RED_AGENT_URL",
    "blue": "BAYORA_BLUE_AGENT_URL",
    "target": "BAYORA_TARGET_AGENT_URL",
}

MAX_DETAIL = 300  # characters of a remote error detail passed on to the operator

# Tests route a base URL to an in-process app (an httpx.Client such as TestClient).
OVERRIDES: dict[str, httpx.Client] = {}


class RemoteError(Exception):
    """A remote service was unreachable or answered with an error or malformed body."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def agent_url(role: str) -> str | None:
    return os.environ.get(AGENT_ENV[role]) or None


def call(
    base_url: str, method: str, path: str, *, json=None, token: str | None = None, timeout: float = 10.0
):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        if base_url in OVERRIDES:
            response = OVERRIDES[base_url].request(method, path, json=json, headers=headers)
        else:
            with httpx.Client(base_url=base_url, timeout=timeout) as client:
                response = client.request(method, path, json=json, headers=headers)
    except httpx.HTTPError as exc:
        raise RemoteError(f"{base_url}{path} unreachable ({exc.__class__.__name__})") from exc
    if response.status_code >= 400:
        detail = _detail(response)
        raise RemoteError(
            f"{base_url}{path} answered {response.status_code}{f': {detail}' if detail else ''}",
            response.status_code,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise RemoteError(f"{base_url}{path} returned a non-JSON body") from exc


def _detail(response: httpx.Response) -> str | None:
    """The `detail` string our own services put in error bodies (e.g. the target's provider failure).

    Only a FastAPI-style string detail is passed on, truncated, so an operator sees why a stage
    failed (a Groq rate limit, a rejected dispatch) instead of a bare status code. These services
    never put credentials in error text (providers redact them).
    """
    try:
        body = response.json()
    except ValueError:
        return None
    detail = body.get("detail") if isinstance(body, dict) else None
    return detail[:MAX_DETAIL] if isinstance(detail, str) and detail.strip() else None


def call_agent(role: str, path: str, payload: dict, timeout: float = 20.0):
    url = agent_url(role)
    try:
        return call(url, "POST", path, json=payload, timeout=timeout)
    except RemoteError as exc:
        raise RemoteError(f"{role} agent: {exc}", exc.status) from exc
