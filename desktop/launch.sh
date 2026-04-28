#!/usr/bin/env bash
# VibeVoice Desktop — macOS/Linux launcher
# Usage: bash launch.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- conda activation (optional) ----
if command -v conda &>/dev/null; then
  source "$(conda info --base)/etc/profile.d/conda.sh"
  conda activate tushanproject 2>/dev/null || true
fi

# ---- install Python server deps if needed ----
pip show fastapi &>/dev/null || pip install -r "$SCRIPT_DIR/server/requirements.txt"

# ---- install Node.js deps if needed ----
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing Node.js dependencies..."
  cd "$SCRIPT_DIR"
  npm install
fi

# ---- launch Electron ----
cd "$SCRIPT_DIR"
npx electron .
