"""Process runner for isolated local role agents.

Loads ONLY the specified role's isolated environment from .run/<role>/env.json
and starts the corresponding FastAPI service bound strictly to 127.0.0.1.
Guarantees zero shared environment cross-contamination between processes.
"""

import json
import os
import sys
from pathlib import Path

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
    role_env_file = project_root / ".run" / role / "env.json"

    if not role_env_file.exists():
        sys.exit(f"Role environment file missing: {role_env_file}. Run 'python -m app.local_setup' first.")

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

    print(f"[*] Starting {role} agent ({app_target}) on http://127.0.0.1:{port} (PID: {os.getpid()})...")
    uvicorn.run(app_target, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python -m app.agent_runner <role>  (cp, witness, red, blue, target)")
    run_role(sys.argv[1].strip().lower())
