// Per-field conflict resolver. Pure and total: every (authority, direction,
// equality, timestamp order) combination maps to exactly one decision.
//
//   direction "inbound":  Salesforce changed the field; should FSGTM take it?
//   direction "outbound": FSGTM changed the field; should Salesforce take it?
//
// Rules
//   - Equal values (after normalization) are always a no-op. This is also what
//     suppresses echoes: our own write coming back from the other side
//     compares equal and does nothing.
//   - "salesforce": inbound applies, outbound skips.
//   - "fsgtm":      outbound applies, inbound skips.
//   - "newest":     the side with the later timestamp wins. A tie goes to the
//                   side that produced the change being processed, so a change
//                   is never dropped for having the same millisecond.
//   - "review":     differing values never auto-resolve; they open a conflict
//                   for a human (the review queue).
import type { SyncAuthority } from "./types.ts";

export type Direction = "inbound" | "outbound";

export type ResolveInput = {
  authority: SyncAuthority;
  direction: Direction;
  fsgtmValue: unknown;
  fsgtmAt: number | undefined;
  sfValue: unknown;
  sfAt: number | undefined;
};

export type Decision =
  | { action: "noop"; reason: "equal" }
  | { action: "apply"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "conflict"; reason: string };

/** Normalizes values for comparison: null/undefined/"" are the same; numbers and numeric strings compare by value. */
export function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return String(Number(t));
    if (t === "true" || t === "false") return t;
    return t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return normalizeValue(a) === normalizeValue(b);
}

export function resolveField(input: ResolveInput): Decision {
  if (valuesEqual(input.fsgtmValue, input.sfValue)) return { action: "noop", reason: "equal" };
  const { authority, direction } = input;
  switch (authority) {
    case "salesforce":
      return direction === "inbound"
        ? { action: "apply", reason: "salesforce is authoritative" }
        : { action: "skip", reason: "salesforce is authoritative" };
    case "fsgtm":
      return direction === "outbound"
        ? { action: "apply", reason: "fsgtm is authoritative" }
        : { action: "skip", reason: "fsgtm is authoritative" };
    case "newest": {
      const f = input.fsgtmAt ?? 0;
      const s = input.sfAt ?? 0;
      if (direction === "inbound") {
        return s >= f
          ? { action: "apply", reason: `salesforce newer (${s} >= ${f})` }
          : { action: "skip", reason: `fsgtm newer (${f} > ${s})` };
      }
      return f >= s
        ? { action: "apply", reason: `fsgtm newer (${f} >= ${s})` }
        : { action: "skip", reason: `salesforce newer (${s} > ${f})` };
    }
    case "review":
      return { action: "conflict", reason: "review field differs" };
    default: {
      const never: never = authority;
      return { action: "conflict", reason: `unknown authority ${String(never)}` };
    }
  }
}
