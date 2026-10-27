"""Tests for Phase 3: Local Network Control and Barrier Probing without Docker.

Verifies:
1. Strict loopback binding (127.0.0.1) across all services.
2. Probe target generation and egress test targets.
3. Honest labeling of isolation barriers: "blocked by OS" vs "blocked by authentication only".
4. Detection and loud failure on unauthorized cross-role network reach.
5. Presence and syntax of local firewall configuration scripts.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

from agents import common
from app import isolation


def test_probe_targets_bound_strictly_to_loopback_in_local_process_mode():
    with patch.dict(os.environ, {"BAYORA_MODE": "local-process"}):
        targets = common.probe_targets()
        assert len(targets) > 0
        for name, host, port in targets:
            if name == "egress":
                assert host == "192.0.2.1"  # RFC 5737 TEST-NET-1 for egress check
            else:
                assert host == "127.0.0.1", f"Target {name} is bound to {host}, must be 127.0.0.1!"
                assert isinstance(port, int) and port > 0


def test_check_peer_barrier_labels():
    # 1. Non-connected TCP outcome is blocked by OS
    assert common.check_peer_barrier("blue-agent", "127.0.0.1", 8003, "unreachable") == "blocked by OS"
    assert common.check_peer_barrier("blue-agent", "127.0.0.1", 8003, "timeout") == "blocked by OS"
    assert common.check_peer_barrier("blue-agent", "127.0.0.1", 8003, "refused") == "blocked by OS"

    # 2. Control plane is the authorized link
    assert common.check_peer_barrier("control-plane", "127.0.0.1", 8000, "connected") == "authorized path"

    # 3. Peer agent with 401 Unauthorized is blocked by authentication only
    mock_resp_401 = MagicMock(status_code=401)
    with patch("httpx.Client.post", return_value=mock_resp_401):
        assert (
            common.check_peer_barrier("blue-agent", "127.0.0.1", 8003, "connected")
            == "blocked by authentication only"
        )

    # 4. Peer agent answering 200 without auth is a reachable violation
    mock_resp_200 = MagicMock(status_code=200)
    with patch("httpx.Client.post", return_value=mock_resp_200):
        assert common.check_peer_barrier("blue-agent", "127.0.0.1", 8003, "connected") == "reachable"


def test_role_runtime_checks_counts_barriers_in_local_process_mode():
    simulated_reports = {
        "red": {
            "reachability": [
                {"name": "control-plane", "host": "127.0.0.1", "port": 8000, "barrier": "authorized path"},
                {
                    "name": "blue-agent",
                    "host": "127.0.0.1",
                    "port": 8003,
                    "barrier": "blocked by authentication only",
                },
                {
                    "name": "target",
                    "host": "127.0.0.1",
                    "port": 8004,
                    "barrier": "blocked by authentication only",
                },
                {"name": "egress", "host": "192.0.2.1", "port": 80, "barrier": "blocked by OS"},
            ],
            "security": {"pid": 1001},
        },
        "blue": {
            "reachability": [
                {"name": "control-plane", "host": "127.0.0.1", "port": 8000, "barrier": "authorized path"},
                {
                    "name": "red-agent",
                    "host": "127.0.0.1",
                    "port": 8002,
                    "barrier": "blocked by authentication only",
                },
                {"name": "egress", "host": "192.0.2.1", "port": 80, "barrier": "blocked by OS"},
            ],
            "security": {"pid": 1002},
        },
    }

    with patch.dict(os.environ, {"BAYORA_MODE": "local-process"}):
        checks = isolation.role_runtime_checks(simulated_reports)
        iso_06 = next(c for c in checks if c[0] == "ISO-06")
        assert iso_06[3] == "pass"
        detail = iso_06[4]
        assert "2 targets blocked by OS" in detail
        assert "3 peer targets blocked by authentication only" in detail
        assert "0 unauthenticated cross-role leaks" in detail


def test_role_runtime_checks_flags_unauthenticated_reach_violation():
    leaky_reports = {
        "red": {
            "reachability": [
                {"name": "blue-agent", "host": "127.0.0.1", "port": 8003, "barrier": "reachable"},
            ],
            "security": {"pid": 1001},
        }
    }

    with patch.dict(os.environ, {"BAYORA_MODE": "local-process"}):
        checks = isolation.role_runtime_checks(leaky_reports)
        iso_06 = next(c for c in checks if c[0] == "ISO-06")
        assert iso_06[3] == "fail"
        assert "red→blue-agent unauthenticated reach" in iso_06[4]


def test_firewall_scripts_exist():
    project_root = Path(__file__).resolve().parents[2]
    sh_script = project_root / "scripts" / "setup_firewall.sh"
    ps_script = project_root / "scripts" / "setup_firewall.ps1"

    assert sh_script.exists()
    assert ps_script.exists()

    sh_content = sh_script.read_text(encoding="utf-8")
    assert "8002" in sh_content
    assert "8003" in sh_content
    assert "8004" in sh_content
    assert "iptables" in sh_content

    ps_content = ps_script.read_text(encoding="utf-8")
    assert "8002" in ps_content
    assert "8003" in ps_content
    assert "8004" in ps_content
    assert "NetFirewallRule" in ps_content
