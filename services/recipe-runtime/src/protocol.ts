/**
 * The wire between Convex and the recipe runtime (docs/recipes.md, R3). Convex imports this file too, so it stays
 * free of Worker and Node APIs: Web Crypto only.
 *
 *   POST /run  x-recipe-timestamp: <ms>  x-recipe-signature: <hex HMAC-SHA256(secret, "<ms>.<body>")>
 *   body  { bundle: { hash, code? }, settings, calls: [{ fn, input, with? }] }
 *   200   { results: [{ ok: true, value } | { ok: false, error: { kind, message } }] }   one per call
 *   409   { need: "code" }   the runtime has no isolate for `hash`: send it again with `code`
 *   401   bad or stale signature    400 bad body    500 { error } the isolate failed (CPU limit, a crash)
 */
export const TIMESTAMP_HEADER = "x-recipe-timestamp";
export const SIGNATURE_HEADER = "x-recipe-signature";
/** A request signed further than this from the runtime's clock is refused. */
export const MAX_SKEW_MS = 60_000;

export type RunBody = { bundle: { hash: string; code?: string }; settings: Record<string, unknown>; calls: unknown[] };
export type ModuleBody = {
  bundle: { hash: string; code?: string };
  isolate: string;
  call: string;
  ctx: { now: number; caller: { userId: string; role: string }; args: Record<string, unknown>; workspace?: { fiscalYearStartMonth: number; currency: string } };
  reads: Record<string, unknown>;
};
export type ModuleResult = { ok: true; value: unknown } | { ok: false; error: { kind: string; message: string } };

/** A module call's ceilings (docs/modules.md, "Server code"): CPU per call, and the JSON each way. */
export const MODULE_CPU_MS = 1000;
export const MODULE_BODY_MAX = 4_000_000;
/** `<orgId>:system` or `<orgId>:user:<userId>`: whose code state an isolate holds. */
export const ISOLATE_SCOPE = /^[a-z0-9]{1,64}:(system|user:[a-z0-9]{1,64})$/;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);

function key(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await key(secret, "sign"), utf8(`${timestamp}.${body}`)));
}

/** Whether `signature` signs `timestamp.body`, and `timestamp` is within MAX_SKEW_MS of `now`. Constant-time on the MAC. */
export async function verify(secret: string, timestamp: string | null, signature: string | null, body: string, now: number): Promise<boolean> {
  if (!timestamp || !signature || !/^\d{1,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  const mac = new Uint8Array(signature.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await key(secret, "verify"), mac, utf8(`${timestamp}.${body}`));
}

/** A bundle's id: the first 32 hex characters of its code's SHA-256. scripts/build-recipes.ts writes the same. */
export async function bundleHash(code: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", utf8(code))).slice(0, 32);
}
