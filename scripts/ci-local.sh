#!/usr/bin/env bash
# scripts/ci-local.sh: optional local validation under the resource runner.
#
#   npm run check                 full main validation from checks.yml
#   npm run check -- --pr          PR static, selected tests and changed service suites
#   npm run check -- --full       ...plus `next build` (main CI builds the app image after validation)
#   npm run check -- --serial     run the steps one at a time (less CPU contention, slower)
#
# Local differences, on purpose:
# - TMPDIR is resolved with `pwd -P`: on macOS it sits under the /var -> /private/var symlink and
#   engine/src/secureFile.ts rejects symlinked path components (115-122 tests fail otherwise).
# - eslint and the convex tsc pass use caches under .devstack/ci/ (gitignored). Results are identical.
# - No step talks to a cloud Convex deployment: CONVEX_DEPLOYMENT / deploy keys are unset.
# Logs: .devstack/ci/<step>.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
PR=0; FULL=0; SERIAL=${CANONCRM_CHECK_SERIAL:-0}; IN_FLIGHT=0; MAX_PARALLEL_STEPS=2
for a in "$@"; do
  case "$a" in
    --full) FULL=1 ;;
    --pr) PR=1 ;;
    --serial) SERIAL=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "ci-local: unknown argument: $a" >&2; exit 2 ;;
  esac
done

TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"; export TMPDIR
unset CONVEX_DEPLOYMENT CONVEX_DEPLOY_KEY CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY
export CI=true NEXT_TELEMETRY_DISABLED=1
OUT="$ROOT/.devstack/ci"
mkdir -p "$OUT"; rm -f "$OUT"/*.rc "$OUT"/*.ms
PR_RECORD=true; PR_PROSPECT=true; PR_SF=true
if [ "$PR" = 1 ]; then
  if ! node scripts/dev/pr-tests.mjs plan > "$OUT/pr-plan.json"; then exit 1; fi
  PR_SERVICES="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(p.recordService,p.prospectIndex,p.sfSim)' "$OUT/pr-plan.json")" || exit 1
  read -r PR_RECORD PR_PROSPECT PR_SF <<< "$PR_SERVICES" || exit 1
fi
now_ms() { /usr/bin/perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
T0=$(now_ms)

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" = 22 ] || echo "ci-local: note: CI runs Node 22, this is Node $(node -v)" >&2

# Install dependencies for the local validation commands. worktree-setup reuses a lockfile-keyed clone cache
# and is a no-op when node_modules already matches each lockfile.
t=$(now_ms)
if bash scripts/dev/worktree-setup.sh --deps-only > "$OUT/install.log" 2>&1; then echo 0 > "$OUT/install.rc"; else echo 1 > "$OUT/install.rc"; fi
echo $(( $(now_ms) - t )) > "$OUT/install.ms"
if [ "$(cat "$OUT/install.rc")" != 0 ]; then tail -20 "$OUT/install.log" >&2; echo "ci-local: FAIL (install)"; exit 1; fi

STEPS=()
step() { # <name> <command...>: runs in the background (or inline with --serial), records rc + ms
  local name="$1"; shift
  STEPS+=("$name")
  if [ "$SERIAL" = 1 ]; then
    run_step "$name" "$@"
  else
    run_step "$name" "$@" &
    IN_FLIGHT=$(( IN_FLIGHT + 1 ))
    if [ "$IN_FLIGHT" -ge "$MAX_PARALLEL_STEPS" ]; then wait; IN_FLIGHT=0; fi
  fi
}
run_step() {
  local name="$1" t rc; shift
  t=$(now_ms)
  ( "$@" ) > "$OUT/$name.log" 2>&1; rc=$?
  echo "$rc" > "$OUT/$name.rc"; echo $(( $(now_ms) - t )) > "$OUT/$name.ms"
}

agent_cli_contracts() {
  # checks.yml's agent CLI contract steps, against an empty HOME / FSGTM_HOME like a fresh CI runner.
  local h; h="$(mktemp -d "$TMPDIR/ci-local-home.XXXXXX")"
  export HOME="$h" FSGTM_HOME="$h/.fullstackgtm" NODE_OPTIONS=--disable-warning=ExperimentalWarning
  unset FSGTM_AUTH_TOKEN NEXT_PUBLIC_CONVEX_URL
  local f rc=0
  for f in scripts/fsgtm.ts scripts/fullstackgtm.ts scripts/fsgtm-mcp.ts scripts/fullstackgtm-mcp.ts; do
    node --experimental-strip-types --check "$f" || rc=1
  done
  json_clean() {
    local o e; o="$(mktemp "$TMPDIR/ci-o.XXXXXX")"; e="$(mktemp "$TMPDIR/ci-e.XXXXXX")"
    "$@" > "$o" 2> "$e"
    if [ -s "$e" ] || ! node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(j.ok===true||j.ready===true?0:1)' "$o"; then
      echo "contract failed: $*"; head -c 2000 "$e"; rc=1
    fi
    rm -f "$o" "$e"
  }
  json_clean npm run -s gtm -- capabilities --json
  json_clean npm run -s gtm -- surface --json
  json_clean npm run -s gtm -- auth status --json
  json_clean npm run -s gtm -- patch-plans --help --json
  json_clean npm run -s gtm -- mutation --name api.patchPlans.approve --args '{"patchPlanId":"x","decision":"approved"}' --json
  json_clean npm run -s gtm -- interaction-audit --json
  json_clean npm run -s fullstackgtm -- capabilities --json
  json_clean npm run -s fullstackgtm -- audit --help --json
  no_ansi() {
    local o; o="$(mktemp "$TMPDIR/ci-a.XXXXXX")"
    env -u CI -u NO_COLOR -u FORCE_COLOR "$@" > "$o" 2>&1
    if grep -q $'\x1b' "$o"; then echo "ANSI escape in piped output of: $*"; rc=1; fi
    rm -f "$o"
  }
  no_ansi npm run -s fullstackgtm -- --help
  no_ansi npm run -s fullstackgtm -- doctor
  no_ansi npm run -s fullstackgtm -- health
  no_ansi npm run -s fullstackgtm -- audit --demo
  no_ansi npm run -s fullstackgtm -- audit --demo --full
  no_ansi npm run -s fullstackgtm -- audit --demo --json
  no_ansi npm run -s fullstackgtm -- plans list
  no_ansi npm run -s fullstackgtm -- rules
  rm -rf "$h"
  return $rc
}
step lint            npx eslint --cache --cache-strategy content --cache-location "$OUT/eslint-cache"
step tsc-app         bash -c 'npx next typegen > /dev/null && npx tsgo --noEmit -p tsconfig.json'
step tsc-convex      npx tsgo --noEmit -p convex/tsconfig.json --incremental --tsBuildInfoFile "$OUT/convex.tsbuildinfo"
if [ "$PR" = 1 ]; then
  step test node scripts/dev/pr-tests.mjs test
else
  step test npm test
fi
if [ "$PR_PROSPECT" = true ]; then step prospect-index bash -c 'cd services/prospect-index && npm test'; fi
if [ "$PR_SF" = true ]; then step sf-sim bash -c 'cd packages/sf-sim && npm test'; fi
step agent-cli       agent_cli_contracts
wait
if [ "$PR_RECORD" = true ]; then step record-service bash -c 'cd services/record-service && npm test'; fi
wait

if [ "$FULL" = 1 ]; then
  # next build writes .next/ (next dev uses .next/dev, so a running isolated stack keeps serving).
  step next-build npx next build
  wait
fi

fail=0
printf '\n%-16s %-6s %8s\n' step result time
for name in install "${STEPS[@]}"; do
  rc="$(cat "$OUT/$name.rc" 2>/dev/null || echo 99)"; ms="$(cat "$OUT/$name.ms" 2>/dev/null || echo 0)"
  if [ "$rc" = 0 ]; then res=PASS; else res=FAIL; fail=1; fi
  printf '%-16s %-6s %7d.%01ds\n' "$name" "$res" $((ms / 1000)) $(( (ms % 1000) / 100 ))
done
total=$(( $(now_ms) - T0 ))
for name in "${STEPS[@]}"; do
  if [ "$(cat "$OUT/$name.rc" 2>/dev/null || echo 99)" != 0 ]; then
    printf '\n--- %s (last 25 lines of %s) ---\n' "$name" "${OUT#"$ROOT"/}/$name.log"; tail -25 "$OUT/$name.log"
    if grep -q "Unable to deserialize cloned data" "$OUT/$name.log"; then
      printf '\nNOTE: %s hit "Unable to deserialize cloned data", a Node test-runner IPC failure (the runner, not\n' "$name"
      printf 'a test body; seen under heavy CPU load). Check the "not ok" entries above; if that is the only one, re-run.\n'
    fi
  fi
done
printf '\nci-local: %s in %d.%01ds wall (%s mode%s). Logs: %s/\n' "$([ $fail = 0 ] && echo PASS || echo FAIL)" \
  $((total / 1000)) $(( (total % 1000) / 100 )) "$([ $SERIAL = 1 ] && echo serial || echo parallel)" "$([ $FULL = 1 ] && echo ', --full' || echo '')" "${OUT#"$ROOT"/}"
exit $fail
