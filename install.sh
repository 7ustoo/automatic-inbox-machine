#!/usr/bin/env bash
# Automatic Inbox Machine — macOS / Linux installer
#
#   curl -fsSL https://raw.githubusercontent.com/7ustoo/automatic-inbox-machine/main/install.sh | bash
#
# Clones into ~/automatic-inbox-machine, installs dependencies, and hands off to
# the setup wizard. Installs nothing globally and touches no system settings.

set -euo pipefail

REPO="https://github.com/7ustoo/automatic-inbox-machine.git"
TARGET="${AIM_DIR:-$HOME/automatic-inbox-machine}"
MIN_NODE=20

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
cyan()  { printf '\033[36m%s\033[0m\n' "$1"; }

fail() { echo; red "  $1"; echo; exit 1; }

echo
cyan '  Automatic Inbox Machine'
echo  '  ======================='
echo

# --- prerequisites ----------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Get it from https://nodejs.org (version $MIN_NODE or newer), then re-run this."

NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  fail "Node $NODE_VERSION is too old. This needs $MIN_NODE or newer."
fi
green "  Node $NODE_VERSION"

command -v git >/dev/null 2>&1 || fail 'git is not installed.'
green '  git found'

# --- clone or update --------------------------------------------------------

if [ -d "$TARGET/.git" ]; then
  echo "  Existing install at $TARGET — updating."
  git -C "$TARGET" fetch --quiet origin main
  git -C "$TARGET" checkout --quiet main
  git -C "$TARGET" pull --quiet --ff-only origin main \
    || fail 'Update failed. You may have local changes on main; resolve them and re-run.'
elif [ -e "$TARGET" ]; then
  fail "$TARGET exists but is not a git checkout. Move it aside and re-run."
else
  echo "  Cloning into $TARGET"
  git clone --quiet --depth 1 "$REPO" "$TARGET" || fail 'Clone failed.'
fi

# --- dependencies -----------------------------------------------------------

cd "$TARGET"

echo '  Installing dependencies (about 30 seconds)…'
npm install --no-audit --no-fund --loglevel=error || fail 'npm install failed. Scroll up for the reason.'

echo '  Running self-check…'
node scripts/check-syntax.mjs || fail 'Self-check failed — this build is broken, please open an issue.'

echo
green '  Installed.'
echo
echo '  Next: the setup wizard walks through your inboxes, reply profile, and'
echo '  how much autonomy the agent gets. It never asks you to type a secret.'
echo
cyan "    cd $TARGET"
cyan '    npm run setup'
echo
echo '  Then `npm run once` for a read-only pass before you turn anything on.'
echo
