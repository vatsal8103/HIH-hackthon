"""Bayora — Single-command launcher for backend + frontend.

Usage:
    python main.py          # starts both servers
    python main.py --back   # backend only  (port 8000)
    python main.py --front  # frontend only (port 5173)

Press Ctrl+C to stop everything.
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

# Force UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
ENV_FILE = ROOT / ".env"

# ── colours for terminal output ────────────────────────────────────────
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"


def banner():
    print(f"""
{CYAN}{BOLD}+======================================================+
|            BAYORA  -  AI Red-Team Lab                |
|       Hack in Hills '26  -  Track 4: Security        |
+======================================================+{RESET}
""")


def load_dotenv():
    """Load .env file into os.environ (simple key=value parser)."""
    if not ENV_FILE.exists():
        return
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


def check_prerequisites():
    """Verify backend and frontend directories exist."""
    errors = []
    if not BACKEND_DIR.exists():
        errors.append(f"  ✗ Backend directory not found: {BACKEND_DIR}")
    if not FRONTEND_DIR.exists():
        errors.append(f"  ✗ Frontend directory not found: {FRONTEND_DIR}")

    # Check uv is available
    try:
        subprocess.run(
            ["uv", "--version"],
            capture_output=True,
            timeout=10,
        )
    except FileNotFoundError:
        errors.append("  ✗ 'uv' not found. Install it: https://docs.astral.sh/uv/")

    # Check npm is available
    try:
        subprocess.run(
            ["npm", "--version"],
            capture_output=True,
            timeout=10,
            shell=(sys.platform == "win32"),
        )
    except FileNotFoundError:
        errors.append("  ✗ 'npm' not found. Install Node.js 20+: https://nodejs.org/")

    if errors:
        print(f"\n{RED}{BOLD}Prerequisites missing:{RESET}")
        for e in errors:
            print(f"{RED}{e}{RESET}")
        sys.exit(1)


def install_frontend_deps():
    """Run npm install if node_modules is missing."""
    node_modules = FRONTEND_DIR / "node_modules"
    if not node_modules.exists():
        print(f"{YELLOW}  ... Installing frontend dependencies (npm install)...{RESET}")
        result = subprocess.run(
            ["npm", "install"],
            cwd=str(FRONTEND_DIR),
            shell=(sys.platform == "win32"),
        )
        if result.returncode != 0:
            print(f"{RED}  ✗ npm install failed{RESET}")
            sys.exit(1)
        print(f"{GREEN}  [OK] Frontend dependencies installed{RESET}")


def sync_backend_deps():
    """Run uv sync if .venv is missing."""
    venv = BACKEND_DIR / ".venv"
    if not venv.exists():
        print(f"{YELLOW}  ... Syncing backend dependencies (uv sync)...{RESET}")
        result = subprocess.run(
            ["uv", "sync"],
            cwd=str(BACKEND_DIR),
        )
        if result.returncode != 0:
            print(f"{RED}  ✗ uv sync failed{RESET}")
            sys.exit(1)
        print(f"{GREEN}  [OK] Backend dependencies synced{RESET}")


def start_backend():
    """Start FastAPI backend on port 8000."""
    print(f"{CYAN}  >> Starting backend (http://127.0.0.1:8000) ...{RESET}")
    env = {**os.environ}
    return subprocess.Popen(
        ["uv", "run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"],
        cwd=str(BACKEND_DIR),
        env=env,
    )


def start_frontend():
    """Start Vite dev server on port 5173."""
    print(f"{CYAN}  >> Starting frontend (http://127.0.0.1:5173) ...{RESET}")
    return subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=str(FRONTEND_DIR),
        shell=(sys.platform == "win32"),
    )


def main():
    # Parse simple flags
    only_back = "--back" in sys.argv
    only_front = "--front" in sys.argv

    banner()
    load_dotenv()
    check_prerequisites()

    provider = os.environ.get("BAYORA_TARGET_PROVIDER", "simulator")
    print(f"{GREEN}  Target provider: {BOLD}{provider}{RESET}")
    if provider == "groq" and not os.environ.get("GROQ_API_KEY"):
        print(f"{YELLOW}  [!] GROQ_API_KEY not set -- Groq calls will fail{RESET}")
    print()

    processes: list[subprocess.Popen] = []

    try:
        if not only_front:
            sync_backend_deps()
            backend = start_backend()
            processes.append(backend)

        if not only_back:
            install_frontend_deps()
            frontend = start_frontend()
            processes.append(frontend)

        print(f"""
{GREEN}{BOLD}  [OK] Bayora is running!{RESET}
{GREEN}  -----------------------------------------{RESET}
{GREEN}  Backend API  -> {BOLD}http://127.0.0.1:8000{RESET}
{GREEN}  Frontend UI  -> {BOLD}http://127.0.0.1:5173{RESET}
{GREEN}  API docs     -> {BOLD}http://127.0.0.1:8000/docs{RESET}
{GREEN}  -----------------------------------------{RESET}
{YELLOW}  Press Ctrl+C to stop all services{RESET}
""")

        # Wait for any process to exit
        while True:
            for proc in processes:
                ret = proc.poll()
                if ret is not None:
                    name = "Backend" if proc == processes[0] and not only_front else "Frontend"
                    print(f"\n{RED}  [X] {name} exited with code {ret}{RESET}")
                    raise KeyboardInterrupt
            time.sleep(1)

    except KeyboardInterrupt:
        print(f"\n{YELLOW}{BOLD}  Shutting down Bayora...{RESET}")
        for proc in processes:
            try:
                if sys.platform == "win32":
                    # On Windows, terminate the process tree
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                        capture_output=True,
                    )
                else:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
        # Wait briefly for cleanup
        for proc in processes:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        print(f"{GREEN}  [OK] All services stopped. Goodbye!{RESET}\n")


if __name__ == "__main__":
    main()
