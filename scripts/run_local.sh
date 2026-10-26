#!/usr/bin/env bash
# ==============================================================================
# Bayora - Real Process Isolation Demonstration Runner (macOS / Linux)
# ==============================================================================
# Starts 6 real, distinct OS processes:
#   1. Witness Service         -> http://127.0.0.1:8001
#   2. Red Team Agent          -> http://127.0.0.1:8002
#   3. Blue Team Agent         -> http://127.0.0.1:8003
#   4. Target Model Agent      -> http://127.0.0.1:8004
#   5. Control Plane API       -> http://127.0.0.1:8000
#   6. Frontend (Vite)         -> http://127.0.0.1:5173
#
# Each role receives ONLY its own key and config from its own .run/<role>/env.json file.
# Target holds NO signing key. All communication is authenticated via Ed25519 grants.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "======================================================================"
echo " Bayora: Real OS Process Isolation Runner (Phase 1)"
echo " Track 4: Securing Adversarial AI Safety Testing Infrastructure"
echo "======================================================================"

# 1. Provision isolated per-role secrets (0o600 files, 0o700 dirs)
echo "[*] Initializing isolated per-role secret directories in .run/..."
(cd backend && python3 -m uv run python -m app.local_setup)

PIDS=()
cleanup() {
    echo ""
    echo "[*] Shutting down isolated background processes..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
    echo "[+] All processes stopped."
}
trap cleanup EXIT INT TERM

# 2. Start Agents & Control Plane
echo "[*] Spawning independent role agent processes..."
(cd backend && python3 -m uv run python -m app.agent_runner witness) &
PIDS+=($!)

(cd backend && python3 -m uv run python -m app.agent_runner red) &
PIDS+=($!)

(cd backend && python3 -m uv run python -m app.agent_runner blue) &
PIDS+=($!)

(cd backend && python3 -m uv run python -m app.agent_runner target) &
PIDS+=($!)

(cd backend && python3 -m uv run python -m app.agent_runner cp) &
PIDS+=($!)

# 3. Wait for readiness
echo "[*] Waiting for all isolated services to report healthy..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:8000/api/meta >/dev/null 2>&1 && \
       curl -s http://127.0.0.1:8001/v1/checkpoints >/dev/null 2>&1 && \
       curl -s http://127.0.0.1:8002/healthz >/dev/null 2>&1 && \
       curl -s http://127.0.0.1:8003/healthz >/dev/null 2>&1 && \
       curl -s http://127.0.0.1:8004/healthz >/dev/null 2>&1; then
        echo "    [+] All 5 backend services are online and responsive."
        break
    fi
    sleep 1
done

# 4. Start Frontend
echo "[*] Launching Frontend UI..."
OPERATOR_TOKEN=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/.run/frontend/env.json'))['BAYORA_TOKEN_OPERATOR'])")
(cd frontend && BAYORA_TOKEN_OPERATOR="$OPERATOR_TOKEN" BAYORA_DEV_API="http://127.0.0.1:8000" npm run dev) &
PIDS+=($!)

echo ""
echo "======================================================================"
echo " Bayora Local-Process Stack is Live! (No Docker Required)"
echo "======================================================================"
echo " Control Plane:  http://127.0.0.1:8000"
echo " Witness:        http://127.0.0.1:8001"
echo " Red Agent:      http://127.0.0.1:8002"
echo " Blue Agent:     http://127.0.0.1:8003"
echo " Target Agent:   http://127.0.0.1:8004"
echo " Frontend UI:    http://localhost:5173"
echo "======================================================================"
echo "Press Ctrl+C to stop all services."

wait
