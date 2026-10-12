# Novaris Agent Windows Uninstaller Script
# Run as Administrator

$ErrorActionPreference = "Stop"

$TaskName = "NovarisAgent"
$LegacyServiceName = "NovarisAgent"
$InstallDir = "$env:ProgramFiles\Novaris\Agent"

Write-Host "Uninstalling Novaris Agent..." -ForegroundColor Green

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Error: This script must be run as Administrator" -ForegroundColor Red
    exit 1
}

# Stop and remove the scheduled task
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "Stopping the agent..." -ForegroundColor Yellow
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

    Write-Host "Removing the scheduled task..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Scheduled task removed" -ForegroundColor Green
} else {
    Write-Host "Scheduled task not found" -ForegroundColor Yellow
}

# Remove the service registered by earlier versions, if it is still around
$legacyService = Get-Service -Name $LegacyServiceName -ErrorAction SilentlyContinue
if ($legacyService) {
    Write-Host "Removing the legacy Windows service..." -ForegroundColor Yellow
    Stop-Service -Name $LegacyServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $LegacyServiceName | Out-Null
    Start-Sleep -Seconds 2
    Write-Host "Legacy service removed" -ForegroundColor Green
}

# Any agent still running from the install directory has to go before it is
# deleted. The executable is Node's own, so the install path is only visible in
# the command line.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallDir*" } |
    ForEach-Object {
        Write-Host "Stopping agent process $($_.ProcessId)..." -ForegroundColor Yellow
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
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
