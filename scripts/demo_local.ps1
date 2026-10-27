# ==============================================================================
# Bayora - Local Standalone Demonstration Runner (No Docker Needed)
# ==============================================================================
# This script runs Bayora completely locally on Windows using Python and Node.js.
# No Docker Desktop, no external LLM APIs, and no API keys required!
# ==============================================================================
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Join-Path $ScriptDir "..")
Set-Location $ProjectRoot

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Starting Bayora Secure AI Red-Teaming Lab (Local Mode)" -ForegroundColor Cyan
Write-Host " Track 4: Securing Adversarial AI Safety Testing Infrastructure" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "[*] Zero external APIs or cloud keys needed - 100% deterministic local runtime." -ForegroundColor Green
Write-Host ""

# 1. Start Backend in separate window
Write-Host "[*] Launching Backend API on http://127.0.0.1:8000..." -ForegroundColor Yellow
$backendCmd = "Set-Location '$ProjectRoot\backend'; python -m uv run uvicorn app.main:app --host 127.0.0.1 --port 8000"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd -WindowStyle Normal

# 2. Wait for Backend
Write-Host "[*] Waiting for backend readiness..." -ForegroundColor Yellow
$healthy = $false
for ($i = 0; $i -lt 15; $i++) {
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/meta" -Method Get -TimeoutSec 2
        if ($res.stages) {
            $healthy = $true
            Write-Host "[+] Backend is online and healthy." -ForegroundColor Green
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}

# 3. Start Frontend in separate window
Write-Host "[*] Launching Frontend UI on http://localhost:5173..." -ForegroundColor Yellow
$frontendCmd = "Set-Location '$ProjectRoot\frontend'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd -WindowStyle Normal

Start-Sleep -Seconds 3

# 4. Open Browser
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Bayora Local Demo is Live!" -ForegroundColor Green
Write-Host " UI URL:  http://localhost:5173" -ForegroundColor Cyan
Write-Host " API URL: http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Opening browser to Guided Demo..." -ForegroundColor Yellow
Start-Process "http://localhost:5173/#/demo"
