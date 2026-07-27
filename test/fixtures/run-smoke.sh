#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

node test/fixtures/serve.js 8973 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

sleep 1
node src/cli.js run --urls http://127.0.0.1:8973/ --name "Smoke Test" --out output/smoke
