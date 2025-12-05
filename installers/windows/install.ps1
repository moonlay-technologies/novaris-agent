# Novaris Agent Windows Installer Script
# Run as Administrator

$ErrorActionPreference = "Stop"

$ServiceName = "NovarisAgent"
$ServiceDisplayName = "Novaris Device Monitoring Agent"
$ServiceDescription = "Monitors device health and reports to Novaris Asset Management System"
$InstallDir = "$env:ProgramFiles\Novaris\Agent"
$ConfigFile = "$InstallDir\config.json"

Write-Host "Installing Novaris Agent..." -ForegroundColor Green

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Error: This script must be run as Administrator" -ForegroundColor Red
    exit 1
}

# Create installation directory
Write-Host "Creating installation directory..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Copy files
Write-Host "Copying files..." -ForegroundColor Yellow
Copy-Item -Path ".\*" -Destination $InstallDir -Recurse -Force -Exclude "install.ps1","uninstall.ps1"

# Create config file if it doesn't exist
if (-not (Test-Path $ConfigFile)) {
    Write-Host "Creating default configuration..." -ForegroundColor Yellow
    $defaultConfig = @{
        apiUrl = "http://localhost:3000/api/v1"
        apiKey = ""
        collectInterval = 300
        reportInterval = 300
        retryAttempts = 3
        retryDelay = 1000
        logLevel = "info"
    } | ConvertTo-Json -Depth 10
    
    $defaultConfig | Out-File -FilePath $ConfigFile -Encoding UTF8
    Write-Host "Please edit $ConfigFile and set your API URL and API Key" -ForegroundColor Yellow
}

# Install as Windows Service using node-windows or similar
Write-Host "Installing Windows Service..." -ForegroundColor Yellow

# Check if service already exists
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "Service already exists. Stopping and removing..." -ForegroundColor Yellow
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# Create service using nssm (Non-Sucking Service Manager) or node-windows
# For now, we'll use a simple approach with node-windows
$nodePath = (Get-Command node).Source
$serviceScript = "$InstallDir\dist\index.js"

# Install using node-windows (requires: npm install -g node-windows)
try {
    $nwPath = Get-Command nw -ErrorAction SilentlyContinue
    if ($nwPath) {
        & nw install --name $ServiceName --script $serviceScript --description $ServiceDescription
        Write-Host "Service installed successfully" -ForegroundColor Green
    } else {
        Write-Host "Warning: node-windows not found. Installing service manually..." -ForegroundColor Yellow
        # Manual service installation using sc.exe
        $binPath = "`"$nodePath`" `"$serviceScript`""
        sc.exe create $ServiceName binPath= $binPath DisplayName= "$ServiceDisplayName" start= auto
        sc.exe description $ServiceName "$ServiceDescription"
        Write-Host "Service created. Please start it manually: Start-Service -Name $ServiceName" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Error installing service: $_" -ForegroundColor Red
    Write-Host "You may need to install the service manually" -ForegroundColor Yellow
}

Write-Host "`nInstallation complete!" -ForegroundColor Green
Write-Host "Installation directory: $InstallDir" -ForegroundColor Cyan
Write-Host "Configuration file: $ConfigFile" -ForegroundColor Cyan
Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "1. Edit $ConfigFile and set your API URL and API Key" -ForegroundColor White
Write-Host "2. Start the service: Start-Service -Name $ServiceName" -ForegroundColor White

