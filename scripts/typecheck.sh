#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "${1:-}" = "--pi-runtime" ]; then
  ./node_modules/.bin/tsgo --noEmit -p services/pi-runtime/tsconfig.json
  exit
fi
./node_modules/.bin/next typegen
./node_modules/.bin/tsgo --noEmit -p tsconfig.json
./node_modules/.bin/tsgo --noEmit -p convex/tsconfig.json
