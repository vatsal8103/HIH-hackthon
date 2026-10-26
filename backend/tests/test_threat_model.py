"""Tests for the Bayora Threat Model documentation and API endpoint (Part 5)."""

from pathlib import Path

from conftest import auth

ROOT = Path(__file__).resolve().parents[2]
DOC_PATH = ROOT / "docs" / "THREAT_MODEL.md"

REQUIRED_THREAT_SUBSTRINGS = [
    "Red reads Blue defenses / Blue reads Red attacks",
    "Target contamination across sessions",
    "Audit log tampering",
    "Container escape via shared kernel",
    "Timing & resource side channels",
    "Shared KV-cache leakage in model provider",
    "Compromised signing key",
    "Data leakage to third-party provider",
    "Operator credential sharing",
]


def test_threat_model_document_exists_and_covers_required_threats():
    assert DOC_PATH.exists(), f"Missing threat model document at {DOC_PATH}"
    content = DOC_PATH.read_text(encoding="utf-8")

    assert "# Bayora Architecture Threat Model" in content
    assert "System Overview & Security Boundaries" in content
    assert "Threat Matrix" in content
    assert "Residual Risk Assessment" in content

    for sub in REQUIRED_THREAT_SUBSTRINGS:
        assert sub in content, f"Threat '{sub}' not documented in THREAT_MODEL.md"


def test_threat_model_api_endpoint(client):
    res = client.get("/api/threat-model", headers=auth("operator"))
    assert res.status_code == 200
    data = res.json()

    assert "markdown" in data and len(data["markdown"]) > 500
    assert "threats" in data and len(data["threats"]) >= 9

    threat_names = [t["threat"] for t in data["threats"]]
    for req in REQUIRED_THREAT_SUBSTRINGS:
        assert any(req in name for name in threat_names), f"API missing threat {req}"

    for t in data["threats"]:
        assert t["threat"]
        assert t["status"] in ("Implemented", "Partial", "Simulated", "Planned")
        assert t["how"]
        assert t["failure_mode"]
        assert t["test"]
        assert "future" in t


def test_threat_model_permissions(client):
    # Unauthenticated rejected
    res = client.get("/api/threat-model")
    assert res.status_code == 401

    # Operator role access
    res = client.get("/api/threat-model", headers=auth("operator"))
    assert res.status_code == 200
