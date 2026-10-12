# Novaris Agent Windows Installer Script
# Run as Administrator

$ErrorActionPreference = "Stop"

$TaskName = "NovarisAgent"
$TaskDescription = "Monitors device health and reports to Novaris Asset Management System"
$LegacyServiceName = "NovarisAgent"
$InstallDir = "$env:ProgramFiles\Novaris\Agent"
$ConfigFile = "$InstallDir\config.json"
$AgentScript = "$InstallDir\dist\index.js"

Write-Host "Installing Novaris Agent..." -ForegroundColor Green

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Error: This script must be run as Administrator" -ForegroundColor Red
    exit 1
}

# Node runs the agent, so it has to be present before anything is registered
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodePath = $nodeCommand.Source
} else {
    $nodeCandidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe"
    )
    $nodePath = $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $nodePath) {
    Write-Host "Error: Node.js was not found. Install Node.js and run this script again." -ForegroundColor Red
    exit 1
}

Write-Host "Using Node.js at $nodePath" -ForegroundColor Cyan

# Install Hermes through the official upstream installer. The helper performs
# a local-user detection first and exits without installing when Hermes already
# exists on this machine.
Write-Host "Checking for an existing Hermes installation..." -ForegroundColor Yellow
& "$PSScriptRoot\install-hermes.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "Hermes installation failed with exit code $LASTEXITCODE"
}

# Create installation directory
Write-Host "Creating installation directory..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Copy files
Write-Host "Copying files..." -ForegroundColor Yellow
Copy-Item -Path ".\*" -Destination $InstallDir -Recurse -Force -Exclude "install.ps1","uninstall.ps1"

# A task pointing at a missing script would fail silently at every boot
if (-not (Test-Path $AgentScript)) {
    Write-Host "Error: $AgentScript is missing. Run this script from a build that contains dist\index.js." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$InstallDir\node_modules")) {
    Write-Host "Warning: node_modules is missing from $InstallDir. The agent cannot start without its dependencies." -ForegroundColor Yellow
}

# Create config file if it doesn't exist
if (-not (Test-Path $ConfigFile)) {
    Write-Host "Creating default configuration..." -ForegroundColor Yellow
    $defaultConfig = @{
        apiUrl = "http://localhost:3000/api/v1"
        apiKey = ""
        assetTag = ""
        collectInterval = 300
        reportInterval = 300
        retryAttempts = 3
        retryDelay = 1000
        logLevel = "info"
    } | ConvertTo-Json -Depth 10

    $defaultConfig | Out-File -FilePath $ConfigFile -Encoding UTF8
    Write-Host "Please edit $ConfigFile and set apiUrl, apiKey and assetTag" -ForegroundColor Yellow
}

# Earlier versions registered an sc.exe service around the same script. A plain
# Node process never answers the service control manager, so such a service
# fails to start with error 1053; remove it in favour of the scheduled task.
$legacyService = Get-Service -Name $LegacyServiceName -ErrorAction SilentlyContinue
if ($legacyService) {
    Write-Host "Removing the legacy Windows service..." -ForegroundColor Yellow
    Stop-Service -Name $LegacyServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $LegacyServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# Register the agent to run at boot, before anyone logs in
Write-Host "Registering the agent to start at boot..." -ForegroundColor Yellow

$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$AgentScript`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Laptops spend most of their life on battery, where the default task settings
# would refuse to start the agent and stop it as soon as the charger is pulled.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description $TaskDescription `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered" -ForegroundColor Green

# Start it now so the device does not wait for the next boot to report
try {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Agent started" -ForegroundColor Green
} catch {
    Write-Host "Warning: could not start the agent now: $_" -ForegroundColor Yellow
    Write-Host "It will start at the next boot." -ForegroundColor Yellow
}

Write-Host "`nInstallation complete!" -ForegroundColor Green
Write-Host "Installation directory: $InstallDir" -ForegroundColor Cyan
Write-Host "Configuration file: $ConfigFile" -ForegroundColor Cyan
Write-Host "`nThe agent runs in the background and starts automatically at boot." -ForegroundColor Cyan
Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "1. Edit $ConfigFile and set apiUrl, apiKey and assetTag" -ForegroundColor White
Write-Host "2. Restart the agent: Restart-ScheduledTask -TaskName $TaskName" -ForegroundColor White
Write-Host "3. Check it is running: Get-ScheduledTask -TaskName $TaskName" -ForegroundColor White
