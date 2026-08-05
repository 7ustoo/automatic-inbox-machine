# Automatic Inbox Machine — Windows installer
#
#   irm https://raw.githubusercontent.com/7ustoo/automatic-inbox-machine/main/install.ps1 | iex
#
# Clones into %USERPROFILE%\automatic-inbox-machine, installs dependencies, and
# hands off to the setup wizard. Installs nothing globally and touches no
# system settings.

$ErrorActionPreference = 'Stop'

$Repo    = 'https://github.com/7ustoo/automatic-inbox-machine.git'
$Target  = Join-Path $env:USERPROFILE 'automatic-inbox-machine'
$MinNode = 20

function Fail($message) {
  Write-Host ''
  Write-Host "  $message" -ForegroundColor Red
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host '  Automatic Inbox Machine' -ForegroundColor Cyan
Write-Host '  ======================='
Write-Host ''

# --- prerequisites ----------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js is not installed. Get it from https://nodejs.org (version $MinNode or newer), then re-run this."
}

$version = (& node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt $MinNode) {
  Fail "Node $version is too old. This needs $MinNode or newer."
}
Write-Host "  Node $version" -ForegroundColor Green

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'git is not installed. Get it from https://git-scm.com, then re-run this.'
}
Write-Host '  git found' -ForegroundColor Green

# --- clone or update --------------------------------------------------------

if (Test-Path (Join-Path $Target '.git')) {
  Write-Host "  Existing install at $Target — updating." -ForegroundColor Yellow
  Push-Location $Target
  try {
    & git fetch --quiet origin main
    & git checkout --quiet main
    & git pull --quiet --ff-only origin main
    if ($LASTEXITCODE -ne 0) { Fail 'Update failed. You may have local changes on main; resolve them and re-run.' }
  } finally { Pop-Location }
} elseif (Test-Path $Target) {
  Fail "$Target exists but is not a git checkout. Move it aside and re-run."
} else {
  Write-Host "  Cloning into $Target"
  & git clone --quiet --depth 1 $Repo $Target
  if ($LASTEXITCODE -ne 0) { Fail 'Clone failed.' }
}

# --- dependencies -----------------------------------------------------------

Push-Location $Target
try {
  Write-Host '  Installing dependencies (about 30 seconds)…'
  & npm install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Scroll up for the reason.' }

  Write-Host '  Running self-check…'
  & node scripts/check-syntax.mjs
  if ($LASTEXITCODE -ne 0) { Fail 'Self-check failed — this build is broken, please open an issue.' }

  Write-Host ''
  Write-Host '  Installed.' -ForegroundColor Green
  Write-Host ''
  Write-Host '  Next: the setup wizard walks through your inboxes, reply profile, and'
  Write-Host '  how much autonomy the agent gets. It never asks you to type a secret.'
  Write-Host ''
  Write-Host "    cd $Target" -ForegroundColor Cyan
  Write-Host '    npm run setup' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  Then `npm run once` for a read-only pass before you turn anything on.'
  Write-Host ''
} finally { Pop-Location }
