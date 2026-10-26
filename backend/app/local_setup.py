"""Local process secret provisioning and environment setup for non-Docker execution.

Creates isolated, per-role directories (.run/cp, .run/red, .run/blue, .run/target,
.run/witness, .run/frontend) with strict file permissions (0o700 for dirs, 0o600 for
secret files on POSIX). Each role receives ONLY its own signing key and configuration,
never a shared .env file.
"""

import hashlib
import json
import os
import secrets
import stat
from pathlib import Path

from app import tokens

PORTS = {
    "cp": 8000,
    "witness": 8001,
    "red": 8002,
    "blue": 8003,
    "target": 8004,
    "frontend": 5173,
}


def _secure_mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        try:
            os.chmod(path, stat.S_IRWXU)  # 0o700
        except OSError:
            pass


def _secure_write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    if os.name == "posix":
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 0o600
        except OSError:
            pass


def _write_env_file(path: Path, env_dict: dict[str, str]) -> None:
    lines = [f"{k}={v}" for k, v in env_dict.items()]
    _secure_write_text(path, "\n".join(lines) + "\n")


def setup_local_env(project_root: Path | None = None) -> dict[str, Path]:
    """Provision isolated per-role runtime directories and secrets under .run/."""
    if project_root is None:
        project_root = Path(__file__).resolve().parents[2]

    run_dir = project_root / ".run"
    _secure_mkdir(run_dir)
    _secure_write_text(run_dir / ".gitignore", "*\n")

    roles = ["cp", "red", "blue", "target", "witness", "frontend"]
    role_dirs = {}
    for role in roles:
        role_dir = run_dir / role
        _secure_mkdir(role_dir)
        role_dirs[role] = role_dir

    _secure_mkdir(run_dir / "witness" / "data")

    # Generate keys
    cp_priv, cp_pub = tokens.generate("cp-1")
    red_priv, red_pub = tokens.generate("red-1")
    blue_priv, blue_pub = tokens.generate("blue-1")

    # Operator token & witness token
    operator_token = secrets.token_hex(24)
    operator_token_hash = hashlib.sha256(operator_token.encode("utf-8")).hexdigest()
    witness_token = secrets.token_hex(24)

    witness_data_dir = (run_dir / "witness" / "data").resolve()
    db_path = (project_root / "bayora.db").resolve()

    common_ports = {
        "BAYORA_CP_PORT": str(PORTS["cp"]),
        "BAYORA_WITNESS_PORT": str(PORTS["witness"]),
        "BAYORA_RED_PORT": str(PORTS["red"]),
        "BAYORA_BLUE_PORT": str(PORTS["blue"]),
        "BAYORA_TARGET_PORT": str(PORTS["target"]),
    }

    # 1. Control Plane config (holds only CP private key and public keys of roles)
    cp_env = {
        "BAYORA_MODE": "local-process",
        "BAYORA_REQUIRE_TOKENS": "1",
        "BAYORA_OPERATOR_TOKEN_SHA256": operator_token_hash,
        "BAYORA_CP_SIGNING_KEY": cp_priv,
        "BAYORA_CP_PUBLIC_KEYS": cp_pub,
        "BAYORA_RED_PUBLIC_KEYS": red_pub,
        "BAYORA_BLUE_PUBLIC_KEYS": blue_pub,
        "BAYORA_WITNESS_URL": f"http://127.0.0.1:{PORTS['witness']}",
        "BAYORA_WITNESS_TOKEN": witness_token,
        "BAYORA_RED_AGENT_URL": f"http://127.0.0.1:{PORTS['red']}",
        "BAYORA_BLUE_AGENT_URL": f"http://127.0.0.1:{PORTS['blue']}",
        "BAYORA_TARGET_AGENT_URL": f"http://127.0.0.1:{PORTS['target']}",
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
        **common_ports,
    }
    _write_env_file(role_dirs["cp"] / "env", cp_env)
    _secure_write_text(role_dirs["cp"] / "env.json", json.dumps(cp_env, indent=2))

    # 2. Red Agent config (holds Red signing key & CP public key)
    red_env = {
        "BAYORA_MODE": "local-process",
        "BAYORA_API_URL": f"http://127.0.0.1:{PORTS['cp']}",
        "BAYORA_RED_SIGNING_KEY": red_priv,
        "BAYORA_CP_PUBLIC_KEYS": cp_pub,
        **common_ports,
    }
    _write_env_file(role_dirs["red"] / "env", red_env)
    _secure_write_text(role_dirs["red"] / "env.json", json.dumps(red_env, indent=2))

    # 3. Blue Agent config (holds Blue signing key & CP public key)
    blue_env = {
        "BAYORA_MODE": "local-process",
        "BAYORA_API_URL": f"http://127.0.0.1:{PORTS['cp']}",
        "BAYORA_BLUE_SIGNING_KEY": blue_priv,
        "BAYORA_CP_PUBLIC_KEYS": cp_pub,
        **common_ports,
    }
    _write_env_file(role_dirs["blue"] / "env", blue_env)
    _secure_write_text(role_dirs["blue"] / "env.json", json.dumps(blue_env, indent=2))

    # 4. Target Agent config (HOLDS NO SIGNING KEY; only CP public key)
    target_env = {
        "BAYORA_MODE": "local-process",
        "BAYORA_API_URL": f"http://127.0.0.1:{PORTS['cp']}",
        "BAYORA_CP_PUBLIC_KEYS": cp_pub,
        "BAYORA_TARGET_PROVIDER": "simulator",
        **common_ports,
    }
    _write_env_file(role_dirs["target"] / "env", target_env)
    _secure_write_text(role_dirs["target"] / "env.json", json.dumps(target_env, indent=2))

    # 5. Witness config (independent storage and witness token)
    witness_env = {
        "BAYORA_MODE": "local-process",
        "BAYORA_WITNESS_TOKEN": witness_token,
        "BAYORA_WITNESS_DATA": witness_data_dir.as_posix(),
        **common_ports,
    }
    _write_env_file(role_dirs["witness"] / "env", witness_env)
    _secure_write_text(role_dirs["witness"] / "env.json", json.dumps(witness_env, indent=2))

    # 6. Frontend config (operator token for dev proxy injection)
    frontend_env = {
        "BAYORA_MODE": "local-process",
        "BAYORA_TOKEN_OPERATOR": operator_token,
        "BAYORA_DEV_API": f"http://127.0.0.1:{PORTS['cp']}",
    }
    _write_env_file(role_dirs["frontend"] / "env", frontend_env)
    _secure_write_text(role_dirs["frontend"] / "env.json", json.dumps(frontend_env, indent=2))

    return role_dirs


if __name__ == "__main__":
    dirs = setup_local_env()
    print("Isolated per-role runtime directories configured successfully in .run/:")
    for role, path in dirs.items():
        print(f"  [{role}] -> {path}")
