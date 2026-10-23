"""The target description the UI shows comes from what actually runs, never a fixed label."""

import httpx
from conftest import AGENT_URLS, auth

from app import remote


def target(client) -> dict:
    return client.get("/api/meta", headers=auth("operator")).json()["target"]


def test_in_process_target_is_described_by_its_provider(client):
    assert target(client) == {
        "provider": "bayora-simulator/rules-v1",
        "kind": "simulated",
        "source": "in-process",
        "ready": True,
        "detail": "Deterministic rules; nothing external to reach.",
    }


def test_agent_target_is_asked_what_it_runs(agents, client):
    assert target(client) == {
        "provider": "bayora-simulator/rules-v1",
        "kind": "simulated",
        "source": "target agent",
        "ready": True,
        "detail": "Deterministic rules; nothing external to reach.",
    }


def test_unreachable_target_agent_is_reported_as_unknown(agents, client, monkeypatch):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    url = AGENT_URLS["target"]
    monkeypatch.setitem(
        remote.OVERRIDES, url, httpx.Client(transport=httpx.MockTransport(refuse), base_url=url)
    )
    assert target(client) == {
        "provider": None,
        "kind": "unknown",
        "source": "target agent unreachable",
        "ready": False,
        "detail": None,
    }


def control(client, name: str) -> dict:
    controls = client.get("/api/meta", headers=auth("operator")).json()["controls"]
    return next(c for c in controls if c["name"] == name)


def test_register_and_notice_describe_the_target_from_the_same_answer(agents, client, monkeypatch):
    assert control(client, "Target model")["status"] == "simulated"

    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    url = AGENT_URLS["target"]
    monkeypatch.setitem(
        remote.OVERRIDES, url, httpx.Client(transport=httpx.MockTransport(refuse), base_url=url)
    )
    entry = control(client, "Target model")
    assert entry["status"] == "unknown" and "Unknown" in entry["detail"]
