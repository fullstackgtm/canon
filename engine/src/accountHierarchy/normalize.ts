import type { CanonicalAccount } from "../types.ts";

/** Legal-form and filler words dropped from a company name. Country words are kept on purpose. */
const LEGAL = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "llc", "ltd", "limited", "plc", "sa", "se", "ag",
  "gmbh", "kg", "bv", "nv", "spa", "srl", "holdings", "holding", "group", "the",
]);

/**
 * "Birkenstock Group B.V. & Co. KG" -> "birkenstock". Country words stay: Sephora USA and Sephora Singapore are
 * separate entities, not duplicates. Accents fold ("Moët" -> "moet").
 */
export function normName(name: string | null | undefined): string {
  const folded = (name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = folded.replace(/[.,]/g, "").replace(/&/g, " ").match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => !LEGAL.has(w)).join(" ");
}

/** "https://www.LVMH.com/en" -> "lvmh.com"; null for blanks, bare words and ignored (personal) domains. */
export function domainOf(value: string | null | undefined, ignored: ReadonlySet<string> = new Set()): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  v = v.replace(/:\d+$/, "");
  return v.includes(".") && !ignored.has(v) ? v : null;
}

/** An account whose name is an email address or markup ("Caroline <caroline@x.com>") is junk, not a company. */
export function isJunkName(name: string): boolean {
  return /[<@>]/.test(name);
}

export function rawField(account: { raw?: unknown }, field: string): unknown {
  if (!account.raw || typeof account.raw !== "object") return undefined;
  let cursor: unknown = account.raw;
  for (const part of field.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function rawString(account: { raw?: unknown }, field: string): string | undefined {
  const v = rawField(account, field);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The value of an account field by canonical name first, then provider name in `raw`. */
export function accountValue(account: CanonicalAccount, field: string): string | undefined {
  const canonical = (account as Record<string, unknown>)[field];
  if (typeof canonical === "string" && canonical.trim()) return canonical.trim();
  if (typeof canonical === "number") return String(canonical);
  return rawString(account, field);
}

export function createdDate(account: CanonicalAccount): string | undefined {
  return rawString(account, "CreatedDate") ?? rawString(account, "createdate") ?? rawString(account, "createdAt");
}
