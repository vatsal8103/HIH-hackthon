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

# 2. Check Docker daemon availability
Write-Host "[*] Checking Docker Desktop status..." -ForegroundColor Yellow
$dockerOk = $false
try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch {
    $dockerOk = $false
}

if ($dockerOk) {
    Write-Host "[*] Docker Engine detected. Launching hardened multi-container stack..." -ForegroundColor Yellow
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
} else {
    Write-Host "[!] Docker Desktop engine is not running on this machine." -ForegroundColor Yellow
    Write-Host "[!] Note: You do NOT need any cloud/external API keys to run Bayora." -ForegroundColor Green
    Write-Host ""
    Write-Host "To run with Docker:" -ForegroundColor Cyan
    Write-Host "  1. Start the Docker Desktop app from Windows Start Menu." -ForegroundColor White
    Write-Host "  2. Once Docker Desktop displays 'Engine running', re-run .\scripts\demo.ps1" -ForegroundColor White
    Write-Host ""
    Write-Host "To run WITHOUT Docker (instant local dev mode, zero setup):" -ForegroundColor Cyan
    Write-Host "  Run: .\scripts\demo_local.ps1" -ForegroundColor Green
    Write-Host "  Or manually in two terminals:" -ForegroundColor White
    Write-Host "    Terminal 1 (Backend):  cd backend; python -m uv run uvicorn app.main:app --host 127.0.0.1 --port 8000" -ForegroundColor Gray
    Write-Host "    Terminal 2 (Frontend): cd frontend; npm run dev" -ForegroundColor Gray
    Write-Host "    Then open:             http://localhost:5173" -ForegroundColor Green
    Write-Host ""
    return
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
