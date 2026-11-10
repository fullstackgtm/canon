#!/usr/bin/env bash
# Shows what merging a release into this checkout would do, without checking out
# or running anything from it. See docs/bringing-in-updates.md.
#
#   scripts/selfhost/merge-preview.sh <release-commit> [<into, default HEAD>]
#
# The merge is worked out in a throwaway repository with no git config, so no
# merge driver, diff or textconv program named by this repository or machine can
# run on the release's files. Exits 0 for a clean merge, 1 for clashes.
set -euo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo "Usage: $0 <release-commit> [<into>]" >&2; exit 2; }
release=$(git rev-parse --verify "$1^{commit}")
into=$(git rev-parse --verify "${2:-HEAD}^{commit}")
objects=$(cd "$(git rev-parse --git-path objects)" && pwd -P)
base=$(git merge-base "$into" "$release") || { echo "No shared history with this release." >&2; exit 2; }

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
clean() { env -i PATH="$PATH" HOME="$scratch" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_DIR="$scratch/r" git "$@"; }
clean init -q --bare "$scratch/r"
echo "$objects" > "$scratch/r/objects/info/alternates"

status=0
output=$(clean merge-tree --write-tree --name-only --messages "$into" "$release") || status=$?
[[ $status -le 1 ]] || { echo "git could not work out the merge." >&2; exit 2; }
echo "Release: $release"
echo "Into:    $into"
if [[ $status -eq 0 ]]; then echo "Result:  merges cleanly"; else echo "Result:  CLASHES"; fi
echo
echo "$output" | tail -n +2
echo
echo "What the release changes:"
clean diff --no-ext-diff --no-textconv --stat "$base" "$release"
echo
echo "Data contract:"
clean show "$release:scripts/selfhost/data-contract.json" 2>/dev/null || echo "(none in this release)"
exit "$status"
