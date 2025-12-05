# Novaris Agent Windows Uninstaller Script
# Run as Administrator

$ErrorActionPreference = "Stop"

$ServiceName = "NovarisAgent"
$InstallDir = "$env:ProgramFiles\Novaris\Agent"

Write-Host "Uninstalling Novaris Agent..." -ForegroundColor Green

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Error: This script must be run as Administrator" -ForegroundColor Red
    exit 1
}

# Stop and remove service
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping service..." -ForegroundColor Yellow
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    
    Write-Host "Removing service..." -ForegroundColor Yellow
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    Write-Host "Service removed" -ForegroundColor Green
} else {
    Write-Host "Service not found" -ForegroundColor Yellow
}

# Remove installation directory
if (Test-Path $InstallDir) {
    Write-Host "Removing installation directory..." -ForegroundColor Yellow
    Remove-Item -Path $InstallDir -Recurse -Force
    Write-Host "Installation directory removed" -ForegroundColor Green
}

# Remove parent directory if empty
$parentDir = Split-Path $InstallDir
if (Test-Path $parentDir) {
    $items = Get-ChildItem -Path $parentDir -ErrorAction SilentlyContinue
    if ($items.Count -eq 0) {
        Remove-Item -Path $parentDir -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`nUninstallation complete!" -ForegroundColor Green

