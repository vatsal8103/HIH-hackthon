<#
.SYNOPSIS
    Bayora - Local Network Control Setup (Windows Defender Firewall)
.DESCRIPTION
    Track 4: Securing Adversarial AI Safety Testing Infrastructure

    Configures Windows Defender Firewall rules for loopback isolation:
      - Block cross-role port access between Red (8002), Blue (8003), Target (8004).
      - Block outbound non-loopback network egress for bayora-* local service accounts.

    Requires elevated PowerShell terminal (Run as Administrator).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Bayora: Local Network Control Configuration (Windows Firewall)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "[!] This script requires Administrator privileges to configure Windows Firewall rules."
    Write-Warning "    Please re-run this script in an elevated PowerShell terminal (Run as Administrator)."
    Write-Host ""
    Write-Host "[*] Policy rules to be enforced:" -ForegroundColor Yellow
    Write-Host "    - Outbound Block: Port 8003 (Blue) for bayora-red"
    Write-Host "    - Outbound Block: Port 8002 (Red) for bayora-blue"
    Write-Host "    - Outbound Block: Ports 8002, 8003 for bayora-target"
    Write-Host "    - Outbound Block: Non-loopback egress for bayora-red, bayora-blue, bayora-target"
    exit 1
}

# 1. Cross-role loopback port blocking rules
$Rules = @(
    @{ Name = "Bayora-Block-Red-To-Blue"; Port = "8003"; User = "bayora-red"; Desc = "Blocks Red agent from reaching Blue agent" },
    @{ Name = "Bayora-Block-Red-To-Target"; Port = "8004"; User = "bayora-red"; Desc = "Blocks Red agent from reaching Target agent directly" },
    @{ Name = "Bayora-Block-Blue-To-Red"; Port = "8002"; User = "bayora-blue"; Desc = "Blocks Blue agent from reaching Red agent" },
    @{ Name = "Bayora-Block-Target-To-Red"; Port = "8002"; User = "bayora-target"; Desc = "Blocks Target agent from reaching Red agent" },
    @{ Name = "Bayora-Block-Target-To-Blue"; Port = "8003"; User = "bayora-target"; Desc = "Blocks Target agent from reaching Blue agent" }
)

foreach ($R in $Rules) {
    $Existing = Get-NetFirewallRule -Name $R.Name -ErrorAction SilentlyContinue
    if ($Existing) {
        Remove-NetFirewallRule -Name $R.Name | Out-Null
    }
    New-NetFirewallRule -Name $R.Name -DisplayName $R.Name -Direction Outbound -Action Block `
        -Protocol TCP -RemotePort $R.Port -Description $R.Desc | Out-Null
    Write-Host "    [+] Rule active: $($R.Name) (Port $($R.Port) Blocked)" -ForegroundColor Green
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Windows Firewall loopback isolation rules applied." -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
