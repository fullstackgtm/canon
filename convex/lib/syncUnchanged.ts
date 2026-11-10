/**
 * Whether a CRM sync's row would change anything. A sync that rewrites an unchanged row also saves it to the ledger,
 * which reads the record's facts: on a repeat sync of a large portal that was most of the time. QuotaQueue's HubSpot
 * sync skips unchanged rows the same way.
 *
 * - A company or person's mirror row is what the sync wrote, so it is compared with the row (`unchangedRow`): a
 *   value something else changed on the row is still put back, as before.
 * - A deal's row is the ledger's projection, which may store a value in its own words (a stage the org already has),
 *   so the row can differ from what an unchanged CRM sends. The row keeps a fingerprint of the values the sync last
 *   wrote (`syncHash`) instead; the ledger, not the sync, decides what the row says between CRM changes.
 *
 * Pure: no database access, no Node-only imports.
 */

/** Times a write stamps, which are not values the CRM sent. */
const BOOKKEEPING = new Set(["lastSyncAt", "updatedAt"]);

/** A row unchanged since this long ago still gets its sync time stamped, so "last synced" reads stay current. */
export const SYNC_STAMP_MS = 24 * 60 * 60 * 1000;

/**
 * The sync time of a mirror row a sync prepared (convex/salesforce.ts prepareAccounts, prepareContacts, prepareDeals)
 * and has not yet written to the ledger. A prepared deal is also archived until written, so any writer that takes it
 * over makes it live.
 */
export const NOT_WRITTEN = 0;

/** Equal as stored values: object keys in any order, and an undefined field the same as a missing one. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) if (!sameValue(ra[k], rb[k])) return false;
  return true;
}

/** Whether writing `next` over `existing` would leave every value of `next` as it is. */
export function unchangedRow(existing: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.keys(next).every((k) => BOOKKEEPING.has(k) || sameValue(existing[k], next[k]));
}

/** JSON with object keys sorted and undefined fields left out: equal values, equal text. */
export function stableJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x ?? null);
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** 64 bits of FNV-1a over `text`, as hex (two 32-bit passes from different offsets). */
export function fnv64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The fingerprint of the values a sync writes to a row, bookkeeping times aside. */
export function syncFingerprint(value: Record<string, unknown>): string {
  return fnv64(stableJson(Object.fromEntries(Object.entries(value).filter(([k]) => !BOOKKEEPING.has(k)))));
}
