#!/usr/bin/env bash
# Tabula local dogfood (Unix). Requires Docker, Node 22+, pnpm 9.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "[dogfood] delegating to scripts/dogfood.mjs …"
exec node scripts/dogfood.mjs
