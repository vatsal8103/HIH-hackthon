# ==============================================================================
# Bayora - Real Process Isolation Demonstration Runner (No Docker)
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
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Join-Path $ScriptDir "..")
Set-Location $ProjectRoot

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Bayora: Real OS Process Isolation Runner (Phase 1)" -ForegroundColor Cyan
Write-Host " Track 4: Securing Adversarial AI Safety Testing Infrastructure" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Provision isolated per-role secrets (0o600 files, 0o700 dirs)
Write-Host "[*] Initializing isolated per-role secret directories in .run/..." -ForegroundColor Yellow
Push-Location backend
python -m uv run python -m app.local_setup
Pop-Location

# 2. Function to launch a role process
$Processes = @()

function Start-RoleProcess([string]$role, [int]$port) {
    Write-Host "    [+] Launching $role agent on 127.0.0.1:$port..." -ForegroundColor Gray
    $cmd = "Set-Location '$ProjectRoot\backend'; python -m uv run python -m app.agent_runner $role"
    $p = Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd -PassThru -WindowStyle Hidden
    return $p
}

Write-Host "[*] Spawning independent role agent processes..." -ForegroundColor Yellow
$pWitness = Start-RoleProcess "witness" 8001
$Processes += $pWitness
$pRed     = Start-RoleProcess "red" 8002
$Processes += $pRed
$pBlue    = Start-RoleProcess "blue" 8003
$Processes += $pBlue
$pTarget  = Start-RoleProcess "target" 8004
$Processes += $pTarget
$pCp      = Start-RoleProcess "cp" 8000
$Processes += $pCp

# 3. Wait for Control Plane and Agents to answer health checks
Write-Host "[*] Waiting for all isolated services to report healthy..." -ForegroundColor Yellow
$services = @(
    @{ name = "witness";       url = "http://127.0.0.1:8001/v1/checkpoints" },
    @{ name = "red-agent";     url = "http://127.0.0.1:8002/healthz" },
    @{ name = "blue-agent";    url = "http://127.0.0.1:8003/healthz" },
    @{ name = "target-agent";  url = "http://127.0.0.1:8004/healthz" },
    @{ name = "control-plane"; url = "http://127.0.0.1:8000/api/meta" }
)

$deadline = (Get-Date).AddSeconds(20)
foreach ($s in $services) {
    $ok = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Invoke-RestMethod -Uri $s.url -Method Get -TimeoutSec 1
            $ok = $true
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if ($ok) {
        Write-Host "    [OK] $($s.name) online and responsive." -ForegroundColor Green
    } else {
        Write-Host "    [!] Warning: $($s.name) not yet responsive at $($s.url)" -ForegroundColor Yellow
    }
}

# 4. Start Frontend
Write-Host "[*] Launching Frontend UI with operator token injection..." -ForegroundColor Yellow
$feEnv = Get-Content "$ProjectRoot\.run\frontend\env.json" | ConvertFrom-Json
$feCmd = "Set-Location '$ProjectRoot\frontend'; `$env:BAYORA_TOKEN_OPERATOR='$($feEnv.BAYORA_TOKEN_OPERATOR)'; `$env:BAYORA_DEV_API='http://127.0.0.1:8000'; npm run dev"
$pFe = Start-Process powershell -ArgumentList "-NoExit", "-Command", $feCmd -PassThru -WindowStyle Hidden
$Processes += $pFe

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Bayora Local-Process Stack is Live! (No Docker Required)" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Control Plane:  http://127.0.0.1:8000" -ForegroundColor White
Write-Host " Witness:        http://127.0.0.1:8001" -ForegroundColor White
Write-Host " Red Agent:      http://127.0.0.1:8002" -ForegroundColor White
Write-Host " Blue Agent:     http://127.0.0.1:8003" -ForegroundColor White
Write-Host " Target Agent:   http://127.0.0.1:8004" -ForegroundColor White
Write-Host " Frontend UI:    http://localhost:5173" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Opening browser to Guided Demo..." -ForegroundColor Yellow
Start-Process "http://localhost:5173/#/demo"

Write-Host ""
Write-Host "Press [Enter] or Ctrl+C to terminate all 6 processes..." -ForegroundColor Yellow
try {
    [void][System.Console]::ReadLine()
} finally {
    Write-Host "[*] Shutting down isolated background processes..." -ForegroundColor Yellow
    foreach ($p in $Processes) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        } catch {}
    }
    Write-Host "[+] All processes stopped." -ForegroundColor Green
}
