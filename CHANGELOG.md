# Changelog

All notable changes to CanonCRM's public open-source releases are documented in
this file. Signed releases are tagged `release/<YYYY-MM-DD>` on
`fullstackgtm/canon`; see [docs/updating.md](docs/updating.md) for how to list
and verify releases.

## [Unreleased]

### Added
- Standard open-source community and legal files (`SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, and `NOTICE`).
- Self-hosted configuration variables in `.env.example`.

### Changed
- Updated [docs/what-canon-runs.md](docs/what-canon-runs.md) to document the
  bundled loopback `workerd` recipe runtime (`127.0.0.1:8790`) and
  `/data/credentials/recipe_runtime_secret`.
- Reconciled [docs/bringing-in-updates.md](docs/bringing-in-updates.md) with
  automatic boot migrations in `scripts/selfhost/entrypoint.mjs`.

## [0.1.0-alpha] - Initial Public Alpha

### Added
- Single-container self-hosted Docker deployment (`Dockerfile.selfhost`,
  `docker-compose.yml`, `scripts/selfhost/install.sh`) bundling Next.js, the
  open-source Convex backend, the DuckDB-backed record service, and the
  loopback `workerd` recipe runtime.
- Local email/password authentication with first-owner setup code protection
  and optional Clerk authentication.
- Signed `release/<date>` upgrade verification (`npm run selfhost:releases`),
  automated data-epoch migrations, and full volume backup/restore
  (`npm run selfhost:backup`, `npm run selfhost:restore`).
- Core CRM objects (accounts, contacts, deals, activities, custom objects and
  fields), saved views, reports, dashboards, record API (`/api/v1`), and
  Salesforce/HubSpot-compatible API surfaces.
- `canon` CLI and `/mcp` token pairing for agent-assisted CRM workflows.
- Customization packages (recipes), open module kit (`modules/kernel/`), and
  connector feeds.
- Open-source `engine/` (Apache-2.0) for canonical CRM models, audits, signed
  patch plans, and market maps.
