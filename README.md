# CanonCRM

CanonCRM is a self-hosted CRM built with Next.js and Convex. It includes accounts,
contacts, deals, research agents, and a module system.

## Develop

Use Node.js 22.6 or newer. Run `npm ci`, then `npm run typecheck` and `npm run build`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and
[docs/self-hosting.md](docs/self-hosting.md) for Docker setup.

This source export omits internal deployment infrastructure, operator dashboards,
and private modules. See [the module marketplace](docs/modules-marketplace.md)
for the distribution policy.
No credentials or hosted service access are included.

## License

The application is licensed under [AGPL-3.0-only](LICENSE).
The `engine/` directory is licensed under [Apache-2.0](engine/LICENSE).
The self-hosted image bundles the Convex open-source backend, which is licensed
separately under FSL-1.1-Apache-2.0.
