// GENERATED from convex/lib/objects/rules.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/**
 * Field rules (CP7b, docs/core-crm-parity.md "CP7. Field builder"): the checks
 * an admin puts on a custom field beyond its type. Pure and the only place a
 * rule is evaluated: `coerce` (registry.ts) calls `checkRules` for every
 * write, so the UI, CSV, the record API, MCP and agent proposals all hit the
 * same rule and get the same error.
 *
 * A rule checks the value being written, after it is parsed to its type. It
 * never looks at stored records, so a record that already breaks a new rule is
 * only refused when someone writes that field.
 */

/** One rule. A pattern always carries the admin's message; the others may. */
export type FieldRule =
  | { kind: "pattern"; pattern: string; message: string }
  | { kind: "min"; value: number; message?: string }
  | { kind: "max"; value: number; message?: string }
  | { kind: "maxLength"; value: number; message?: string }
  | { kind: "date"; when: "notPast" | "notFuture"; message?: string }
  | { kind: "oneOf"; values: string[]; message?: string };

export type RuleKind = FieldRule["kind"];

/** The rule kinds each field type takes. */
export const RULES_BY_TYPE: Readonly<Record<string, readonly RuleKind[]>> = {
  text: ["pattern", "maxLength", "oneOf"],
  number: ["min", "max"],
  currency: ["min", "max"],
  date: ["date"],
  datetime: ["date"],
};

export const PATTERN_MAX = 200;
export const MESSAGE_MAX = 200;
export const ONE_OF_MAX = 100;
export const RULES_MAX = 5;

/** What a broken rule carries: its kind, so a caller can name it, and the text to show. */
export type RuleFailure = { rule: RuleKind; message: string };

/** How a rule is named in an error. */
export const RULE_NAMES: Readonly<Record<RuleKind, string>> = {
  pattern: "pattern", min: "minimum", max: "maximum", maxLength: "maximum length", date: "date", oneOf: "one-of",
};

/** What a person reads: their message, or a plain statement of the limit. */
function describe(rule: FieldRule): string {
  if (rule.message) return rule.message;
  switch (rule.kind) {
    case "pattern": return `must match ${rule.pattern}`;
    case "min": return `must be at least ${rule.value}`;
    case "max": return `must be at most ${rule.value}`;
    case "maxLength": return `must be at most ${rule.value} characters`;
    case "date": return rule.when === "notPast" ? "must not be in the past" : "must not be in the future";
    case "oneOf": return `must be one of ${rule.values.join(", ")}`;
  }
}

const DAY = 86_400_000;

/**
 * The first rule `value` breaks, or null. `value` is already parsed (a number,
 * a trimmed string, a `YYYY-MM-DD` date, epoch ms) and never empty: an empty
 * value is the required check's, not a rule's. `now` is epoch ms. A date is a
 * whole day, so today is neither past nor future.
 */
export function checkRules(rules: readonly FieldRule[], value: unknown, now: number): RuleFailure | null {
  for (const rule of rules) {
    let failed = false;
    switch (rule.kind) {
      case "pattern": failed = typeof value === "string" && !patternOf(rule.pattern).test(value); break;
      case "min": failed = typeof value === "number" && value < rule.value; break;
      case "max": failed = typeof value === "number" && value > rule.value; break;
      case "maxLength": failed = typeof value === "string" && value.length > rule.value; break;
      case "oneOf": failed = typeof value === "string" && !rule.values.includes(value); break;
      case "date": {
        const isDay = typeof value === "string";
        const at = isDay ? Date.parse(`${value}T00:00:00Z`) : typeof value === "number" ? value : NaN;
        if (!Number.isFinite(at)) break;
        const today = Math.floor(now / DAY) * DAY;
        failed = rule.when === "notPast" ? at < (isDay ? today : now) : at > (isDay ? today + DAY - 1 : now);
        break;
      }
    }
    if (failed) return { rule: rule.kind, message: describe(rule) };
  }
  return null;
}

/** A pattern as a regex. One that does not compile matches nothing; `checkRuleDefs` refused it when saved. */
function patternOf(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return /(?!)/;
  }
}

/**
 * A field's rules as an admin submitted them, checked: kinds the type takes,
 * patterns that compile, bounded sizes, a message on every pattern. Throws the
 * first problem as text.
 */
export function checkRuleDefs(type: string, label: string, rules: readonly FieldRule[]): void {
  const allowed = RULES_BY_TYPE[type] ?? [];
  if (rules.length > RULES_MAX) throw new Error(`${label} takes at most ${RULES_MAX} rules`);
  const seen = new Set<string>();
  for (const r of rules) {
    if (!allowed.includes(r.kind)) throw new Error(`A ${type} field takes no ${r.kind} rule`);
    if (seen.has(r.kind)) throw new Error(`${label} has two ${r.kind} rules`);
    seen.add(r.kind);
    if (r.message !== undefined && r.message.length > MESSAGE_MAX) throw new Error(`A rule message is at most ${MESSAGE_MAX} characters`);
    switch (r.kind) {
      case "pattern":
        if (!r.message?.trim()) throw new Error("A pattern rule needs a short message saying what a good value looks like");
        if (!r.pattern || r.pattern.length > PATTERN_MAX) throw new Error(`A pattern is 1 to ${PATTERN_MAX} characters`);
        try { new RegExp(r.pattern); } catch { throw new Error("That pattern is not a valid regular expression"); }
        break;
      case "min": case "max": case "maxLength":
        if (!Number.isFinite(r.value)) throw new Error(`The ${r.kind} rule needs a number`);
        if (r.kind === "maxLength" && (!Number.isInteger(r.value) || r.value < 1)) throw new Error("A maximum length is a whole number of at least 1");
        break;
      case "oneOf":
        if (!r.values.length || r.values.length > ONE_OF_MAX || r.values.some((x) => !x.trim())) throw new Error(`A one-of rule lists 1 to ${ONE_OF_MAX} values`);
        break;
      case "date":
        break;
    }
  }
  const min = rules.find((r) => r.kind === "min");
  const max = rules.find((r) => r.kind === "max");
  if (min?.kind === "min" && max?.kind === "max" && min.value > max.value) throw new Error("The minimum is above the maximum");
}
