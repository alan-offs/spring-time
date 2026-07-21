#!/usr/bin/env bash
# worktime installer — run once after cloning. Puts `wt` on your PATH and sets up
# macOS autostart. Idempotent: safe to re-run. Node >= 22.5 is the only prereq.
set -euo pipefail

# --- Bootstrap for `curl … | bash` -------------------------------------------
# Run from a checkout we install in place; piped from curl (no script file on
# disk) we clone first, then re-exec from the clone. Override with WT_REPO/WT_DEST.
if [ -z "${BASH_SOURCE:-}" ] || [ ! -f "${BASH_SOURCE[0]:-/nonexistent}" ]; then
  REPO_URL="${WT_REPO:-https://github.com/alan-offs/spring-time.git}"
  DEST="${WT_DEST:-$HOME/spring-time}"
  if [ -d "$DEST/.git" ]; then
    echo "→ updating existing checkout at $DEST"
    git -C "$DEST" pull --ff-only
  else
    echo "→ cloning $REPO_URL into $DEST"
    git clone "$REPO_URL" "$DEST"
  fi
  exec bash "$DEST/install.sh"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# --- Node version check (mirror package.json "engines") -----------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node is not installed. Install Node >= 22.5 (https://nodejs.org) and re-run."
  exit 1
fi
NODE_VER="$(node -p 'process.versions.node')"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  echo "✗ Node $NODE_VER is too old — worktime needs >= 22.5 (for node:sqlite)."
  exit 1
fi
echo "✓ Node $NODE_VER"

# --- Put `wt` on PATH ---------------------------------------------------------
# Prefer `npm link` (a real `wt` binary); fall back to a shell alias if linking
# needs perms we don't have.
if npm link >/dev/null 2>&1; then
  echo "✓ linked \`wt\` globally (npm link)"
else
  RC="${ZDOTDIR:-$HOME}/.zshrc"
  ALIAS="alias wt=\"node $ROOT/bin/wt.js\""
  if ! grep -qF "$ALIAS" "$RC" 2>/dev/null; then
    echo "$ALIAS" >> "$RC"
    echo "✓ added a \`wt\` alias to $RC"
  else
    echo "✓ \`wt\` alias already in $RC"
  fi
  echo "  → run 'source $RC' (or open a new terminal) to pick it up"
fi

# --- Autostart + config (reuses the CLI's own installer) ----------------------
node bin/wt.js install

cat <<'EOF'

Done. Next:

  wt start      # boot the server and open the dashboard — type a project, Enter
  wt status     # what am I tracking
  wt today      # today's breakdown

Dashboard:  http://127.0.0.1:4321

Optional (macOS, needs Xcode command line tools):
  ./scripts/build-menubar.sh    # a menu-bar timer companion
EOF
