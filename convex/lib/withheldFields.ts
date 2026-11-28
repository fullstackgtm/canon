import { canSeeRecord, hiddenFields, intersectScopes, isRestricted, scopeFor, type Access } from "./access.ts";
import { FormulaError, parseFormula, type Expr } from "./objects/formula.ts";
import { indexObjectDef, type ObjectDef } from "./objects/registry.ts";
import { listViewDef, type OwnerScope } from "./objects/listSpec.ts";

/** Direct and dependency-withheld fields, shared by reads and metadata. */
export async function withheldFields(accesses: readonly Access[], definitions: readonly ObjectDef[], scopeOf: (object: string) => Promise<OwnerScope | null | boolean> = async (object) => {
  if (object === "lineItem") return accesses.some((a) => !canSeeRecord(a, "lineItem", false, null)) || accesses.map((a) => scopeFor(a, "deal")).reduce(intersectScopes, null);
  return accesses.map((a) => scopeFor(a, object)).reduce(intersectScopes, null);
}): Promise<Map<string, Set<string>>> {
  const withheld = new Map<string, Set<string>>();
  if (!accesses.some(isRestricted)) return withheld;
  const hidden = (object: string) => {
    const fields = new Set([...(withheld.get(object) ?? []), ...accesses.flatMap((a) => hiddenFields(a, object))]);
    if (object === "account" && fields.has("annualRevenue")) fields.add("revenue");
    return fields;
  };
  const formulaRefs: { object: string; name: string; refs: string[] }[] = [];
  const defs = new Map(definitions.map((d) => [d.apiName, indexObjectDef(d)]));
  const references = (e: Expr): string[] => {
    switch (e.k) {
      case "field": return [e.name];
      case "neg": case "not": return references(e.arg);
      case "bin": return [...references(e.left), ...references(e.right)];
      case "call": return e.args.flatMap(references);
      default: return [];
    }
  };
  for (const [object, def] of defs) {
    const h = hidden(object);
    if (object === "contact") {
      if (hidden("account").has("fit")) h.add("accountFit");
      if (hidden("account").has("icpIds")) h.add("accountIcpIds");
    }
    withheld.set(object, h);
    for (const f of def.fields) {
      if (f.type !== "formula" || f.archivedAt !== undefined) continue;
      const source = f.rollup ? defs.get(f.rollup.object) : listViewDef(object, def);
      if (!source) continue;
      let refs: string[];
      try {
        refs = f.formula.trim() ? references(parseFormula(source, f.formula, { rollups: !f.rollup })) : [];
      } catch (e) {
        // The evaluator returns empty for stale definitions; permission checks must not throw instead.
        if (!(e instanceof FormulaError)) throw e;
        continue;
      }
      if (f.rollup) {
        const via = source.byFieldId.get(f.rollup.via as never);
        const field = source.byFieldId.get(f.rollup.field as never);
        refs.push(...[via, field].flatMap((x) => x ? [x.apiName] : []));
        if (await scopeOf(source.apiName) || accesses.some((a) => refs.some((r) => hiddenFields(a, source.apiName).includes(r)))) h.add(f.apiName);
      } else {
        // Formulas can read rollups; propagate after all direct dependencies have been classified.
        formulaRefs.push({ object, name: f.apiName, refs });
      }
    }
  }
  let changed: boolean;
  do {
    changed = false;
    for (const { object, name, refs } of formulaRefs) {
      const h = withheld.get(object)!;
      if (!h.has(name) && refs.some((r) => h.has(r))) { h.add(name); changed = true; }
    }
  } while (changed);
  return withheld;
}
