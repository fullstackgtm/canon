import { ConvexHttpClient } from "convex/browser";
import { cookies } from "next/headers";
import { api } from "../../convex/_generated/api";
import { serviceJwtConfig, signServiceJwt } from "./canonServiceJwt.ts";
import { LOCAL_SESSION_COOKIE } from "./authMode.ts";
import { hashLocalSecret, signLocalSessionToken } from "./localAuthCrypto.ts";
export { hashLocalSecret, hashPassword, newLocalSecret, verifyPassword } from "./localAuthCrypto.ts";

export const SESSION_SECONDS = 7 * 86400;

export function localAuthBroker() {
  if (process.env.CANON_AUTH !== "local") throw new Error("Local auth is disabled");
  const config = serviceJwtConfig();
  if (!config) throw new Error("Run scripts/setup-local-auth.mjs before starting local auth");
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is required");
  const client = new ConvexHttpClient(url);
  client.setAuth(signServiceJwt(config, { clerkUserId: "local_auth_server" }));
  return client;
}

export async function sessionForToken(token: string | undefined) {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  return localAuthBroker().query(api.localAuth.session, { tokenHash: hashLocalSecret(token) });
}

export async function localSession() {
  return sessionForToken((await cookies()).get(LOCAL_SESSION_COOKIE)?.value);
}

export function mintLocalToken(session: NonNullable<Awaited<ReturnType<typeof localSession>>>) {
  const config = serviceJwtConfig();
  if (!config) throw new Error("Local auth signing key is missing");
  return signLocalSessionToken(config, session.user.clerkUserId, session.org.clerkOrgId);
}
