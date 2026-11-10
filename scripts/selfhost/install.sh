#!/bin/sh
# Installs Canon on this machine with Docker. Read it before you run it:
#
#   curl -fsSL https://raw.githubusercontent.com/fullstackgtm/canon/main/scripts/selfhost/install.sh -o install.sh
#   sh install.sh                          # http://localhost:3000, bound to this machine only
#   sh install.sh --domain crm.example.com # HTTPS for a domain that points at this server
#
# Options: --dir <path> (default ./canon), --port <n> (default 3000), --domain <host>,
# --release <tag> (default the newest release/<date>), --image <ref>, --repo <git URL>.
#
# What it does, in order. It needs no sudo, and changes nothing outside --dir and Docker:
#  1. Checks Docker with Compose, git and ssh-keygen, and that Docker has 2 GiB of memory.
#  2. Clones the newest signed release tag of the public repository into --dir.
#  3. Checks the tag's signature against the release key in that release, and pins the key
#     in .canon/release-signers, where later updates check against it (docs/updating.md).
#  4. Writes .env: the release's published image, the port and SITE_URL. With --domain, also
#     docker-compose.override.yml, which adds Caddy to obtain and renew the TLS certificate.
#  5. Pulls the image, checks it was built from the release's commit, and starts it.
#  6. Waits until it is healthy, then prints the address and the setup code for the first owner.
set -eu

repo=https://github.com/fullstackgtm/canon.git
registry=ghcr.io/fullstackgtm/canon
dir=canon port=3000 domain='' release='' image=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
  case "$1" in
    --dir) dir=$2 ;; --port) port=$2 ;; --domain) domain=$2 ;;
    --release) release=$2 ;; --image) image=$2 ;; --repo) repo=$2 ;;
    *) echo "Unknown option $1. Read the top of this script for its options." >&2; exit 2 ;;
  esac
  shift 2
done
fail() { echo "Stopped: $*" >&2; exit 1; }
step() { echo "==> $*"; }

step "Checking this machine"
for tool in docker git ssh-keygen; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed. docs/self-hosting.md lists what to install."; done
docker info >/dev/null 2>&1 || fail "Docker is not running, or this user cannot use it. Start Docker, or run as a user in the docker group."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is missing. Install the docker-compose-plugin package, or Docker Desktop."
memory=$(docker info --format '{{.MemTotal}}')
# A machine sold as 2 GB reports a little less. Canon idles at about 1.25 GiB.
[ "$memory" -ge 1800000000 ] || fail "Docker has $((memory / 1048576)) MiB of memory; Canon needs 2 GiB. On Docker Desktop, raise it in Settings > Resources."
case "$port" in *[!0-9]*|'') fail "--port must be a number" ;; esac
[ ! -e "$dir" ] || fail "$dir already exists. To update an install, follow docs/updating.md. To start again, pass another --dir."
if [ -n "$domain" ]; then
  case "$domain" in *[!a-zA-Z0-9.-]*|''|.*|*.) fail "--domain must be a host name, such as crm.example.com" ;; esac
  site="https://$domain"
else site="http://localhost:$port"; fi

if [ -z "$release" ]; then
  step "Finding the newest release of $repo"
  release=$(git ls-remote --tags --refs "$repo" 'refs/tags/release/*' | sed 's|.*refs/tags/||' | LC_ALL=C sort | tail -n 1)
  [ -n "$release" ] || fail "$repo has no release yet. Releases are tags named release/<date>."
fi
case "$release" in release/*) ;; *) fail "--release must be a release/<date> tag" ;; esac

step "Cloning $release into $dir"
git clone --quiet --no-checkout "$repo" "$dir"
cd "$dir"
git fetch --quiet origin "refs/tags/$release:refs/tags/$release"
mkdir -p .canon && chmod 700 .canon
git show "refs/tags/$release:scripts/selfhost/release-signers" > .canon/release-signers
echo "    Release key: $(grep -v '^#' .canon/release-signers | awk 'NF { print $3" "$4 }' | ssh-keygen -lf - | awk '{ print $2 }')"
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$(pwd)/.canon/release-signers" verify-tag "refs/tags/$release" >/dev/null 2>&1 ||
  fail "$release is not signed by the release key in it. Do not use this copy; delete $dir."
git checkout --quiet -B main "refs/tags/$release"
commit=$(git rev-parse HEAD)
image=${image:-$registry:${release#release/}}

step "Writing $dir/.env"
umask 077
printf 'CANON_IMAGE=%s\nFRONTEND_PORT=%s\nSITE_URL=%s\n' "$image" "$port" "$site" > .env
if [ -n "$domain" ]; then
  cat > docker-compose.override.yml <<EOF
# Written by scripts/selfhost/install.sh: Caddy serves https://$domain and renews its certificate.
services:
  caddy:
    image: caddy:2.10@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb
    command: caddy reverse-proxy --from $domain --to canoncrm:3000
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes: [caddy_data:/data, caddy_config:/config]
    depends_on: [canoncrm]
    restart: unless-stopped
volumes:
  caddy_data:
  caddy_config:
EOF
fi

step "Pulling $image"
docker compose pull --quiet
built=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[ "$built" = "$commit" ] || fail "$image was built from ${built:-an unknown commit}, not $release ($commit)."

step "Starting Canon. The first start takes a minute or two."
started=$(date +%s)
docker compose up -d --no-build --quiet-pull
container=$(docker compose ps -q canoncrm)
while :; do
  state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
  case "$state" in
    "running healthy") break ;;
    running*) ;;
    *) docker compose logs --tail 40 canoncrm >&2; fail "Canon stopped ($state). Its last log lines are above." ;;
  esac
  [ $(($(date +%s) - started)) -lt 600 ] || { docker compose logs --tail 40 canoncrm >&2; fail "Canon was not healthy after ten minutes."; }
  sleep 2
done
code=$(docker compose exec -T canoncrm node scripts/selfhost/setup-code.mjs)
node_ok=no
if command -v node >/dev/null 2>&1 && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)'; then node_ok=yes; fi

cat <<EOF

Canon $release is running at $site (healthy after $(($(date +%s) - started)) s).

Create the owner: open $site/sign-in and enter this setup code:

    $code

The first person to enter it owns this install. It stops working once the owner exists.
EOF
[ -n "$domain" ] || cat <<EOF
Canon listens on 127.0.0.1 only. From another computer, keep a tunnel open:
    ssh -N -L $port:127.0.0.1:$port <this server>
EOF
cat <<EOF

Back up once the owner exists, and before every update (docs/updating.md):
    cd $(pwd) && node scripts/selfhost/backup.mjs
EOF
[ "$node_ok" = yes ] || echo "    The backup, update and verify commands need Node.js 22.6 or newer, which this machine lacks."
