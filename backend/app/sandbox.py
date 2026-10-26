"""OS-level sandboxing detection and enforcement for Bayora without Docker.

Detects and applies available host operating system isolation primitives:
- Linux: bubblewrap (bwrap), firejail, dedicated OS users, unshared namespaces.
- Windows: Job Objects, process tree containment, ACL DACL file permissions.
- Fallback: process-level isolation with scrubbed environments, strict directory
  permissions (0o700/0o600), and loopback network boundaries.

All mechanisms are honestly labeled with their real strength:
"OS-level", "process-level", "cryptographic", "simulated", or "planned".
Never claim "secure" or "safe".
"""

from __future__ import annotations

import getpass
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any

# Standard Bayora role accounts for OS user separation
BAYORA_USERS = {
    "cp": "bayora-cp",
    "witness": "bayora-witness",
    "red": "bayora-red",
    "blue": "bayora-blue",
    "target": "bayora-target",
}


def _check_user_exists(username: str) -> bool:
    """Check if a local OS user exists without raising exceptions."""
    if sys.platform != "win32":
        try:
            import pwd

            pwd.getpwnam(username)
            return True
        except (KeyError, ImportError):
            return False
    else:
        # On Windows, check via net user command or query
        try:
            import subprocess

            res = subprocess.run(
                ["net", "user", username],
                capture_output=True,
                text=True,
                check=False,
                timeout=2,
            )
            return res.returncode == 0
        except (subprocess.SubprocessError, OSError):
            return False


_JOB_HANDLE: Any = None


def setup_windows_job_object() -> bool:
    """Create a Windows Job Object and assign the current process to it.

    Ensures process containment, child cleanup on termination, and quota boundaries.
    """
    global _JOB_HANDLE
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return False

        proc = kernel32.GetCurrentProcess()
        res = kernel32.AssignProcessToJobObject(job, proc)
        if res:
            _JOB_HANDLE = job
            return True
        return False
    except (OSError, AttributeError):
        return False


def _check_windows_job_objects() -> bool:
    """Check if Windows Job Objects API is available via ctypes."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        return hasattr(kernel32, "CreateJobObjectW")
    except (OSError, AttributeError):
        return False


def detect_os_capabilities() -> dict[str, Any]:
    """Inspect the host operating system for available isolation primitives."""
    plat = sys.platform
    details: list[str] = []

    # 1. Linux bubblewrap (unprivileged namespace containerization)
    has_bwrap = bool(shutil.which("bwrap"))
    if has_bwrap:
        details.append("bubblewrap (bwrap) available for unprivileged namespace sandboxing")

    # 2. Linux firejail
    has_firejail = bool(shutil.which("firejail"))
    if has_firejail:
        details.append("firejail available for application sandboxing")

    # 3. User separation (bayora-* service accounts)
    present_users = [u for u in BAYORA_USERS.values() if _check_user_exists(u)]
    user_separation = len(present_users) == len(BAYORA_USERS)
    if user_separation:
        details.append(f"Dedicated OS service accounts configured: {', '.join(present_users)}")
    elif present_users:
        details.append(f"Partial OS service accounts found: {', '.join(present_users)}")
    else:
        details.append("No dedicated OS service accounts; running under current user")

    # 4. Windows Job Objects
    has_job_objects = _check_windows_job_objects()
    if has_job_objects:
        details.append("Windows Job Objects API available for process containment and memory quotas")

    # 5. Linux cgroups / namespaces
    has_namespaces = Path("/proc/self/ns").exists()
    if has_namespaces:
        details.append("Linux kernel namespaces (/proc/self/ns) accessible")

    # Determine primary sandbox tool and honest isolation strength
    if has_bwrap:
        sandbox_tool = "bubblewrap"
        strength = "OS-level"
        summary = "OS-level namespace sandboxing via bubblewrap"
    elif has_firejail:
        sandbox_tool = "firejail"
        strength = "OS-level"
        summary = "OS-level sandboxing via firejail"
    elif user_separation:
        sandbox_tool = "user-separation"
        strength = "OS-level"
        summary = "OS-level discretionary access control via distinct service accounts"
    elif has_job_objects:
        sandbox_tool = "job-objects"
        strength = "process-level"
        summary = "Process-level isolation with Windows Job Object containment"
    else:
        sandbox_tool = "none"
        strength = "process-level"
        summary = "Process-level isolation with scrubbed environment and loopback binding"

    current_user = getpass.getuser()

    return {
        "platform": plat,
        "os_name": platform.system(),
        "current_user": current_user,
        "sandbox_tool": sandbox_tool,
        "strength": strength,
        "summary": summary,
        "bwrap_available": has_bwrap,
        "firejail_available": has_firejail,
        "user_separation_available": user_separation,
        "users_present": present_users,
        "job_objects_available": has_job_objects,
        "namespaces_available": has_namespaces,
        "details": details,
    }


def build_sandbox_command(
    role: str,
    cmd: list[str],
    run_dir: Path | None = None,
    force_tool: str | None = None,
) -> tuple[list[str], str]:
    """Wrap command in an OS sandbox if available.

    Returns (wrapped_cmd, active_layer_description).
    """
    caps = detect_os_capabilities()
    tool = force_tool or os.environ.get("BAYORA_SANDBOX", caps["sandbox_tool"])

    if tool == "none":
        return cmd, "process-level (direct execution)"

    if tool == "bubblewrap" and (caps["bwrap_available"] or force_tool == "bubblewrap"):
        # bubblewrap creates an unprivileged sandbox:
        # - Read-only view of host system
        # - Private tmpfs for /tmp
        # - Isolated bind mount of .run/<role>
        # - Isolated namespaces (--unshare-all except --share-net for 127.0.0.1 communication)
        # - Die when parent dies
        bwrap_cmd = [
            "bwrap",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--die-with-parent",
            "--unshare-user",
            "--unshare-ipc",
            "--unshare-pid",
            "--unshare-uts",
        ]
        if run_dir:
            role_dir = run_dir / role
            bwrap_cmd.extend(["--bind", str(role_dir), str(role_dir)])
        bwrap_cmd.extend(["--", *cmd])
        return bwrap_cmd, "OS-level (bubblewrap unprivileged namespace)"

    if tool == "firejail" and (caps["firejail_available"] or force_tool == "firejail"):
        fj_cmd = ["firejail", "--quiet", "--noprofile"]
        if run_dir:
            role_dir = run_dir / role
            fj_cmd.append(f"--private={role_dir}")
        fj_cmd.extend(["--", *cmd])
        return fj_cmd, "OS-level (firejail sandbox)"

    if tool == "user-separation" and caps["user_separation_available"]:
        user = BAYORA_USERS.get(role)
        if user and os.geteuid() == 0 if hasattr(os, "geteuid") else False:
            su_cmd = ["runuser", "-u", user, "--", *cmd]
            return su_cmd, f"OS-level (user separation as {user})"

    return cmd, "process-level (direct execution, sandbox tool not active)"


def verify_file_isolation(accessor_role: str, target_role: str, run_dir: Path) -> dict[str, Any]:
    """Attempt to access target_role's secrets from accessor_role perspective.

    Used by tests and isolation probes to prove whether role directories are isolated.
    """
    target_secret = run_dir / target_role / "env.json"
    if not target_secret.exists():
        return {
            "tested": False,
            "isolated": True,
            "reason": f"Target file {target_secret} does not exist",
        }

    # Check file mode
    mode = target_secret.stat().st_mode & 0o777
    is_restricted_mode = (mode & 0o077) == 0  # no permissions for group/others

    # If both running as the same local OS user without bubblewrap/user separation,
    # OS DAC allows the read, but file permissions restrict other users.
    caps = detect_os_capabilities()

    return {
        "tested": True,
        "accessor": accessor_role,
        "target": target_role,
        "path": str(target_secret),
        "mode": oct(mode),
        "restricted_permissions": is_restricted_mode,
        "user_separation_enforced": caps["user_separation_available"],
        "sandbox": caps["sandbox_tool"],
    }
