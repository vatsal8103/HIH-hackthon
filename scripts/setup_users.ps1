<#
.SYNOPSIS
    Bayora - Provision Dedicated Local Windows Service Accounts & ACLs
.DESCRIPTION
    Track 4: Securing Adversarial AI Safety Testing Infrastructure

    Creates separate unprivileged local Windows users:
      - bayora-cp
      - bayora-witness
      - bayora-red
      - bayora-blue
      - bayora-target

    Configures discretionary access control lists (DACLs) via icacls so that:
      - .run\red is readable ONLY by bayora-red (and Administrator)
      - .run\blue is readable ONLY by bayora-blue (and Administrator)
      - .run\target is readable ONLY by bayora-target
      - .run\witness is readable ONLY by bayora-witness
      - .run\cp is readable ONLY by bayora-cp

    Must be run from an elevated PowerShell session (Run as Administrator).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$RunDir = Join-Path $ProjectRoot ".run"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Bayora: Provisioning Windows Service Accounts & DACLs" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# Check for administrative privileges
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "[!] This script requires Administrator privileges to create local accounts or set system DACLs."
    Write-Warning "    Please re-run this script in an elevated PowerShell terminal (Run as Administrator)."
    Write-Host ""
    Write-Host "[*] Showing what DACLs will be applied once elevated:" -ForegroundColor Yellow
    Write-Host "    icacls .run\red    /inheritance:r /grant:r `"bayora-red:(OI)(CI)F`""
    Write-Host "    icacls .run\blue   /inheritance:r /grant:r `"bayora-blue:(OI)(CI)F`""
    Write-Host "    icacls .run\target /inheritance:r /grant:r `"bayora-target:(OI)(CI)F`""
    Write-Host "    icacls .run\cp     /inheritance:r /grant:r `"bayora-cp:(OI)(CI)F`""
    exit 1
}

$Roles = @("cp", "witness", "red", "blue", "target")

foreach ($Role in $Roles) {
    $Username = "bayora-$Role"
    $Existing = Get-LocalUser -Name $Username -ErrorAction SilentlyContinue
    if ($Existing) {
        Write-Host "    [*] Local user $Username already exists." -ForegroundColor Gray
    } else {
        Write-Host "    [+] Creating unprivileged local user $Username..." -ForegroundColor Green
        $Password = ConvertTo-SecureString "B@yoraTestPass2026!" -AsPlainText -Force
        New-LocalUser -Name $Username -Password $Password -Description "Bayora isolated role service account ($Role)" -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    }
}

if (Test-Path $RunDir) {
    Write-Host "[*] Applying per-role DACLs via icacls..." -ForegroundColor Cyan
    foreach ($Role in $Roles) {
        $Username = "bayora-$Role"
        $RoleDir = Join-Path $RunDir $Role
        if (Test-Path $RoleDir) {
            # Disable inheritance and grant full access only to the specific service account and Administrator
            icacls $RoleDir /inheritance:r /grant:r "${Username}:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F" | Out-Null
            Write-Host "    [+] Restricted $RoleDir exclusively to $Username and Administrators." -ForegroundColor Green
        }
    }
} else {
    Write-Warning "[!] $RunDir not found. Run 'python -m app.local_setup' to generate directory structure."
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Windows service accounts and DACLs configured." -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
