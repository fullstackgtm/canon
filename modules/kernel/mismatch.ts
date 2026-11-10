/**
 * Why a JSON value doesn't match a Convex validator, in words: the check a manifest's shipped reports, a recipe's
 * templates and its fields pass. Pure; only `convex/values`' types.
 */
import type { GenericValidator } from "convex/values";

/** Why `value` doesn't match a Convex validator, as `path: what`, or null when it does. */
export function mismatch(validator: GenericValidator, value: unknown, path: string): string | null {
  const val = validator as GenericValidator & { fields?: Record<string, GenericValidator>; element?: GenericValidator; members?: GenericValidator[]; value?: unknown; key?: GenericValidator };
  const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  switch (val.kind) {
    case "any": return null;
    case "string": case "id": return typeof value === "string" ? null : `${path} must be text`;
    case "float64": return typeof value === "number" ? null : `${path} must be a number`;
    case "int64": return typeof value === "bigint" ? null : `${path} must be an integer`;
    case "boolean": return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "null": return value === null ? null : `${path} must be null`;
    case "literal": return value === val.value ? null : `${path} must be ${JSON.stringify(val.value)}`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be a list`;
      for (const [i, x] of value.entries()) { const m = mismatch(val.element!, x, `${path}[${i}]`); if (m) return m; }
      return null;
    }
    case "record": {
      if (!isMap(value)) return `${path} must be a map`;
      for (const [k, x] of Object.entries(value)) { const m = mismatch(val.value as GenericValidator, x, `${path}.${k}`); if (m) return m; }
      return null;
    }
    case "object": {
      if (!isMap(value)) return `${path} must be a map`;
      for (const k of Object.keys(value)) if (!Object.hasOwn(val.fields!, k)) return `${path}.${k} is not a key (${Object.keys(val.fields!).join(", ")})`;
      for (const [k, f] of Object.entries(val.fields!)) {
        if (value[k] === undefined) { if (f.isOptional !== "optional") return `${path}.${k} is missing`; continue; }
        const m = mismatch(f, value[k], `${path}.${k}`);
        if (m) return m;
      }
      return null;
    }
    case "union": {
      const tries = val.members!.map((m) => mismatch(m, value, path));
      if (tries.some((t) => t === null)) return null;
      // A union of tagged objects says what's wrong with the member its `kind` names.
      const tagged = isMap(value) ? val.members!.findIndex((m) => (m as { fields?: Record<string, { value?: unknown }> }).fields?.kind?.value === value.kind) : -1;
      return tagged >= 0 ? tries[tagged] : `${path} must be one of ${val.members!.map((m) => ("value" in m ? JSON.stringify((m as { value: unknown }).value) : m.kind)).join(", ")}`;
    }
    default: return `${path} has a type a template can't hold`;
  }
}
