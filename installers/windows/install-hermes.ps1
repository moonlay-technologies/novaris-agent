# Installs the official Hermes Agent only when the local user does not already have it.
# This script intentionally downloads the upstream installer to a temporary file
# instead of piping an unchecked response directly into PowerShell.

$ErrorActionPreference = "Stop"
$HermesInstallerUrl = "https://hermes-agent.nousresearch.com/install.ps1"

function Test-HermesInstalled {
    $command = Get-Command hermes -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return $true
    }

    $candidateFiles = @(
        (Join-Path $env:USERPROFILE ".hermes\hermes-agent"),
        (Join-Path $env:USERPROFILE ".hermes\hermes-agent.exe"),
        (Join-Path $env:USERPROFILE ".local\bin\hermes.exe"),
        (Join-Path $env:LOCALAPPDATA "hermes\hermes-agent.exe"),
        (Join-Path $env:LOCALAPPDATA "Hermes\hermes.exe"),
        (Join-Path $env:ProgramFiles "Hermes\hermes.exe")
    )

    foreach ($candidate in $candidateFiles) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $true
        }
    }

    return $false
}

if (Test-HermesInstalled) {
    Write-Host "Hermes is already installed for the local user. Skipping Hermes installation." -ForegroundColor Yellow
    exit 0
}

$tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("novaris-hermes-install-{0}.ps1" -f ([guid]::NewGuid()))
try {
    Write-Host "Downloading the official Hermes Agent installer..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $HermesInstallerUrl -OutFile $tempScript -UseBasicParsing

    Write-Host "Running the official Hermes Agent installer..." -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempScript -SkipSetup -NonInteractive
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes installer exited with code $LASTEXITCODE"
    }

    Write-Host "Hermes Agent installation completed." -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}
