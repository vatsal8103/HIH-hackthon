# ==============================================================================
# Bayora - Final Judge Demonstration Runner (Windows PowerShell)
# ==============================================================================
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $ScriptDir "..")

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Starting Bayora Secure AI Red-Teaming Lab" -ForegroundColor Cyan
Write-Host " Track 4: Securing Adversarial AI Safety Testing Infrastructure" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Keys check
if (-not (Test-Path ".env")) {
    Write-Host "[*] Initializing environment secrets and Ed25519 signing keys..." -ForegroundColor Yellow
    Push-Location backend
    python -m uv run python -m app.keys ../.env
    Pop-Location
}

# 2. Start stack
Write-Host "[*] Launching hardened multi-container stack (isolated networks)..." -ForegroundColor Yellow
docker compose up -d --build --wait --wait-timeout 120

# 3. Wait for Control Plane
Write-Host "[*] Waiting for Control Plane health readiness..." -ForegroundColor Yellow
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/meta" -Method Get -TimeoutSec 2
        if ($res.stages) {
            $healthy = $true
            Write-Host "[+] Control Plane is online and healthy." -ForegroundColor Green
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}

# 4. Trigger one full test run
Write-Host "[*] Executing full adversarial red-teaming test run..." -ForegroundColor Yellow
try {
    $run = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/runs" -Method Post -Body "{}" -ContentType "application/json"
    $runId = $run.id
    Write-Host "[+] Test run created: $runId" -ForegroundColor Green

    $stages = @("attack", "respond", "evaluate", "defend", "retest", "isolate", "report")
    foreach ($stage in $stages) {
        Write-Host "    Executing stage: $stage..." -ForegroundColor Gray
        $body = @{ stage = $stage } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/runs/$runId/advance" -Method Post -Body $body -ContentType "application/json" | Out-Null
    }
    Write-Host "[+] Test run completed and anchored to witness checkpoint." -ForegroundColor Green
} catch {
    Write-Host "[!] Note: Could not auto-trigger run. You can start one directly in the UI." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Bayora Demo Ready: http://127.0.0.1:8080" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Recommended 3-Minute Demo Presentation Order:"
Write-Host " 1. Overview & 3D Security Core (http://127.0.0.1:8080/#/)"
Write-Host " 2. Guided Interactive Demo (http://127.0.0.1:8080/#/demo)"
Write-Host "    - Step 1: The Problem (prompt injection risk)"
Write-Host "    - Step 2: The Attack (PI-01 test case)"
Write-Host "    - Step 3: Target Response & Evaluation (baseline leak)"
Write-Host "    - Step 4: Defense & Continuous Monitoring (live alert trigger)"
Write-Host "    - Step 5: Audit Trail & Tamper Simulation (live tamper check)"
Write-Host "    - Step 6: Residual Risk & LLM Isolation (ISO-09/10 checks)"
Write-Host " 3. Zero-Knowledge Continuous Monitoring (http://127.0.0.1:8080/#/monitoring)"
Write-Host " 4. Public Benchmark Attack Library (http://127.0.0.1:8080/#/attacks)"
Write-Host " 5. Architecture Threat Model (http://127.0.0.1:8080/#/reports)"
Write-Host "======================================================================" -ForegroundColor Cyan
