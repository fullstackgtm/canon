# Optional integrations

Canon's CRM pages work without vendor keys. The capability registry in
`convex/lib/integrationsAvailable.ts` lists the required environment names for
billing, AI, data search, messaging, calls, and optional services. A capability
is on only when every required key is nonempty. Pi also requires its enable flag;
its existing organization allowlist still controls individual runs.

Run `npm run selfhost:doctor` with your backend environment exported to see each
capability's on/off state. The command reads the current process environment.
It never prints values, contacts vendors, or changes configuration. To load an
environment file, use Node's `--env-file` option with
`scripts/selfhost-doctor.ts`. Keep that file out of version control.

The Integrations page shows the running backend's status and required key names.
`integrationsAvailable:status` returns booleans only. A key's presence means the
integration can be configured; it does not verify the key or connect an account.
ChatGPT requires `TOKEN_ENCRYPTION_KEY` for stored credentials and a separate
per-user ChatGPT login. OpenRouter research uses `OPENROUTER_API_KEY`. Salesforce
needs no deployment key: a workspace connects with its own External Client App
(client-credentials flow) by pasting its My Domain URL, consumer key and secret.
`SALESFORCE_CLIENT_ID` only adds the "Connect Salesforce" sign-in button; its
client secret is optional for the PKCE flow.
The existing treg paid-call switch, permissions, approvals, and organization
allowlists still apply.

Without the record service, records use the existing Convex-backed store.
Without the recipe runtime, first-party recipe code keeps its existing in-process
execution; modules that declare server code are unavailable. Declarative modules such as
Reports remain available. Installing executable packages requires the runtime. Missing
vendor keys hide controls or show a needs-key note. Scheduled vendor workers
skip unavailable capabilities.

Logging email by BCC or forward needs `EMAIL_LOG_DOMAIN` and
`EMAIL_LOG_SECRET`, and something that receives mail for that domain and
posts it to Canon. [Logging email by BCC or forward](email-logging.md) shows
how to wire a Cloudflare Email Worker, a mail server or Postmark.
