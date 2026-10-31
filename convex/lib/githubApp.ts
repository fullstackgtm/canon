/**
 * Canon's GitHub App for private recipe repos (docs/recipes.md, R5b). It signs the App's JWT with WebCrypto, so it
 * runs in the default Convex runtime, and trades it for installation tokens. A token lives only in the caller's
 * local variables for one operation: nothing here stores, logs or returns one to a client.
 *
 * Env: GITHUB_RECIPES_APP_ID, GITHUB_RECIPES_APP_SLUG, GITHUB_RECIPES_APP_PRIVATE_KEY (PEM, PKCS#1 as GitHub issues
 * it, or PKCS#8), and for connecting, the App's OAuth client: GITHUB_RECIPES_APP_CLIENT_ID and
 * GITHUB_RECIPES_APP_CLIENT_SECRET. RECIPE_GITHUB_API_BASE and RECIPE_GITHUB_WEB_BASE override api.github.com and github.com.
 */
import { ConvexError } from "convex/values";

const TIMEOUT_MS = 10_000;
export const apiBase = () => process.env.RECIPE_GITHUB_API_BASE || "https://api.github.com";
export const webBase = () => process.env.RECIPE_GITHUB_WEB_BASE || "https://github.com";

type AppConfig = { appId: string; slug: string; privateKey: string };

/** The App's own credentials: enough to read repos it's installed on. */
export function appConfig(): AppConfig | null {
  const e = process.env;
  const c = { appId: e.GITHUB_RECIPES_APP_ID, slug: e.GITHUB_RECIPES_APP_SLUG, privateKey: e.GITHUB_RECIPES_APP_PRIVATE_KEY };
  return c.appId && c.slug && c.privateKey ? (c as AppConfig) : null;
}

export function requireAppConfig(): AppConfig {
  const c = appConfig();
  if (!c) throw new ConvexError("Canon's GitHub App isn't set up on this deployment, so private repos can't be read.");
  return c;
}

/** The App's OAuth client, which proves who installed it. Without it, a connect can't be checked and is refused. */
function oauthConfig(): { clientId: string; clientSecret: string } {
  const { GITHUB_RECIPES_APP_CLIENT_ID: clientId, GITHUB_RECIPES_APP_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) throw new ConvexError("Canon's GitHub App has no OAuth client on this deployment (GITHUB_RECIPES_APP_CLIENT_ID and GITHUB_RECIPES_APP_CLIENT_SECRET), so it can't check who installed it.");
  return { clientId, clientSecret };
}

/** A GitHub answer the caller maps to its own message. Carries the status only, never the body. */
export class GithubAppError extends Error {
  readonly status: number;
  constructor(status: number, what: string) { super(`GitHub answered ${status} for ${what}`); this.status = status; }
}

// DER: a length, then a tag-length-value.
const derLength = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
const tlv = (tag: number, body: Uint8Array) => new Uint8Array([tag, ...derLength(body.length), ...body]);
// AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** PKCS#8 DER from a PEM key. A PKCS#1 key is wrapped as PrivateKeyInfo { version 0, rsaEncryption, OCTET STRING }. */
export function pkcs8Der(pem: string): Uint8Array {
  const text = pem.replace(/\\n/g, "\n").trim();
  const block = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(text);
  if (!block) throw new ConvexError("GITHUB_RECIPES_APP_PRIVATE_KEY isn't a PEM private key.");
  const der = Uint8Array.from(atob(block[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (!block[1]) return der;
  return tlv(0x30, new Uint8Array([0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...tlv(0x04, der)]));
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlJson = (x: unknown) => b64url(new TextEncoder().encode(JSON.stringify(x)));

/** The App's JWT: RS256, issued 60 s back for clock drift, expiring within GitHub's 10 minute limit. */
export async function appJwt(appId: string, pem: string, nowMs = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8Der(pem) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${b64url(signature)}`;
}

async function call(url: string, init: { method?: string; auth: string; body?: unknown; accept?: string }, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { accept: init.accept ?? "application/vnd.github+json", authorization: init.auth, "user-agent": "canon-recipes", "x-github-api-version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ConvexError(`Couldn't reach GitHub for ${what}.`);
  }
  if (!res.ok) { await res.body?.cancel(); throw new GithubAppError(res.status, what); }
  return res.json();
}

const appAuth = async () => { const c = requireAppConfig(); return `Bearer ${await appJwt(c.appId, c.privateKey)}`; };

/** The GitHub account an installation of Canon's App belongs to. */
export async function installationAccount(installationId: number): Promise<{ login: string; type: string }> {
  const body = await call(`${apiBase()}/app/installations/${installationId}`, { auth: await appAuth() }, "the installation") as { account?: { login?: unknown; type?: unknown } };
  const { login, type } = body.account ?? {};
  if (typeof login !== "string" || typeof type !== "string") throw new ConvexError("GitHub didn't say which account the installation belongs to.");
  return { login, type };
}

/**
 * A read-only installation token, scoped to `repo` when one is named. The caller uses it for one operation and
 * drops it; GitHub expires it within the hour regardless.
 */
export async function installationToken(installationId: number, repo?: string): Promise<string> {
  const body = await call(`${apiBase()}/app/installations/${installationId}/access_tokens`, {
    method: "POST", auth: await appAuth(),
    body: { ...(repo ? { repositories: [repo] } : {}), permissions: { contents: "read", metadata: "read" } },
  }, "an installation token") as { token?: unknown };
  if (typeof body.token !== "string") throw new ConvexError("GitHub didn't return an installation token.");
  return body.token;
}

/** The repos an installation can read, up to 100. */
export async function installationRepos(installationId: number): Promise<Array<{ fullName: string; private: boolean }>> {
  const token = await installationToken(installationId);
  const body = await call(`${apiBase()}/installation/repositories?per_page=100`, { auth: `Bearer ${token}` }, "the installation's repos") as { repositories?: Array<{ full_name?: unknown; private?: unknown }> };
  return (body.repositories ?? []).flatMap((r) => (typeof r.full_name === "string" ? [{ fullName: r.full_name, private: r.private === true }] : []));
}

/**
 * The installations of Canon's App that the GitHub user who authorized `code` can reach, each with the repos that
 * user can see in it. GitHub's setup redirect carries an installation_id anyone can forge, so a connection is made
 * only for an installation on this list, and covers only the repos listed. The user's token is dropped afterwards.
 */
export async function userInstallations(code: string): Promise<Array<{ id: number; repos: string[] }>> {
  const c = oauthConfig();
  let res: Response;
  try {
    res = await fetch(`${webBase()}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "canon-recipes" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ConvexError("Couldn't reach GitHub to confirm who you are.");
  }
  const body = (res.ok ? await res.json() : (await res.body?.cancel(), {})) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new ConvexError("GitHub didn't confirm your sign-in. Connect GitHub again.");
  const auth = `Bearer ${body.access_token}`;
  const list = await call(`${apiBase()}/user/installations?per_page=100`, { auth }, "your installations") as { installations?: Array<{ id?: unknown }> };
  const ids = (list.installations ?? []).flatMap((i) => (typeof i.id === "number" ? [i.id] : []));
  return Promise.all(ids.map(async (id) => {
    const page = await call(`${apiBase()}/user/installations/${id}/repositories?per_page=100`, { auth }, "the repos you can see") as { repositories?: Array<{ full_name?: unknown }> };
    return { id, repos: (page.repositories ?? []).flatMap((r) => (typeof r.full_name === "string" ? [r.full_name] : [])) };
  }));
}

/** Where "Connect GitHub" sends an admin: the App's install page, carrying the one-time state. */
export const installUrl = (state: string) => `${webBase()}/apps/${encodeURIComponent(requireAppConfig().slug)}/installations/new?state=${encodeURIComponent(state)}`;

/** GitHub's sign-in for the App, for a return that came back without a code (an update to an existing install). */
export const authorizeUrl = (state: string, redirectUri: string) =>
  `${webBase()}/login/oauth/authorize?client_id=${encodeURIComponent(oauthConfig().clientId)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
