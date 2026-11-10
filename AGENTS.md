# Canon agent instructions

When asked to "deploy Canon", use Docker on the current machine by default.
If the user provides a server, use `ssh <host>` and Docker there. Read
[docs/self-hosting.md](docs/self-hosting.md) for installation, cloning, Compose,
owner setup, verification, backups, and upgrades. Install Docker if missing.
No provider signup or cloud credentials are required. Use managed hosting only
when the user explicitly chooses it.

Keep the app on loopback. Without a domain, use an SSH tunnel for private access.
With an existing domain pointing at the host, set `SITE_URL` and configure an
HTTPS reverse proxy such as Caddy with automatic TLS and WebSocket support.
Create the first local owner before exposing public access.

Run `node scripts/selfhost/verify.mjs <site-url>` with the owner credentials in
a private environment file. On a fresh install, add `--bootstrap-owner` to prove
first owner creation. Add `--restart-container <id>` to prove persistence when
a brief outage is acceptable, and `--ssh <host>` for a remote Docker host.
Report the actual per-check output and timings before declaring deployment done.
The verifier leaves a labeled company, person, and deal for inspection.

Before installing for someone, check the code against
[docs/what-canon-runs.md](docs/what-canon-runs.md) and report anything it does
that the page doesn't list. To update an installation, follow
[docs/updating.md](docs/updating.md): signed releases only, and merge, never
rebase, a release into a fork's own changes.

Use Node.js 22.6 or newer. For development, run `npm ci`, `npm run typecheck`,
and `npm run build`. For deploy tooling changes, run
`node --experimental-strip-types --test tests/selfhostDeploy.test.ts`.
Read `convex/_generated/ai/guidelines.md` before changing Convex functions.
Use APIs or CLIs for services. Keep credentials in environment variables or
private environment files. Never commit or print secrets. Preserve the generated
auth keys and databases across upgrades. Never use `docker compose down -v`
on an installation whose data must survive.
