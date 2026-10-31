# Self-host CanonCRM with Docker

Install Docker with Compose. From the repository root, run:

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f canoncrm
```

Wait for the container to report `healthy`, then open `http://localhost:3000`.
Before exposing the installation, open `/sign-in` and create the first owner.
The first person to complete setup owns the installation. Restrict public access
until you have completed that step.

The image runs Next.js, the Convex open-source backend, and the record service.
Compose uses local authentication and creates its credentials on first boot.
No Clerk account is required. Vendor integrations need their own credentials.
Never enable `FSGTM_ENABLE_DEMO_DATA` on a public installation.

To use your own hostname, set `SITE_URL` before starting Compose:

```sh
export SITE_URL=https://crm.example.com
docker compose up -d
```

Configure an HTTPS reverse proxy for this origin. Forward requests and WebSocket
upgrades to host port 3000, which Compose binds to `127.0.0.1` by default.
Set `FRONTEND_PORT` to select another host port. The same origin serves the app,
Convex at `/convex`, and HTTP actions at `/convex-site`.

The `data` volume mounts at `/data`. It stores the databases, file storage, and
generated credentials. Keep the entire volume together and never share it between
running containers. Allow at least 2 GiB of RAM for one installation.

To upgrade, back up the volume, check out the new source, and run:

```sh
docker compose build
docker compose up -d
```

Stop the container before archiving or restoring the whole volume so both
databases close their files. Restore into an empty volume while the container is
stopped, then start it again. `docker compose down` preserves the volume.
`docker compose down -v` deletes the data and credentials. Do not use it to upgrade.

The application uses AGPL-3.0-only. The `engine/` directory uses Apache-2.0.
The bundled Convex open-source backend uses FSL-1.1-Apache-2.0 separately.
