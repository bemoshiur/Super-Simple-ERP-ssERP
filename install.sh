#!/usr/bin/env bash
# ssERP installer: checks Node, installs dependencies, then runs the interactive setup.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20 or newer is required but was not found. Install it from https://nodejs.org" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${node_major}" -lt 20 ]; then
  echo "Error: Node.js 20 or newer is required (found $(node -v))." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm was not found on PATH." >&2
  exit 1
fi

echo "Installing dependencies..."
npm ci

echo "Starting setup..."
npm run setup -- "$@"
