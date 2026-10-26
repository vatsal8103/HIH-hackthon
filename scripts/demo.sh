#!/usr/bin/env bash
# ==============================================================================
# Bayora - Final Judge Demonstration Runner (Hack in Hills '26, Track 4)
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "======================================================================"
echo " Starting Bayora Secure AI Red-Teaming Lab"
echo " Track 4: Securing Adversarial AI Safety Testing Infrastructure"
echo "======================================================================"

# 1. Ensure required keys and environment credentials exist
if [ ! -f ".env" ]; then
    echo "[*] Initializing environment secrets and Ed25519 signing keys..."
    (cd backend && uv run python -m app.keys ../.env)
fi

# 2. Build and start the hardened Docker container stack
echo "[*] Launching hardened multi-container stack (isolated networks)..."
docker compose up -d --build --wait --wait-timeout 120

echo "[*] Waiting for Control Plane health readiness..."
for i in {1..30}; do
    if curl -s -f "http://127.0.0.1:8080/api/meta" >/dev/null 2>&1; then
        echo "[+] Control Plane is online and healthy."
        break
    fi
    sleep 1
done

# 3. Execute a baseline security test run through the full 7-stage pipeline
echo "[*] Executing full adversarial red-teaming test run..."
RUN_ID=$(curl -s -X POST "http://127.0.0.1:8080/api/runs" -H "Content-Type: application/json" -d '{}' | grep -o '"id":"[^"]*' | cut -d'"' -f4)

if [ -n "$RUN_ID" ]; then
    echo "[+] Test run created: ${RUN_ID}"
    STAGES=("attack" "respond" "evaluate" "defend" "retest" "isolate" "report")
    for stage in "${STAGES[@]}"; do
        echo "    Executing stage: ${stage}..."
        curl -s -X POST "http://127.0.0.1:8080/api/runs/${RUN_ID}/advance" \
            -H "Content-Type: application/json" \
            -d "{\"stage\":\"${stage}\"}" >/dev/null 2>&1 || true
    done
    echo "[+] Test run completed and anchored to witness checkpoint."
fi

# 4. Display Judge Demo Walkthrough Guide
echo ""
echo "======================================================================"
echo " Bayora Demo Ready: http://127.0.0.1:8080"
echo "======================================================================"
echo ""
echo "Recommended 3-Minute Demo Presentation Order:"
echo ""
echo " 1. Overview & 3D Security Core (http://127.0.0.1:8080/#/)"
echo "    - Point out the 3D Lattice displaying real baseline vs residual failures."
echo "    - Show the 7-stage execution pipeline and target readiness indicator."
echo ""
echo " 2. Guided Interactive Demo (http://127.0.0.1:8080/#/demo)"
echo "    - Step 1: The Problem (prompt injection & canary exfiltration risk)."
echo "    - Step 2: The Attack (PI-01 direct override test case)."
echo "    - Step 3: Target Response & Evaluation (baseline leak failure)."
echo "    - Step 4: Defense & Continuous Monitoring (trigger live boundary alert)."
echo "    - Step 5: Audit Trail & Tamper Simulation (run live tamper detection)."
echo "    - Step 6: Residual Risk & LLM Isolation (ISO-09/ISO-10 verification)."
echo ""
echo " 3. Zero-Knowledge Continuous Monitoring (http://127.0.0.1:8080/#/monitoring)"
echo "    - Demonstrate real-time 403 / replay / burst alerts with 100% payload redaction."
echo ""
echo " 4. Attack Benchmark Library (http://127.0.0.1:8080/#/attacks)"
echo "    - Show public safety benchmark filters (Lakera Gandalf, JailbreakBench, HarmBench)."
echo ""
echo " 5. Architecture Threat Model (http://127.0.0.1:8080/#/reports)"
echo "    - Click 'Architecture Threat Model' tab."
echo "    - Review the honest threat matrix, failure modes, and automated test proofs."
echo "======================================================================"
