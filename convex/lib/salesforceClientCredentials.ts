// Imported by default-runtime queries (scheduling): no Node-only APIs.
// Connect Salesforce with a key, like a HubSpot private-app token: the customer's own External Client App (or
// Connected App) with the OAuth client-credentials flow. Its consumer key and secret mint a token for the app's
// run-as user whenever one is needed, so nothing depends on this deployment's SALESFORCE_CLIENT_ID or a redirect.
import { validateSalesforceOrigin } from "../../engine/src/connectors/salesforceAuth.ts";
import { integrationEnabled, type IntegrationEnv } from "./integrationsAvailable.ts";

export type SalesforceClientCredentials = { domain: string; clientId: string; clientSecret: string };

// The flow returns no expires_in. An opaque token lasts the run-as user's session timeout, at least 15 minutes; a
// JWT access token says its own expiry, which can be one or five minutes (tokenExpiresAt reads it).
export const CLIENT_CREDENTIALS_TOKEN_TTL_MS = 15 * 60 * 1000;

/** When a minted token lapses: a JWT access token's own `exp`, else the shortest session timeout. */
export function tokenExpiresAt(accessToken: string, now = Date.now()): number {
  const parts = accessToken.split(".");
  if (parts.length === 3) {
    try {
      const exp = (JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown }).exp;
      if (typeof exp === "number" && Number.isFinite(exp)) return Math.min(exp * 1000, now + CLIENT_CREDENTIALS_TOKEN_TTL_MS);
    } catch {
      // Not a JWT after all: an opaque session id.
    }
  }
  return now + CLIENT_CREDENTIALS_TOKEN_TTL_MS;
}

/**
 * Whether a Salesforce connection can get a fresh token on this deployment: a key connection always can; an OAuth
 * connection only while SALESFORCE_CLIENT_ID is set. Scheduled syncs skip the rest instead of failing every tick.
 */
export function salesforceCanRefresh(row: { clientCredentials?: string }, env: IntegrationEnv = process.env): boolean {
  return Boolean(row.clientCredentials) || integrationEnabled("salesforce", env);
}

/**
 * The org's My Domain origin from what the admin pasted: a bare host, any page of the org (a path is dropped), or
 * its Lightning address (acme.lightning.force.com is acme.my.salesforce.com). The client-credentials token
 * endpoint lives only on My Domain, so login.salesforce.com and test.salesforce.com are refused.
 */
export function myDomainOrigin(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Enter your Salesforce My Domain URL, like https://acme.my.salesforce.com.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("Enter your Salesforce My Domain URL, like https://acme.my.salesforce.com.");
  }
  const host = url.hostname.toLowerCase().replace(/\.lightning\.force\.com$/, ".my.salesforce.com");
  const origin = validateSalesforceOrigin(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`, "The My Domain URL");
  if (host === "login.salesforce.com" || host === "test.salesforce.com") {
    throw new Error("Use your org's My Domain URL (Setup → My Domain), like https://acme.my.salesforce.com, not the login page.");
  }
  return origin;
}

/** Salesforce's reason a client-credentials request failed, said as what the admin should change. */
export function clientCredentialsError(status: number, body: string): string {
  let error = "";
  let description = "";
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };
    error = parsed.error ?? "";
    description = parsed.error_description ?? "";
  } catch {
    // Not JSON: an HTML error page from a wrong host.
  }
  if (error === "invalid_client_id" || error === "invalid_client") {
    return "Salesforce rejected the consumer key or secret. Copy both again from the app's OAuth settings (Consumer Key and Secret).";
  }
  if (error === "invalid_grant" && /client credentials/i.test(description)) {
    return "The app's Client Credentials Flow is off or has no run-as user. Enable it in the app's OAuth policies and pick a run-as user with API access.";
  }
  if (error === "unsupported_grant_type") {
    return "This app does not allow the client-credentials flow. Enable Client Credentials Flow in its OAuth settings.";
  }
  const reason = [error, description].filter(Boolean).join(": ");
  return `Salesforce refused the connection (${reason || `HTTP ${status}`}). Check the My Domain URL and the app's OAuth settings.`;
}

/** A fresh access token for the app's run-as user. */
export async function mintClientCredentialsToken(
  credentials: SalesforceClientCredentials,
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; instanceUrl: string; expiresAt: number; identityUrl?: string }> {
  let response: Response;
  try {
    response = await fetcher(`${credentials.domain}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }).toString(),
    });
  } catch {
    throw new Error(`Could not reach ${credentials.domain}. Check the My Domain URL (Setup → My Domain).`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(clientCredentialsError(response.status, body));
  const token = JSON.parse(body) as { access_token?: string; instance_url?: string; id?: string };
  if (!token.access_token) throw new Error("Salesforce returned no access token.");
  return {
    accessToken: token.access_token,
    expiresAt: tokenExpiresAt(token.access_token),
    // The instance URL comes back as the org's My Domain; it must still be a Salesforce host before it gets a token.
    instanceUrl: token.instance_url ? validateSalesforceOrigin(token.instance_url, "Salesforce's instance URL") : credentials.domain,
    ...(token.id ? { identityUrl: token.id } : {}),
  };
}
