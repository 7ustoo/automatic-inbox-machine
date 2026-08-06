# Windows .exe signer — Microsoft Trusted Signing via AzureSignTool.
# Ported from AMM's scripts/build/sign-windows.ps1.
#
# Reads AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET +
# AZURE_TS_ACCOUNT / AZURE_TS_PROFILE from the environment.
#
# Usage:
#   pwsh scripts/build/sign-windows.ps1 path/to/aim-setup-vX.Y.Z.exe

param(
  [Parameter(Mandatory=$true)][string]$ExePath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExePath)) {
  Write-Error "File not found: $ExePath"
  exit 1
}

# Skip-and-warn when signing secrets aren't configured. The release workflow
# tolerates this: an unsigned .exe still installs, the failure mode is a
# SmartScreen prompt — more friction, not broken software.
$required = @('AZURE_CLIENT_ID','AZURE_TENANT_ID','AZURE_CLIENT_SECRET','AZURE_TS_ACCOUNT','AZURE_TS_PROFILE')
foreach ($var in $required) {
  if (-not (Test-Path "env:$var")) {
    Write-Host "[skip signing - env:$var not set]" -ForegroundColor Yellow
    Write-Host "[unsigned .exe installs fine but SmartScreen will warn]" -ForegroundColor Yellow
    exit 0
  }
}

# Locate AzureSignTool. Install via: dotnet tool install --global azuresigntool
$signTool = Get-Command 'AzureSignTool.exe' -ErrorAction SilentlyContinue
if (-not $signTool) {
  $signTool = Get-Command 'azuresigntool' -ErrorAction SilentlyContinue
}
if (-not $signTool) {
  Write-Error "AzureSignTool not found on PATH. Install with: dotnet tool install --global azuresigntool"
  exit 1
}

Write-Host "-> Signing $ExePath via Microsoft Trusted Signing..."

& $signTool sign `
  -kvu "https://eus.codesigning.azure.net/" `
  -kvt $env:AZURE_TENANT_ID `
  -kvi $env:AZURE_CLIENT_ID `
  -kvs $env:AZURE_CLIENT_SECRET `
  -kvc $env:AZURE_TS_PROFILE `
  -tr "http://timestamp.acs.microsoft.com" `
  -td sha256 `
  -fd sha256 `
  $ExePath

if ($LASTEXITCODE -ne 0) {
  Write-Error "AzureSignTool failed (exit $LASTEXITCODE)"
  exit $LASTEXITCODE
}

Write-Host "OK signed: $ExePath"

$sig = Get-AuthenticodeSignature $ExePath
if ($sig.Status -eq 'Valid') {
  Write-Host "OK verified: $($sig.SignerCertificate.Subject)"
} else {
  Write-Error "Signature verification failed: $($sig.Status) - $($sig.StatusMessage)"
  exit 1
}
