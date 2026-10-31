/**
 * A module doc's integrity seal (docs/modules.md, "Integrity"): a SHA-256 over the fields its collection's
 * `integrity` names and the live docs of each set it lists, so a sealed statement shows when its numbers or its line
 * items changed after it was locked. Canon computes it, never module code. Pure: Convex and tests run it.
 */
import type { IntegrityDecl } from "./manifest.ts";

/** JSON with every object's keys sorted, so equal values give equal text. */
export function canonicalJson(x: unknown): string {
  if (x === undefined || x === null) return "null";
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (typeof x === "object") return `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

const pick = (data: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, data[f] ?? null]));

/**
 * The seal of a doc: its listed fields, and per listed set the listed fields of each live doc, in an order that
 * doesn't depend on keys (a set rewritten with the same docs keeps its seal). `sha256:<hex>`.
 */
export async function sealOf(decl: IntegrityDecl, data: Record<string, unknown>, children: Record<string, ReadonlyArray<Record<string, unknown>>>): Promise<string> {
  const sets = Object.fromEntries(Object.entries(decl.children ?? {}).map(([c, fields]) => [c, (children[c] ?? []).map((d) => canonicalJson(pick(d, fields))).sort()]));
  const text = canonicalJson({ v: 1, fields: pick(data, decl.fields), sets });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
