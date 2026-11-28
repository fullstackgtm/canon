import { STANDARD_OBJECTS, type StandardObjectName } from "../../convex/lib/objects/registry.ts";
import type { Layout, LayoutOp, SectionRef } from "./edit.ts";

/** Only simple view requests route here; requests with extra conditions go to Luna. */
export function builtInDataView(layout: Layout, target: SectionRef | undefined, request: string): { ops: LayoutOp[]; summary: string } | null {
  const match = /^(?:(?:make|turn|change) (?:this|it)(?: into| to)?|(?:add|also show)(?: this| it)?(?: as)?) (?:a |an )?(graph|chart|table|list|metric)[.!]?$/i.exec(request.trim());
  const index = target ? layout.sections.findIndex((s) => s.ref.component === target.component && (s.ref.nth ?? 0) === (target.nth ?? 0)) : -1;
  const section = layout.sections[index];
  if (!match || !section?.asQuery) return null;
  const component = match[1].toLowerCase() === "graph" ? "chart" : match[1].toLowerCase() as "chart" | "table" | "list" | "metric";
  const { columns: _, ...base } = section.asQuery as typeof section.asQuery & { columns?: string[] };
  const def = STANDARD_OBJECTS[base.object as StandardObjectName];
  const group = def?.fields.find((f) => f.apiName === "stage" && f.type === "picklist") ?? def?.fields.find((f) => f.type === "picklist");
  if (component === "chart" && !group) return null;
  const query = component === "metric" || component === "chart"
    ? { ...base, aggregate: { fn: "count" as const }, ...(component === "chart" ? { groupBy: { field: group!.apiName } } : {}) }
    : section.asQuery;
  const adding = /^(?:add|also show)\b/i.test(request.trim());
  const before = layout.sections[index + 1]?.ref ?? null;
  const ops: LayoutOp[] = [
    ...(!adding ? [{ op: "removeSection" as const, object: layout.object, section: section.ref }] : []),
    { op: "addSection", object: layout.object, component, title: section.title, query, before },
  ];
  const buttons = !adding && section.actions.length ? ` The ${section.actions.map((a) => `"${a.label}"`).join(", ")} button${section.actions.length === 1 ? " goes" : "s go"} away; a form block can bring back record creation. Undo restores the original section and its actions.` : "";
  return { ops, summary: `${adding ? "Added" : "Replaced"} ${section.title} ${adding ? "as" : "with"} a ${component}${component === "chart" ? ` counting records by ${group!.apiName}` : ""}.${buttons}` };
}
