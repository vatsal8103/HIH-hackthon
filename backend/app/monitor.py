"""Continuous monitoring and anomaly detection for Bayora.

Goal: detect cross-boundary access and policy violations in real time without
the monitor itself leaking secrets or acting as a side channel.

Alerts are strictly REDACTED:
- Only role, normalized route, timestamp, and coarse reason code are stored.
- Prompt text, defense rules, credentials and payloads are NEVER stored in alerts.
- Every alert is written to the hash-linked audit chain.
- GET /api/alerts is rate-limited and operator-only.
"""

import re
import time
import uuid
from collections import defaultdict, deque
from datetime import UTC, datetime

from fastapi import HTTPException

from app import audit
from app.db import DB

# Coarse, fixed-size reason codes to prevent timing/content side channels
REASON_CODES = {
    "FORBIDDEN_ROUTE": "Role called a route it lacks permission for (403)",
    "CROSS_BOUNDARY_ACCESS": "Cross-boundary access: Red requesting Blue data or Blue requesting Red data",
    "INVALID_SIGNATURE": "Cryptographic signature failed or key unrecognised",
    "TOKEN_REPLAYED": "Token replayed, reused jti, or revoked key id",
    "TOKEN_EXPIRED": "Token expired or presented outside valid time window",
    "RATE_EXCEEDED": "Unusual request burst rate from role",
    "DEMO_VIOLATION": "Simulated cross-boundary violation for live demonstration",
}

# In-memory sliding window for rate monitoring
_ROLE_REQUEST_TIMES: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=200))
_ALERTS_ENDPOINT_CALLS: deque[float] = deque(maxlen=200)

UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def normalize_route(path: str) -> str:
    """Normalize route path and strip query params or embedded session UUIDs to coarse templates."""
    base = path.split("?")[0].strip()
    return UUID_PATTERN.sub("{sid}", base)


def record_alert(db: DB, role: str, route: str, reason_code: str) -> dict:
    """Record a redacted alert and write it to the audit chain.

    Ensures no prompt text, defense rule bodies, or secrets are ever recorded.
    """
    if reason_code not in REASON_CODES:
        reason_code = "FORBIDDEN_ROUTE"

    clean_role = role or "anonymous"
    clean_route = normalize_route(route)
    alert_id = str(uuid.uuid4())
    now_iso = datetime.now(UTC).isoformat(timespec="milliseconds")

    db.execute(
        "INSERT INTO alerts (id, created_at, role, route, reason_code) VALUES (?, ?, ?, ?, ?)",
        (alert_id, now_iso, clean_role, clean_route, reason_code),
    )

    # Append alert to the audit chain
    audit.append(
        db,
        None,
        "system",
        "monitor.alert",
        f"alert:{alert_id}",
        {
            "alert_id": alert_id,
            "role": clean_role,
            "route": clean_route,
            "reason_code": reason_code,
        },
    )

    return {
        "id": alert_id,
        "created_at": now_iso,
        "role": clean_role,
        "route": clean_route,
        "reason_code": reason_code,
        "description": REASON_CODES[reason_code],
    }


def list_alerts(db: DB, limit: int = 100) -> dict:
    """List recent alerts and compute per-role summary counts."""
    rows = db.all(
        "SELECT id, created_at, role, route, reason_code FROM alerts ORDER BY created_at DESC LIMIT ?",
        (min(limit, 500),),
    )

    counts_by_role = defaultdict(int)
    counts_by_reason = defaultdict(int)

    alerts = []
    for row in rows:
        counts_by_role[row["role"]] += 1
        counts_by_reason[row["reason_code"]] += 1
        alerts.append(
            {
                "id": row["id"],
                "created_at": row["created_at"],
                "role": row["role"],
                "route": row["route"],
                "reason_code": row["reason_code"],
                "description": REASON_CODES.get(row["reason_code"], "Policy violation"),
            }
        )

    return {
        "alerts": alerts,
        "counts": {
            "total": len(alerts),
            "by_role": dict(counts_by_role),
            "by_reason": dict(counts_by_reason),
        },
        "reason_codes": REASON_CODES,
    }


def check_alerts_rate_limit(max_requests: int = 60, window_seconds: float = 60.0) -> None:
    """Coarse rate limit on the alerts endpoint to avoid side-channel streaming."""
    now = time.time()
    cutoff = now - window_seconds
    while _ALERTS_ENDPOINT_CALLS and _ALERTS_ENDPOINT_CALLS[0] < cutoff:
        _ALERTS_ENDPOINT_CALLS.popleft()

    if len(_ALERTS_ENDPOINT_CALLS) >= max_requests:
        raise HTTPException(
            status_code=429, detail="Alerts query rate limit exceeded (coarse side-channel mitigation)"
        )

    _ALERTS_ENDPOINT_CALLS.append(now)


def track_role_request(role: str, threshold: int = 25, window_seconds: float = 3.0) -> bool:
    """Track request frequency for a role. Returns True if rate is normal, False if exceeded."""
    if not role or role in ("operator", "anonymous"):
        return True

    now = time.time()
    cutoff = now - window_seconds
    q = _ROLE_REQUEST_TIMES[role]
    while q and q[0] < cutoff:
        q.popleft()

    q.append(now)
    return len(q) <= threshold


def trigger_demo_violation(db: DB) -> dict:
    """Trigger a safe fake cross-boundary violation so alerts can be demonstrated live."""
    return record_alert(
        db,
        role="red",
        route="/api/blue/sessions/{sid}/findings",
        reason_code="CROSS_BOUNDARY_ACCESS",
    )
