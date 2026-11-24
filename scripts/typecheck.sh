#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "${1:-}" = "--pi-runtime" ]; then
  ./node_modules/.bin/tsgo --noEmit -p services/pi-runtime/tsconfig.json
  exit
fi
./node_modules/.bin/next typegen
./node_modules/.bin/tsgo --noEmit -p tsconfig.json
# convex/tsconfig.json has no incremental build info of its own; keep one under node_modules so a rerun with no
# convex change takes ~0.5 s instead of ~11 s. It is a cache: deleting it only makes the next run full.
mkdir -p node_modules/.cache/canoncrm-typecheck
./node_modules/.bin/tsgo --noEmit -p convex/tsconfig.json --incremental \
  --tsBuildInfoFile node_modules/.cache/canoncrm-typecheck/convex.tsbuildinfo
