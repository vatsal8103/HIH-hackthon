"""Tests for Phase 2: OS-level sandboxing detection and enforcement.

Verifies:
1. Detection of host OS sandboxing primitives (bwrap, firejail, user separation, Job Objects).
2. Command wrapping for unprivileged sandboxing.
3. Filesystem isolation and permission verification.
4. Reporting of honest isolation strength in /api/meta and ISO-07.
5. Graceful fallback on systems lacking specific OS features.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

from app import isolation, sandbox


def test_detect_os_capabilities_schema():
    caps = sandbox.detect_os_capabilities()
    assert isinstance(caps, dict)
    assert caps["platform"] == sys.platform
    assert isinstance(caps["current_user"], str) and caps["current_user"]
    assert caps["strength"] in ("OS-level", "process-level", "cryptographic", "simulated", "planned")
    assert caps["sandbox_tool"] in ("bubblewrap", "firejail", "user-separation", "job-objects", "none")
    assert isinstance(caps["details"], list)
    assert isinstance(caps["bwrap_available"], bool)
    assert isinstance(caps["job_objects_available"], bool)
    assert isinstance(caps["user_separation_available"], bool)


def test_build_sandbox_command_none():
    cmd = ["python", "-m", "app.agent_runner", "red"]
    wrapped, desc = sandbox.build_sandbox_command("red", cmd, force_tool="none")
    assert wrapped == cmd
    assert "process-level" in desc


def test_build_sandbox_command_bubblewrap():
    cmd = ["python", "-m", "app.agent_runner", "red"]
    run_dir = Path("/tmp/bayora-test-run")
    wrapped, desc = sandbox.build_sandbox_command("red", cmd, run_dir=run_dir, force_tool="bubblewrap")

    assert wrapped[0] == "bwrap"
    assert "--ro-bind" in wrapped
    assert "--tmpfs" in wrapped
    assert "--unshare-user" in wrapped
    assert "--unshare-pid" in wrapped
    assert str(run_dir / "red") in wrapped
    assert wrapped[-len(cmd) :] == cmd
    assert "bubblewrap" in desc


def test_build_sandbox_command_firejail():
    cmd = ["python", "-m", "app.agent_runner", "blue"]
    run_dir = Path("/tmp/bayora-test-run")
    wrapped, desc = sandbox.build_sandbox_command("blue", cmd, run_dir=run_dir, force_tool="firejail")

    assert wrapped[0] == "firejail"
    assert "--quiet" in wrapped
    assert f"--private={run_dir / 'blue'}" in wrapped
    assert wrapped[-len(cmd) :] == cmd
    assert "firejail" in desc


def test_verify_file_isolation_permissions(tmp_path: Path):
    run_dir = tmp_path / ".run"
    blue_dir = run_dir / "blue"
    blue_dir.mkdir(parents=True)
    secret_file = blue_dir / "env.json"
    secret_file.write_text('{"SECRET": "blue_key"}', encoding="utf-8")

    # Set mode to 0o600
    try:
        secret_file.chmod(0o600)
    except OSError:
        pass

    result = sandbox.verify_file_isolation("red", "blue", run_dir)
    assert result["tested"] is True
    assert result["accessor"] == "red"
    assert result["target"] == "blue"

    # Non-existent target
    missing = sandbox.verify_file_isolation("red", "nonexistent", run_dir)
    assert missing["tested"] is False


def test_deployment_meta_includes_os_isolation(client):
    from app.auth import static_token

    res = client.get("/api/meta", headers={"Authorization": f"Bearer {static_token('operator')}"})
    assert res.status_code == 200
    data = res.json()

    assert "deployment" in data
    deploy = data["deployment"]
    assert "os_isolation" in deploy
    os_iso = deploy["os_isolation"]
    assert "platform" in os_iso
    assert "sandbox" in os_iso
    assert "strength" in os_iso
    assert "summary" in os_iso
    assert isinstance(os_iso["details"], list)


def test_role_runtime_checks_reports_sandbox_strength_in_local_process_mode():
    with patch.dict(os.environ, {"BAYORA_MODE": "local-process"}):
        checks = isolation.role_runtime_checks({})
        iso_07 = next((c for c in checks if c[0] == "ISO-07"), None)
        assert iso_07 is not None
        check_id, _title, _status, outcome, detail = iso_07
        assert check_id == "ISO-07"
        assert outcome == "pass"

        caps = sandbox.detect_os_capabilities()
        assert caps["strength"] in detail
        assert caps["summary"] in detail


def test_windows_job_object_execution():
    if sys.platform == "win32":
        res = sandbox.setup_windows_job_object()
        # On Windows, assigning the process to a job object should return True or False without raising exceptions
        assert isinstance(res, bool)
    else:
        assert sandbox.setup_windows_job_object() is False
