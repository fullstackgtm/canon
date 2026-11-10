# Deploy Canon

Canon runs as one Docker container: the app, the open-source Convex backend and
the record service, with all of its data in one volume. It needs 2 GiB of
memory (it idles at about 1.2 GiB) and no account with any service. Sign-in is
local. The first owner creates their account with a setup code that only the
person running the install can read, so whoever reaches a new install's address
first can't claim it. Everyone else joins by invitation.

## Choose a path

| Path | What you need | Cost | Time to first sign-in | Updates | Backups |
|---|---|---|---|---|---|
| [One command](#one-command-on-a-machine-you-have) (recommended) | A server or laptop with Docker | Your server | 72 s measured, plus downloading the 505 MB image | Signed releases, [updating.md](updating.md) | `selfhost:backup` |
| [Render](#render) | A Render account | About $27.50 a month (2 GB instance and a 10 GB disk) | Not measured | Deploy the new release's image | Render's daily disk snapshots |
| [Railway](#railway) | A Railway account | About $15 a month: memory is $10 per GB a month, on the $5 Hobby plan | Not measured | Redeploy with the new image | Railway's volume backups |
| [Build from source](#build-from-source) | Docker and git, with more memory and disk for the build than Canon needs to run | Your server | Build time plus about 70 s | Signed releases, rebuilt | `selfhost:backup` |

The 72 s was measured on an arm64 Mac with the image already pulled. Render and
Railway are unproven: nobody has deployed Canon there yet. Their prices come
from each platform's price list in November 2026.

Canon sends no telemetry. The container makes no outbound connection when it
starts, and it boots with networking turned off entirely.
[what-canon-runs.md](what-canon-runs.md) lists everything it runs and connects
to, and every integration stays off until you add its key
([selfhost-integrations.md](selfhost-integrations.md)).

## One command on a machine you have

This works on a Linux server, and on macOS or Windows with Docker Desktop. It
needs Docker with Compose, git, and 2 GiB of memory for Docker. To back up and
update it later, the machine also needs Node.js 22.6 or newer. On a Debian or
Ubuntu server, [Prepare the machine](#prepare-the-machine) installs these.

Download the installer, read it, then run it:

```sh
curl -fsSL https://raw.githubusercontent.com/fullstackgtm/canon/main/scripts/selfhost/install.sh -o install.sh
less install.sh
sh install.sh
```

It needs no sudo and changes nothing outside the new `canon` directory and
Docker. In order, it:

1. Checks Docker, git and memory.
2. Clones the newest signed release into `./canon`.
3. Checks the release tag's signature against the release key in that release,
   prints the key's fingerprint, and pins the key for later updates. The
   publisher's key is `SHA256:jksZ1PCL0395Bh9gVOxQH0wEUNMwqHNSsDJFO9PbKFo`.
4. Writes `.env` with the release's image, `ghcr.io/fullstackgtm/canon:<date>`.
5. Pulls the image, and stops if it wasn't built from the release's commit.
6. Starts Canon, waits until it is healthy, and prints the address and the
   setup code.

Open the address it prints, followed by `/sign-in`, enter the setup code, and
create the owner. Then take a first backup with the command it prints.

Options: `--dir <path>`, `--port <n>` (default 3000), `--release <tag>`, and
`--domain <host>`. Canon listens on `127.0.0.1` only. On a server without a
domain, reach it through an SSH tunnel, as in
[Use a remote server privately through SSH](#use-a-remote-server-privately-through-ssh).

With a domain whose DNS points at the server, and ports 80 and 443 open,
`sh install.sh --domain crm.example.com` also starts Caddy. Caddy obtains and
renews the TLS certificate, and Canon is at `https://crm.example.com`. The
setup code still protects the install before you claim it.

To check the image's build provenance as well, use the GitHub CLI:
`gh attestation verify oci://ghcr.io/fullstackgtm/canon:<date> --repo fullstackgtm/canon`.

The directory the installer makes is an ordinary checkout of the release. Every
command in the rest of this guide works in it.

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/fullstackgtm/canon)

The button reads `render.yaml` at the repository root. It creates one web
service from `ghcr.io/fullstackgtm/canon:latest` on the 2 GB instance type,
with a 10 GB disk at `/data` and a generated `CANON_SETUP_CODE`. Render's
smaller instance types can't run Canon. A service with a disk runs one instance,
so each deploy has downtime while the new version starts.

1. Click the button, sign in to Render, and apply the Blueprint.
2. Wait until the service is live. The first start pulls the image and sets up
   the backend.
3. Open the service's Environment page and copy `CANON_SETUP_CODE`.
4. Open the service's `onrender.com` address, followed by `/sign-in`, enter
   the code, and create the owner.

Canon takes its address from `RENDER_EXTERNAL_URL`. For a custom domain, add it
in Render, then set `SITE_URL` to `https://<your domain>`.

To update, read the release notes ([updating.md](updating.md)), make sure a
recent disk snapshot exists, then use Manual Deploy. Render pulls the image
again. Render snapshots the disk once a day and keeps each snapshot for seven
days. To restore, open the service's Disk page and pick a snapshot. To keep a
copy outside Render, use [Export a workspace](workspace-export.md).

## Railway

Railway has no file in this repository to deploy from: its config files stop
being read on 2026-12-01, and a template lives in a Railway account. Until a
published template exists, set the service up by hand:

1. Create a project, then a service from the Docker image
   `ghcr.io/fullstackgtm/canon:latest`.
2. Attach a volume with the mount path `/data`.
3. Under Networking, generate a domain with target port 3000.
4. Under Variables, add `PORT` with the value `3000`, and `CANON_SETUP_CODE`
   with a long random value, such as the output of `openssl rand -hex 16`.
5. Under Settings, set the health check path to `/api/public/version`, keep one
   replica, and allow at least 2 GB of memory.
6. Deploy. Then open the generated domain, followed by `/sign-in`, enter the
   code, and create the owner.

Canon takes its address from `RAILWAY_PUBLIC_DOMAIN`. For a custom domain, set
`SITE_URL` to `https://<your domain>`. To update, take a volume backup in the
service's Backups tab, then redeploy. Railway can also back the volume up on a
daily, weekly or monthly schedule, and a restore redeploys the service on a new
volume.

## Other platforms

- **Fly.io** fits Canon (a 2 GB machine with a volume costs about $13 a month),
  but it has no deploy button: it needs the `flyctl` CLI and an account. It isn't
  supported yet.
- **DigitalOcean App Platform** has no persistent volumes, so Canon's data would
  be lost on every deploy. Use a DigitalOcean Droplet with the one-command path.
- **Coolify** and similar self-hosted platforms deploy a Compose file. Point one
  at this repository's `docker-compose.yml` and set `CANON_IMAGE` to the
  release's image, `SITE_URL` to the public address, and `CANON_SETUP_CODE`. This
  is untested.

## Build from source

Build the image yourself to run your own changes, or on a machine that can't
pull from ghcr.io. The build needs more memory and disk than running does.
Run the commands from the repository root. Leave `FSGTM_ENABLE_DEMO_DATA` unset.

### Prepare the machine

For this machine, check `docker info` and `docker compose version`. If Docker
is missing, install Docker Engine with the Compose plugin on Linux, or Docker
Desktop on macOS or Windows. Docker Desktop can run without signing in.
Start Docker before continuing.

For a server, connect first:

```sh
ssh <host>
docker info
docker compose version
```

If Docker is missing on a Debian or Ubuntu server, install the distribution's
packages. These commands need sudo access:

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo docker info
sudo docker compose version
```

If your distribution does not provide `docker-compose-v2`, install Docker Engine
and its Compose plugin using Docker's instructions for that distribution.
Use `sudo docker` for the following Docker commands if your SSH user cannot
access the Docker socket. On an existing host, preserve its other containers.

Clone the public source URL you received with this distribution. HTTPS cloning
of a public repository needs no GitHub account. If the source is already on the
machine, use that checkout instead:

```sh
git clone <public-repository-url> canon
cd canon
```

### Start Canon with Docker Compose

Choose a free host port. Compose binds it to loopback, so no public firewall
opening is needed. Create `.env` in this checkout:

```dotenv
FRONTEND_PORT=3000
SITE_URL=http://localhost:3000
```

Keep the port in `SITE_URL` equal to `FRONTEND_PORT` for local or tunneled use.
Then build and start:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 canoncrm
```

Wait until `canoncrm` reports `healthy`. The first build and backend
initialization can take several minutes. Check logs if it exits or becomes
unhealthy. The image's health check covers the app, backend, and record service.
The same origin serves the app, Convex at `/convex`, and HTTP actions at
`/convex-site`.

Read the setup code with `docker compose exec canoncrm node scripts/selfhost/setup-code.mjs`,
or find it in `docker compose logs canoncrm`. Then open
`http://localhost:3000/sign-in`, enter it and create the owner, or let the
verification command below create the owner. The code stops working once the
owner exists. To choose the code yourself, set `CANON_SETUP_CODE` in `.env`
before the first start.
Choose a password with at least 12 characters. No email provider is required.

The record API (`/api/v1`) and the MCP tools limit each token to 600 reads and
300 writes a minute, and each workspace to 1,200 and 600. To change a limit, add
`CANON_API_TOKEN_READS_PER_MINUTE`, `CANON_API_TOKEN_WRITES_PER_MINUTE`,
`CANON_API_WORKSPACE_READS_PER_MINUTE` or `CANON_API_WORKSPACE_WRITES_PER_MINUTE`
to `.env` and run `docker compose up -d`. `0` turns a limit off.
[Rate limits](record-api.md#rate-limits) explains the defaults.

Optional integrations need their own keys, listed in
[Optional integrations](selfhost-integrations.md). To log members' email by BCC
or forward, follow [Logging email by BCC or forward](email-logging.md).

### Use a remote server privately through SSH

Without a domain, leave `SITE_URL=http://localhost:3000` on the server. From
your own machine, keep this tunnel open:

```sh
ssh -N -L 3000:127.0.0.1:3000 <host>
```

Open `http://localhost:3000/sign-in`. Run verification against
`http://localhost:3000` through the same tunnel. If port 3000 is occupied on
your machine, use another free port at both ends, update the server's `.env`,
and run `docker compose up -d` again. For example, use 4317 in both `.env`
values and `ssh -N -L 4317:127.0.0.1:4317 <host>`.

### Add HTTPS when a domain points at the server

Use this path only when you already control a domain. Point its DNS A record,
and AAAA record if used, at this host. Allow inbound TCP ports 80 and 443.
Keep Canon's port bound to `127.0.0.1`. First create the owner through the SSH
tunnel, then change `.env` on the server:

```dotenv
FRONTEND_PORT=3000
SITE_URL=https://crm.example.com
```

Run `docker compose up -d` to apply the origin change. Install Caddy on the
host using your distribution's package manager. For Debian or Ubuntu with the
Caddy package available:

```sh
sudo apt-get install -y caddy
```

Add this site to `/etc/caddy/Caddyfile`. Preserve any existing sites:

```caddyfile
crm.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Validate and reload:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews a TLS certificate automatically when DNS and network
access are ready. It forwards WebSocket upgrades as well as HTTP. No Caddy
account or certificate credential is required. Use `https://crm.example.com`
for access and verification after the change. If HTTPS fails, inspect
`sudo journalctl -u caddy --no-pager -n 100` and check DNS and ports 80 and 443.

## Verify any installation

Use Node.js 22.6 or newer on the machine running this command. The verifier
uses built-in Node APIs and needs no `npm ci`. The URL can be local, an SSH
tunnel, or a remote HTTPS origin. It creates a labeled verification company,
person, note, and deal and leaves them in the owner's workspace for inspection.
It prints a PASS or FAIL line for each check and exits nonzero on failure.

Store the local owner's email and password in a private file outside the
checkout. Never put passwords in command arguments, logs, or commits:

```sh
umask 077
$EDITOR ../canon-owner.env
```

The file has these names. Supply your own values without the angle brackets:

```dotenv
SELFHOST_SMOKE_EMAIL=<owner-email>
SELFHOST_SMOKE_PASSWORD=<owner-password-at-least-12-characters>
SELFHOST_SETUP_CODE=<setup-code-from-the-log>
```

For a fresh installation, this one command proves first owner creation as
well as sign-in. It also checks that a wrong setup code and a second owner are
refused:

```sh
node --env-file=../canon-owner.env scripts/selfhost/verify.mjs http://localhost:3000 --bootstrap-owner
```

For a throwaway test install, skip the file. With `--bootstrap-owner` and no
credentials set, the command creates a throwaway owner with a random password it
never saves, and reads the setup code from the container. Do not use this on an
install a client will keep, because that owner then owns the installation:

```sh
node scripts/selfhost/verify.mjs http://localhost:3000 --bootstrap-owner --restart-container "$(docker compose ps -q canoncrm)"
```

On later runs, omit `--bootstrap-owner`. That flag requires registration to
succeed and fails if the installation already has an owner. The command checks
the app and backend, `/sign-in`, local owner authentication, company, person,
and deal creation and read-back, the note on the company's timeline, the
dashboard, WebSocket upgrades, and sign-out.
Replace the URL with `https://crm.example.com` for a public install.

To also prove persistence across a container restart, run from the Compose
checkout on its host:

```sh
node --env-file=../canon-owner.env scripts/selfhost/verify.mjs http://localhost:3000 --restart-container "$(docker compose ps -q canoncrm)"
```

Add `--bootstrap-owner` only for a fresh installation. The restart pauses service,
waits up to ten minutes for Docker health, and reads the same owner, company,
person, and deal using the existing session. It never removes a container or
volume. The container's `SITE_URL` must match the verified URL.

To restart a remote container while verifying from your own machine, obtain its
ID with `ssh <host> 'cd canon && docker compose ps -q canoncrm'`, then run:

```sh
node --env-file=../canon-owner.env scripts/selfhost/verify.mjs https://crm.example.com --restart-container <container-id> --ssh <host>
```

The SSH user must already have Docker access without an interactive sudo prompt.
Use an SSH config alias for custom ports or keys. For a private server, keep the
tunnel open and use its localhost URL instead.

## Preserve data and upgrade

The Compose `data` volume mounts at `/data`. It contains both databases, file
storage, and generated credentials. Keep the whole volume together. Never share
it between running containers. `npm run selfhost:backup` stops Canon so both
databases close their files, archives the whole volume with a checksum for every
file, and starts Canon again. `npm run selfhost:restore` puts an archive back.
[Back up and restore](updating.md#back-up-and-restore) covers both, including
which secrets the archive holds.
To keep one workspace's records in a file you can check, rather than the whole
volume, use [Export a workspace](workspace-export.md).

To upgrade, take a backup, check out the new release, and start it: set
`CANON_IMAGE` in `.env` to the release's image and run `docker compose pull` and
`docker compose up -d`, or rebuild with `docker compose up -d --build`. The container pushes the backend functions when
the image or `SITE_URL` changed, so the first boot after an upgrade takes longer
than a restart. Run verification again with the existing owner.
`npm run selfhost:releases` lists the signed releases newer than your checkout.
[updating.md](updating.md) gives the steps, including merging a release into
your own changes.
`docker compose down` preserves the volume. `docker compose down -v` deletes
data and credentials. Use `-v` only to tear down a disposable test installation.

## Run the backend on Convex Cloud

To run the backend on your own Convex Cloud account instead of in the container,
create a project and provide its production `CONVEX_DEPLOY_KEY` and the app's
`SITE_URL` in a mode-0600 environment file. Run `npm ci`, then
`npm run selfhost:deploy -- --target convex-cloud --env-file ../canon-deploy.env --dry-run`.
Remove `--dry-run` to deploy. The command writes `.env.selfhost.local`, including the first owner's `CANON_SETUP_CODE`. Copy it
to `.env.production.local`, run `npm run build`, then `npm start`. Keep its
signing key for upgrades and configure HTTPS for the Next.js host. Optional
integrations need their own setup in [Optional integrations](selfhost-integrations.md).

Use the same verifier against that URL. Pass its
backend URL as the second positional argument, or load `NEXT_PUBLIC_CONVEX_URL`
from `.env.selfhost.local` alongside the owner environment file. Container restart
verification applies to Docker hosts you control.

## License

The application uses AGPL-3.0-only. The `engine/` directory uses Apache-2.0.
The bundled Convex backend uses FSL-1.1-Apache-2.0 separately.
