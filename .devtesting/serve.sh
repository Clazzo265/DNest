#!/usr/bin/env bash
# Local harness: backend on 8787 + Vite dev server proxying /api to it.
set -euo pipefail
cd "$(dirname "$0")/.."
node .devtesting/link.mjs
rm -rf .devtesting/data
HARNESS_DATA_DIR="$PWD/.devtesting/data" PORT=8787 npx tsx .devtesting/server.ts &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
DATANEST_DEV_HARNESS=1 DATANEST_API=http://127.0.0.1:8787 npx vite --port 5173 --host 0.0.0.0
