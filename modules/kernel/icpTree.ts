import type { ObjectValidator, ValidatorJSON } from "./schema.ts";

const field = (fieldType: ValidatorJSON, optional = false) => ({ fieldType, optional });
const strings: ValidatorJSON = { type: "array", value: { type: "string" } };
const object = (value: ObjectValidator["value"]): ObjectValidator => ({ type: "object", value });

export const ICP_SPEC = object({
  market: field(object({ industries: field(strings), employeeBands: field(strings), countries: field(strings) })),
  persona: field(object({ levels: field(strings), departments: field(strings), titles: field(strings), countries: field(strings, true) })),
  exclude: field(object({ industries: field(strings), countries: field(strings), titles: field(strings) })),
  custom: field({ type: "array", value: object({ slug: field({ type: "string" }), values: field(strings, true), min: field({ type: "number" }, true), max: field({ type: "number" }, true) }) }, true),
});

/** The fixed doc fields an icpTree read consumes. Other collection fields stay with the module. */
export const ICP_TREE_FIELDS = {
  icps: object({ spec: field(ICP_SPEC), query: field({ type: "string" }), active: field({ type: "boolean" }) }),
  nodes: object({ icp: field({ type: "string" }), parent: field({ type: "string" }, true), kind: field({ type: "union", value: [{ type: "literal", value: "segment" }, { type: "literal", value: "persona" }] }), query: field({ type: "string" }) }),
};

/** A collection can add fields and narrow choices, but cannot widen a tree field or make a required field optional. */
export function icpTreeSchemaFits(actual: ValidatorJSON, expected: ValidatorJSON): boolean {
  if (actual.type === "literal" && expected.type === "string") return typeof actual.value === "string";
  if (actual.type === "union") return actual.value.every((a) => expected.type === "union" ? expected.value.some((e) => icpTreeSchemaFits(a, e)) : icpTreeSchemaFits(a, expected));
  if (expected.type === "union") return expected.value.some((e) => icpTreeSchemaFits(actual, e));
  if (actual.type !== expected.type) return false;
  if (actual.type === "literal" && expected.type === "literal") return actual.value === expected.value;
  if (actual.type === "array" && expected.type === "array") return icpTreeSchemaFits(actual.value, expected.value);
  if (actual.type === "object" && expected.type === "object") return Object.entries(expected.value).every(([key, e]) => {
    const a = actual.value[key];
    return (!a && e.optional) || (!!a && (e.optional || !a.optional) && icpTreeSchemaFits(a.fieldType, e.fieldType));
  });
  return true;
}
