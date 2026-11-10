import { coreOf, type ObjectValidator, type ValidatorJSON } from "./schema.ts";

/** A members path ends at user refs, including refs in arrays and nested objects. */
export function memberPathValid(schema: ObjectValidator, path: string): boolean {
  const parts = path.split(".");
  if (parts.length > 4 || parts.some((p) => !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(p))) return false;
  const walk = (value: ValidatorJSON, at: number): boolean => {
    const core = coreOf(value);
    if (core.type === "array") return walk(core.value, at);
    if (at === parts.length) return core.type === "ref" && core.to === "users";
    if (core.type === "variant") return Object.values(core.cases).every((c) => walk(c, at));
    return core.type === "object" && Object.hasOwn(core.value, parts[at]) && walk(core.value[parts[at]].fieldType, at + 1);
  };
  return walk(schema, 0);
}

/** Exact user identity comparison; labels, substrings and other fields never grant access. */
export function memberNamed(data: Record<string, unknown>, path: string, userId: string): boolean {
  const walk = (value: unknown, parts: readonly string[]): boolean => {
    if (Array.isArray(value)) return value.some((v) => walk(v, parts));
    if (!parts.length) return value === userId;
    return value !== null && typeof value === "object" && Object.hasOwn(value, parts[0])
      && walk((value as Record<string, unknown>)[parts[0]], parts.slice(1));
  };
  return walk(data, path.split("."));
}
