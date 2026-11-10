import { createHash, timingSafeEqual } from "node:crypto";

// The one-time code that proves the person creating a local-auth install's first owner can read
// its logs or settings. Without it, whoever reached a fresh public URL first would own the install.
// The container generates one (newSetupCode in scripts/selfhost/platform.mjs); CANON_SETUP_CODE overrides.

const normalize = (value: string) => value.toUpperCase().replace(/[\s-]/g, "");

/** Whether `given` matches the install's setup code. No expected code means no first owner can register. */
export function setupCodeMatches(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected || normalize(expected).length < 12) return false;
  const digest = (value: string) => createHash("sha256").update(normalize(value)).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
