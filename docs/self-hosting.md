# Deploy CanonCRM on a machine you already have

Use Docker on this machine, or on a server you can reach with `ssh <host>`.
You do not need to sign up for a service. Docker runs the app, the open-source
Convex backend, and the record service together. Local authentication creates
the installation's first owner. The image generates its own backend and signing
credentials. Only a remote server needs SSH access.

Run commands from the repository root. Allow at least 2 GiB of RAM for the
running installation and extra memory and disk space for the image build.
Keep access private until you create the first owner. The first successful
registration owns the installation. Leave `FSGTM_ENABLE_DEMO_DATA` unset.

## Prepare the machine

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

## Start Canon with Docker Compose

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

For this machine, open `http://localhost:3000/sign-in` and create the owner,
or let the verification command below create it before opening public access.
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

## Use a remote server privately through SSH

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

## Add HTTPS when a domain points at the server

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
```

For a fresh installation, this one command proves first owner creation as
well as sign-in. Run it while the installation is still private:

```sh
node --env-file=../canon-owner.env scripts/selfhost/verify.mjs http://localhost:3000 --bootstrap-owner
```

For a throwaway test install, skip the file. With `--bootstrap-owner` and no
credentials set, the command creates a throwaway owner with a random password it
never saves. Do not use this on an install a client will keep, because that owner
then owns the installation:

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

To upgrade, take a backup, check out the new release, and run
`docker compose up -d --build`. The container pushes the backend functions when
the image or `SITE_URL` changed, so the first boot after an upgrade takes longer
than a restart. Run verification again with the existing owner.
`npm run selfhost:releases` lists the signed releases newer than your checkout.
[updating.md](updating.md) gives the steps, including merging a release into
your own changes.
`docker compose down` preserves the volume. `docker compose down -v` deletes
data and credentials. Use `-v` only to tear down a disposable test installation.

## If you want a managed cloud

Choose managed hosting only when you explicitly want a provider account.
Supply credentials through your secret manager or private environment files.

- Railway can run `Dockerfile.selfhost`. Select it in the service build settings,
  attach a persistent volume at `/data`, use one replica with at least 2 GiB RAM,
  set `PORT=3000` and `SITE_URL` to the generated HTTPS domain, and use
  `/api/public/version` as the health-check path. Deploy with Railway's CLI or
  API using your own account. The image generates the app's credentials.
- For Convex Cloud, create a project and provide its production
  `CONVEX_DEPLOY_KEY` and the app's `SITE_URL` in a mode-0600 environment file.
  Run `npm ci`, then `npm run selfhost:deploy -- --target convex-cloud --env-file
  ../canon-deploy.env --dry-run`. Remove `--dry-run` to deploy. The command writes
  `.env.selfhost.local`. Copy it to `.env.production.local`, run `npm run build`,
  then `npm start`. Keep its signing key for upgrades and configure HTTPS for
  the Next.js host. Optional integrations need their own setup in
  [Optional integrations](selfhost-integrations.md).

Use the same verifier against either managed URL. For Convex Cloud, pass its
backend URL as the second positional argument, or load `NEXT_PUBLIC_CONVEX_URL`
from `.env.selfhost.local` alongside the owner environment file. Container restart
verification applies to Docker hosts you control.

## License

The application uses AGPL-3.0-only. The `engine/` directory uses Apache-2.0.
The bundled Convex backend uses FSL-1.1-Apache-2.0 separately.
