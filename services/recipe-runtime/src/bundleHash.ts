// GENERATED from modules/kernel/bundleHash.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/**
 * A module or recipe bundle's id: the first 32 hex characters of its code's SHA-256. Web Crypto only, so Convex, the
 * recipe runtime (a generated copy, scripts/sync-object-core.ts) and the module kit's build all hash alike.
 */
export async function bundleHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
