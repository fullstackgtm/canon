import { randomBytes } from "node:crypto";

/**
 * HubSpot CLI authentication.
 *
 * Two paths, ordered by how little web they need:
 * 1. Private app token — no OAuth at all; created once in HubSpot settings.
 * 2. Bring-your-own-app OAuth with an RFC 8252 loopback redirect — the
 *    browser is used for exactly one thing (the consent grant); the CLI
 *    captures the code on 127.0.0.1 and performs the exchange itself.
 *
 * HubSpot does not support the device-authorization grant or PKCE-only
 * public clients, so the loopback flow requires the user's own app client
 * id/secret, which are kept locally for silent refresh.
 */

const HS_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HS_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HS_API_URL = "https://api.hubapi.com";

export const DEFAULT_OAUTH_SCOPES = [
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.write",
];

export const DEFAULT_LOOPBACK_PORT = 8763;

/**
 * OAuth error responses can echo request parameters (client_secret, code).
 * Surface only the standard `error`/`error_description` fields, never the raw
 * body, so secrets never reach logs.
 */
async function safeTokenError(response: Response): Promise<string> {
  let description: string | undefined;
  try {
    const data = await response.json();
    description = data?.error_description ?? data?.error ?? data?.message;
  } catch {
    // Non-JSON body — withhold it entirely.
  }
  return description
    ? `${response.status} (${String(description).slice(0, 200)})`
    : `HTTP ${response.status} ${response.statusText}`.trim();
}

export type HubspotTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

export async function validateHubspotToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const response = await fetchImpl(`${HS_API_URL}/crm/v3/owners?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.ok) {
    return { ok: true, detail: "Token accepted by the HubSpot CRM API." };
  }
  // Never echo the response body: provider error payloads can reflect request
  // details and end up in logs or shell scrollback.
  return {
    ok: false,
    detail: `HubSpot rejected the token: HTTP ${response.status} ${response.statusText}`.trim(),
  };
}

/** The read scopes a HubSpot sync needs: it reads owners, then companies, contacts and deals. */
export const HUBSPOT_SYNC_SCOPES = [
  "crm.objects.owners.read",
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.read",
];

/**
 * The scopes HubSpot granted a private-app token, or null when HubSpot won't say (an OAuth token, an unknown
 * token, a network failure). Connecting checks these so a token missing a scope is refused up front, naming
 * every missing scope, instead of failing the first sync one 403 at a time.
 */
export async function hubspotTokenScopes(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await fetchImpl(`${HS_API_URL}/oauth/v2/private-apps/get/access-token-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenKey: token }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data?.scopes) ? data.scopes.filter((scope: unknown) => typeof scope === "string") : null;
  } catch {
    return null;
  }
}

/** Why a token with these scopes can't run the sync, naming every missing scope; null when it can. */
export function missingHubspotScopes(granted: readonly string[]): string | null {
  const missing = HUBSPOT_SYNC_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length === 0) return null;
  // HubSpot lists the users scopes next to owners, and they don't cover it.
  const usersNotOwners =
    missing.includes("crm.objects.owners.read") && granted.some((scope) => scope.startsWith("crm.objects.users."))
      ? " The token has crm.objects.users scopes, but owners is a separate scope."
      : "";
  return `This HubSpot token is missing ${missing.join(", ")}.${usersNotOwners} Add ${missing.length > 1 ? "them" : "it"} to the app's scopes in HubSpot, then connect again.`;
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<HubspotTokenSet> {
  const response = await fetchImpl(HS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`HubSpot token request failed: ${await safeTokenError(response)}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("HubSpot token response had no access_token.");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
  };
}

export async function exchangeHubspotCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotTokenSet> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      code: options.code,
    },
    options.fetchImpl ?? fetch,
  );
}

export async function refreshHubspotToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotTokenSet> {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
    },
    options.fetchImpl ?? fetch,
  );
}

export type LoopbackLoginOptions = {
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URL registered on the HubSpot app: http://localhost:<port>/callback */
  port?: number;
  scopes?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Receives the authorize URL; default prints it and best-effort opens a browser. */
  openUrl?: (url: string) => void | Promise<void>;
  log?: (message: string) => void;
};

/**
 * RFC 8252 loopback OAuth: serve one request on 127.0.0.1, send the user to
 * the provider consent page, capture the code locally, exchange it directly.
 */
export async function runHubspotLoopbackLogin(
  options: LoopbackLoginOptions,
): Promise<HubspotTokenSet> {
  const port = options.port ?? DEFAULT_LOOPBACK_PORT;
  const scopes = options.scopes ?? DEFAULT_OAUTH_SCOPES;
  const log = options.log ?? ((message: string) => console.error(message));
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString("hex");
  // Deferred: `node:http` transitively compiles node's bundled undici on
  // import (~10ms+, 12% of a demo-audit run's CPU profile). This module is in
  // the eager graph of every CLI invocation via help.ts/auth.ts, but the
  // server is only needed during the interactive OAuth loopback login.
  const { createServer } = await import("node:http");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const receivedState = url.searchParams.get("state");
      const receivedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<html><body><p>CanonCRM CLI login complete. You can close this tab.</p></body></html>",
      );
      server.close();
      clearTimeout(timer);
      if (error) {
        reject(new Error(`HubSpot authorization failed: ${error}`));
      } else if (receivedState !== state) {
        reject(new Error("OAuth state mismatch; aborting login."));
      } else if (!receivedCode) {
        reject(new Error("HubSpot redirected without an authorization code."));
      } else {
        resolve(receivedCode);
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the OAuth redirect."));
    }, options.timeoutMs ?? 5 * 60 * 1000);

    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      const authorizeUrl =
        `${HS_AUTH_URL}?` +
        new URLSearchParams({
          response_type: "code",
          client_id: options.clientId,
          redirect_uri: redirectUri,
          scope: scopes.join(" "),
          state,
        }).toString();
      log(`Open this URL to authorize (waiting on ${redirectUri}):\n\n  ${authorizeUrl}\n`);
      void (options.openUrl ?? openInBrowser)(authorizeUrl);
    });
  });

  return exchangeHubspotCode({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri,
    code,
    fetchImpl: options.fetchImpl,
  });
}

export async function openInBrowser(url: string) {
  // Headless contexts (agent sandboxes, CI, tests) suppress the OS browser;
  // every flow that opens a URL also prints it for manual use.
  if (process.env.FSGTM_NO_BROWSER) return;
  // The URL may come from an external source (e.g. a broker deployment's
  // verification URL). Only ever hand a well-formed http(s) URL to the OS
  // opener — this prevents a leading `-` from being read as a flag by
  // xdg-open and refuses non-web schemes outright.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const safeUrl = parsed.toString();

  const { spawn } = await import("node:child_process");
  try {
    if (process.platform === "darwin") {
      spawn("open", [safeUrl], { stdio: "ignore", detached: true }).on("error", () => {});
    } else if (process.platform === "win32") {
      // `start` is a cmd builtin, not an executable; the empty "" is the
      // window title so a URL with characters isn't mis-parsed as the title.
      spawn("cmd", ["/c", "start", "", safeUrl], { stdio: "ignore", detached: true }).on(
        "error",
        () => {},
      );
    } else {
      // `--` ends option parsing so the URL is never treated as a flag.
      spawn("xdg-open", ["--", safeUrl], { stdio: "ignore", detached: true }).on("error", () => {});
    }
  } catch {
    // Printing the URL is the contract; opening a browser is best-effort.
  }
}
