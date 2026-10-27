"""Process runner for isolated local role agents.

Loads ONLY the specified role's isolated environment from .run/<role>/env.json
and starts the corresponding FastAPI service bound strictly to 127.0.0.1.
Guarantees zero shared environment cross-contamination between processes.
Applies OS sandboxing (bubblewrap/firejail on Linux, Job Objects on Windows) if available.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from app import sandbox

ROLES = {
    "cp": ("app.main:app", 8000),
    "witness": ("witness.app:app", 8001),
    "red": ("agents.red_agent:app", 8002),
    "blue": ("agents.blue_agent:app", 8003),
    "target": ("agents.target_agent:app", 8004),
}


def run_role(role: str) -> None:
    if role not in ROLES:
        sys.exit(f"Unknown role {role!r}. Allowed: {', '.join(ROLES.keys())}")

    app_target, port = ROLES[role]
    project_root = Path(__file__).resolve().parents[2]
    run_dir = project_root / ".run"
    role_env_file = run_dir / role / "env.json"

    if not role_env_file.exists():
        sys.exit(f"Role environment file missing: {role_env_file}. Run 'python -m app.local_setup' first.")

    # Check if we should re-exec under Linux sandbox (bwrap or firejail)
    if not os.environ.get("BAYORA_SANDBOX_ACTIVE"):
        caps = sandbox.detect_os_capabilities()
        if caps["bwrap_available"] or caps["firejail_available"]:
            cmd = [sys.executable, "-m", "app.agent_runner", role]
            sandboxed_cmd, desc = sandbox.build_sandbox_command(role, cmd, run_dir=run_dir)
            if sandboxed_cmd != cmd:
                print(f"[*] Launching {role} agent inside {desc}...")
                env = os.environ.copy()
                env["BAYORA_SANDBOX_ACTIVE"] = "1"
                os.execvpe(sandboxed_cmd[0], sandboxed_cmd, env)

    # On Windows, assign process to Job Object if possible
    job_ok = sandbox.setup_windows_job_object()

    # 1. Cleanse environment of other roles' keys to guarantee isolation
    forbidden_prefixes = ("BAYORA_RED_", "BAYORA_BLUE_", "BAYORA_TARGET_", "BAYORA_CP_", "BAYORA_WITNESS_")
    for key in list(os.environ.keys()):
        if any(key.startswith(p) for p in forbidden_prefixes):
            del os.environ[key]

    # 2. Inject strictly this role's isolated configuration
    with open(role_env_file, encoding="utf-8") as f:
        role_config = json.load(f)

    for k, v in role_config.items():
        os.environ[k] = str(v)

    os.environ["BAYORA_MODE"] = "local-process"

    # 3. Launch uvicorn bound strictly to loopback
    import uvicorn

    caps = sandbox.detect_os_capabilities()
    isolation_label = caps["summary"]
    if job_ok:
        isolation_label += " (Job Object active)"
    print(
        f"[*] Starting {role} agent ({app_target}) on http://127.0.0.1:{port} "
        f"(PID: {os.getpid()}) [{isolation_label}]..."
    )
    uvicorn.run(app_target, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python -m app.agent_runner <role>  (cp, witness, red, blue, target)")
    run_role(sys.argv[1].strip().lower())
