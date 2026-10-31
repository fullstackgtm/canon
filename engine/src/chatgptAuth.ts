/**
 * "Sign in with ChatGPT" device-code flow — the same OAuth path the Codex CLI
 * uses for `codex login --device-auth`, done over plain fetch so it runs in
 * the default Convex runtime (no Node imports, no CLI, no container).
 *
 * 1. requestDeviceCode   → user code + verification URL to show the user
 * 2. pollDeviceCode      → pending until the user approves at auth.openai.com
 * 3. exchangeDeviceCode  → access / refresh / id tokens (PKCE pair from step 2)
 * 4. refreshChatgptTokens when the access token nears expiry
 *
 * The tokens act for the user's own ChatGPT plan, so inference made with them
 * spends that user's budget (llm.ts provider "chatgpt"). Callers must store
 * them encrypted and never send them to a browser.
 */

export const CHATGPT_ISSUER = "https://auth.openai.com";
/** The Codex CLI's public OAuth client — the only client the device flow serves. */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;

export type ChatgptDeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
};

export type ChatgptTokens = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
};

export type ChatgptIdentity = {
  accountId: string;
  email?: string;
  planType?: string;
  /** Access-token expiry (ms since epoch), from its JWT `exp`. */
  accessTokenExpiresAt?: number;
};

type Fetch = typeof fetch;

async function postJson(fetchImpl: Fetch, url: string, body: object): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Status line only: auth error bodies can echo codes and tokens. */
function authError(step: string, response: Response): Error {
  return new Error(`ChatGPT sign-in ${step} failed: ${response.status} ${response.statusText}`);
}

export async function requestDeviceCode(fetchImpl: Fetch = fetch, now = Date.now()): Promise<ChatgptDeviceCode> {
  const response = await postJson(fetchImpl, `${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`, {
    client_id: CHATGPT_CLIENT_ID,
  });
  if (!response.ok) throw authError("start", response);
  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
    expires_at?: string;
  };
  const userCode = json.user_code ?? json.usercode;
  if (!json.device_auth_id || !userCode) throw new Error("ChatGPT sign-in start returned no device code.");
  const intervalSeconds = Math.max(1, Number(json.interval ?? 5) || 5);
  const parsedExpiry = json.expires_at ? Date.parse(json.expires_at) : NaN;
  return {
    deviceAuthId: json.device_auth_id,
    userCode,
    verificationUrl: CHATGPT_VERIFICATION_URL,
    intervalMs: intervalSeconds * 1000,
    // The server's window is 15 minutes; fall back to that if it omits one.
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + 15 * 60_000,
  };
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "approved"; authorizationCode: string; codeVerifier: string };

/** One poll. 403/404 mean the user hasn't approved yet. */
export async function pollDeviceCode(
  deviceAuthId: string,
  userCode: string,
  fetchImpl: Fetch = fetch,
): Promise<DevicePollResult> {
  const response = await postJson(fetchImpl, `${CHATGPT_ISSUER}/api/accounts/deviceauth/token`, {
    device_auth_id: deviceAuthId,
    user_code: userCode,
  });
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) throw authError("poll", response);
  const json = (await response.json()) as { authorization_code?: string; code_verifier?: string };
  if (!json.authorization_code || !json.code_verifier) {
    throw new Error("ChatGPT sign-in approval returned no authorization code.");
  }
  return { status: "approved", authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
}

function tokensFrom(json: { access_token?: string; refresh_token?: string; id_token?: string }, previous?: ChatgptTokens): ChatgptTokens {
  const accessToken = json.access_token;
  const idToken = json.id_token ?? previous?.idToken;
  const refreshToken = json.refresh_token ?? previous?.refreshToken;
  if (!accessToken || !idToken || !refreshToken) throw new Error("ChatGPT token response was incomplete.");
  return { accessToken, refreshToken, idToken };
}

export async function exchangeDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: Fetch = fetch,
): Promise<ChatgptTokens> {
  const response = await fetchImpl(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${CHATGPT_ISSUER}/deviceauth/callback`,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!response.ok) throw authError("token exchange", response);
  return tokensFrom(await response.json());
}

/** Thrown when the refresh token is dead (expired, revoked, or already rotated). */
export class ChatgptReauthRequired extends Error {}

export async function refreshChatgptTokens(previous: ChatgptTokens, fetchImpl: Fetch = fetch): Promise<ChatgptTokens> {
  const response = await postJson(fetchImpl, `${CHATGPT_ISSUER}/oauth/token`, {
    client_id: CHATGPT_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: previous.refreshToken,
    scope: "openid profile email",
  });
  if (response.status === 400 || response.status === 401) {
    throw new ChatgptReauthRequired("ChatGPT session can no longer be refreshed — reconnect ChatGPT in Integrations → ChatGPT.");
  }
  if (!response.ok) throw authError("refresh", response);
  return tokensFrom(await response.json(), previous);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed ChatGPT token.");
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/**
 * Account, email and plan from the id token; expiry from the access token.
 * Neither JWT's signature is checked: both came straight from the issuer over
 * TLS in the exchange above, and the backend re-validates the access token.
 */
export function chatgptIdentity(tokens: ChatgptTokens): ChatgptIdentity {
  const id = decodeJwtPayload(tokens.idToken);
  const auth = (id["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accountId = auth["chatgpt_account_id"];
  if (typeof accountId !== "string" || !accountId) throw new Error("ChatGPT token carries no account id.");
  let accessTokenExpiresAt: number | undefined;
  try {
    const exp = decodeJwtPayload(tokens.accessToken)["exp"];
    if (typeof exp === "number") accessTokenExpiresAt = exp * 1000;
  } catch {
    // Opaque access token: callers refresh on a 401 instead.
  }
  return {
    accountId,
    email: typeof id["email"] === "string" ? (id["email"] as string) : undefined,
    planType: typeof auth["chatgpt_plan_type"] === "string" ? (auth["chatgpt_plan_type"] as string) : undefined,
    accessTokenExpiresAt,
  };
}
