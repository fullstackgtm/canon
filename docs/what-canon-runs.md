# What Canon runs, stores and connects to

This is the list to check the code against before installing Canon, by hand or
with an agent. It covers the Docker install in [self-hosting.md](self-hosting.md).
The network findings come from reading the code, not from capturing traffic. If
the code does something this page doesn't list, treat that as a finding and
report it.

## What runs

`docker compose up` starts one container from `Dockerfile.selfhost`: built on your
machine with `--build`, or the image published for a signed release, which
`scripts/selfhost/install.sh` pulls. Its entrypoint, `scripts/selfhost/entrypoint.mjs`, runs as user `canon` (uid 1001)
under `tini` and starts four things in order:

| Process | Listens on | What it is |
|---|---|---|
| Convex backend | 127.0.0.1:3210 and 3211, inside the container | The open-source Convex backend, an image pinned by digest. It stores the database in SQLite. |
| Convex CLI, at each start | nothing | Pushes the app's functions from `convex/` to that backend when they changed, then asks it whether the first owner exists, and exits. |
| Record service | 127.0.0.1:8787, inside the container | `services/record-service`, a Node and DuckDB store for records. |
| Next.js | 0.0.0.0:3000, inside the container | The web app. It forwards `/convex` and `/convex-site` to the backend. |

Compose publishes only port 3000, and only on the host's loopback address
(`127.0.0.1:${FRONTEND_PORT}`). Nothing is reachable from other machines until
you add an SSH tunnel or a reverse proxy.

The recipe runtime, which runs modules' server code, is off unless you set
`RECIPE_RUNTIME_URL` and `RECIPE_RUNTIME_SECRET`.

## What it stores

Everything lives in the Compose volume `data`, mounted at `/data`:

| Path | Holds |
|---|---|
| `/data/convex` | The Convex database and file storage |
| `/data/records` | The record service's database |
| `/data/credentials` | Keys the container makes on first start: the backend's instance secret and admin key, the record service token, the key that encrypts stored vendor tokens, the RSA key that signs sign-in sessions, and the setup code |

The first owner registers with the setup code, which the container prints in its
log until an owner exists, or the `CANON_SETUP_CODE` you set. Everyone else joins
by invitation. Passwords are
stored as scrypt hashes. Nothing is written outside the volume except temporary
files inside the container.

## What it connects to

### While installing

`scripts/selfhost/install.sh` clones the release from github.com and pulls its
image from ghcr.io. The image is built by the public repository's `image`
workflow, from the commit the signed release tag names.

### While building the image

| Host | Why |
|---|---|
| ghcr.io | The Convex backend image, pinned by digest |
| public.ecr.aws, Docker Hub | The `node:22-bookworm-slim` and `ubuntu:24.04` base images |
| deb.debian.org, archive.ubuntu.com | System packages |
| registry.npmjs.org | `npm ci` for the app and the record service |

Fonts are bundled, so the build makes no font downloads.

### While running, with no vendor keys set

At startup and on page loads, the container makes no outbound connections. Every
startup request goes to 127.0.0.1. Usage reporting is off: `DISABLE_BEACON`,
`DISABLE_METRICS_ENDPOINT`, `NEXT_TELEMETRY_DISABLED` and `DO_NOT_TRACK` are set.
There is no analytics or crash reporting, and with `CANON_AUTH=local` the Clerk
client is not loaded. Scheduled jobs whose vendor key is missing return without
calling anyone.

These calls only happen because someone using Canon started them or set up
their target:

| Host | When |
|---|---|
| A company's own website, rdap.org, web.archive.org | Reading facts about a company's website |
| Any public URL | A module reads a web page a member asked for |
| Slack or webhook URLs a member entered, and cloudflare-dns.com to look up the webhook's host | Sending notifications or record webhooks |
| api.usaspending.gov and public pages | Running a market investigation that uses those sources |
| api.github.com, raw.githubusercontent.com | Installing a recipe from a public GitHub repository |

The `/start` research screen shows company icons from `www.google.com/s2/favicons`.
Your browser loads them, not the container.

### With vendor keys

Each vendor key you add turns on its integration, and that integration then calls
its vendor. [selfhost-integrations.md](selfhost-integrations.md) lists them, and
`npm run selfhost:doctor` shows which are on. Paid data calls stay off unless their
own switch is on as well.

## What it never does

- It never calls a server run by Canon's publishers. Releases are tags you choose
  to fetch with `npm run selfhost:releases` ([updating.md](updating.md)).
- It never updates itself. An upgrade is a new checkout and a rebuild, which you run.
- It needs no account with any provider, and never reads credentials from the host.
  The container sees only the environment you give it in `.env`.
