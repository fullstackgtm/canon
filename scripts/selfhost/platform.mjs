import { randomBytes, randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

// Where the container finds its public address and setup code when the operator did not set them.

/** The generated setup code, kept in the volume with the other credentials until the operator sets CANON_SETUP_CODE. */
export const SETUP_CODE_FILE = "/data/credentials/setup_code";

/**
 * The public HTTPS origin a hosting platform gives the service, from the variables it sets in every
 * container: Render's RENDER_EXTERNAL_URL and Railway's RAILWAY_PUBLIC_DOMAIN.
 * SITE_URL wins when it is set, so a custom domain only needs SITE_URL.
 */
export function platformSiteUrl(env) {
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

// No 0/O, 1/I/L or U, so a code read from a log is typed back without guessing.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A setup code (src/lib/setupCode.ts): fifteen letters from a 30-letter alphabet, about 73 bits, in groups of five. */
export function newSetupCode() {
  const letters = Array.from({ length: 15 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 5, 10].map((at) => letters.slice(at, at + 5).join("")).join("-");
}

/**
 * The key every install encrypts its stored credentials with (convex/lib/encryption.ts): 32 random bytes, base64.
 * Each setup path generates it once and keeps it; a new key makes every stored credential unreadable.
 */
export function newTokenEncryptionKey() {
  return randomBytes(32).toString("base64");
}

const CONVEX_BACKEND_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_ENV", "NODE_OPTIONS", "DISABLE_BEACON", "DISABLE_METRICS_ENDPOINT", "DO_NOT_TRACK",
  "INSTANCE_NAME", "INSTANCE_SECRET", "DATA_DIR", "CREDENTIALS_DIR",
  "CONVEX_CLOUD_ORIGIN", "CONVEX_SITE_ORIGIN",
  "ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS", "DATABASE_UDF_USER_TIMEOUT_SECONDS",
  "REDACT_LOGS_TO_CLIENT", "RUST_LOG", "RUST_BACKTRACE", "DO_NOT_REQUIRE_SSL",
  "CONVEX_LOCAL_STORAGE_DIR", "POSTGRES_URL", "MYSQL_URL",
  "S3_STORAGE_EXPORTS_BUCKET", "S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET",
  "S3_STORAGE_MODULES_BUCKET", "S3_STORAGE_FILES_BUCKET", "S3_STORAGE_SEARCH_BUCKET",
  "S3_ENDPOINT_URL", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
];

/**
 * The environment the Convex backend runs with. It is told the browser's address (CONVEX_CLOUD_ORIGIN), which its
 * storage URLs need, and its Node action runner calls the backend back there too. The runner loads
 * nodeActionFetch.mjs, which sends those calls to the backend's in-container addresses instead, whatever the host port.
 * Only the allowlisted backend variables are forwarded (function secrets are pushed via the admin API).
 * @param {Record<string, string | undefined>} env
 * @param {{ backend: string, backendSite: string }} addresses
 * @returns {NodeJS.ProcessEnv}
 */
export function backendEnv(env, { backend, backendSite }) {
  // It imports src/lib/internalUrl.ts, which a Node 22 before 22.18 loads only with the flag.
  const preload = `--experimental-strip-types --import=${fileURLToPath(new URL("./nodeActionFetch.mjs", import.meta.url))}`;
  /** @type {Record<string, string | undefined>} */
  const filtered = {};
  for (const key of CONVEX_BACKEND_ENV_KEYS) {
    if (env[key] !== undefined) filtered[key] = env[key];
  }
  return /** @type {NodeJS.ProcessEnv} */ ({
    ...filtered,
    CANON_INTERNAL_CONVEX_URL: backend,
    CANON_INTERNAL_CONVEX_SITE_URL: backendSite,
    NODE_OPTIONS: filtered.NODE_OPTIONS ? `${filtered.NODE_OPTIONS} ${preload}` : preload,
  });
}
