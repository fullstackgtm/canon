# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately rather than opening a public
GitHub issue or posting credentials or exploit details in public channels.

You can report a vulnerability through either of these private channels:

- **GitHub Security Advisories (preferred):**
  [Report a vulnerability on GitHub](https://github.com/fullstackgtm/canon/security/advisories/new)
- **Email:** [security@canoncrm.com](mailto:security@canoncrm.com)

Please include:

- The affected release tag (`release/<date>`) or commit SHA.
- A clear description of the vulnerability and its security impact.
- Minimal reproduction steps or a proof of concept (using synthetic data, never
  real customer records or live credentials).

## Response Process

We aim to acknowledge new reports within 3 business days and keep you updated as
we investigate, prepare a fix, and coordinate disclosure. Please give us
reasonable time to address the issue before disclosing it publicly.

## Supported Versions

Security fixes are delivered on `main` and cut as signed `release/<date>` tags
(see [docs/updating.md](docs/updating.md)). Only the latest signed release is
actively supported for security updates.

## Scope & Self-Hosted Deployment

[docs/what-canon-runs.md](docs/what-canon-runs.md) documents every process,
storage path, credential file, and network connection in the self-hosted Docker
image. Security reports are welcome across:

- Authentication, authorization, tenant isolation, and session handling
- Self-hosted container packaging, entrypoint, and backup/restore tooling
- Recipe and module sandbox isolation (`services/recipe-runtime`)
- Record API, MCP endpoints, webhook verification, and credential encryption
- The `canon` CLI and `fullstackgtm` engine

For operational hardening (loopback binding, HTTPS via reverse proxy, setup
codes, and backing up `TOKEN_ENCRYPTION_KEY`), see
[docs/self-hosting.md](docs/self-hosting.md).
