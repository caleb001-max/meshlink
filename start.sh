#!/usr/bin/env bash
# One-command startup for MeshLink: install if needed, preflight, then Metro.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)…"
  npm install
fi

node scripts/preflight.mjs
exec npx expo start "$@"
