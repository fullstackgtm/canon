import { compileListRequest, FILTERS_MAX } from "../../convex/lib/objects/listSpec.ts";
import { FILTER_OPS, type FilterOp } from "../../modules/kernel/reportLanguage.ts";
import type { ResolvedObjectDef } from "../../convex/lib/objects/registry.ts";
import type { ViewFilter } from "../../modules/kernel/reportValidators.ts";
import type { PeopleFilterForm, PeopleListAction } from "../../modules/kernel/manifest.ts";

export const PEOPLE_LIST_PATH = "/dashboard/records/contact";
export const PEOPLE_FILTER_PARAM = "filter";
export const MODULE_RETURN_PARAM = "returnTo";
export type PeopleListModule = {
  module: string; title: string; listActions?: readonly PeopleListAction[]; filterForms?: readonly PeopleFilterForm[];
};

export function jsonQueryValue(query: Readonly<Record<string, string>>, param: string): unknown {
  const raw = query[param];
  if (raw === undefined || raw === "") throw new Error(`Missing ${param}. Open the People filter builder to choose the query.`);
  try { return JSON.parse(raw); } catch { throw new Error(`The ${param} parameter is not valid JSON. Reopen the filter builder.`); }
}

export function parsePeopleFilter(value: unknown, def: ResolvedObjectDef, available?: ReadonlySet<string>): ViewFilter[] {
  if (!Array.isArray(value)) throw new Error("A People filter must be a list.");
  if (value.length > FILTERS_MAX) throw new Error(`A People query accepts at most ${FILTERS_MAX} filters.`);
  const filters: ViewFilter[] = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each filter must name a field and operator.");
    const f = item as Record<string, unknown>;
    if (Object.keys(f).some((k) => !["field", "op", "value"].includes(k)) || typeof f.field !== "string" || !(FILTER_OPS as readonly unknown[]).includes(f.op)) throw new Error("Each filter must name a field and a supported operator.");
    const scalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
    if (f.value !== undefined && !scalar(f.value) && !(Array.isArray(f.value) && f.value.every(scalar))) throw new Error("A filter value must be a scalar or list of scalars.");
    return { field: f.field, op: f.op as FilterOp, ...(f.value === undefined ? {} : { value: f.value as ViewFilter["value"] }) };
  });
  if (available && filters.some((f) => !available.has(f.field))) throw new Error("The filter names a field that is unavailable in the People list.");
  compileListRequest(def, { filter: filters });
  return filters;
}

export function peopleListHref(filter: readonly ViewFilter[], returnTo: string): string {
  return `${PEOPLE_LIST_PATH}?${new URLSearchParams({ [PEOPLE_FILTER_PARAM]: JSON.stringify(filter), [MODULE_RETURN_PARAM]: returnTo })}`;
}

export function moduleFilterHref(module: string, form: PeopleFilterForm, filter: readonly ViewFilter[]): string {
  return `/dashboard/m/${module}/${form.path}?${new URLSearchParams({ [form.param]: JSON.stringify(filter) })}`;
}

export function resolveAllowedFilterForm(path: string, modules: readonly PeopleListModule[]): { module: string; title: string; form: PeopleFilterForm } {
  const match = /^\/dashboard\/m\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(path);
  if (!match || /[?#\\\s]/.test(path)) throw new Error("The return destination must be a module filter form.");
  const segments = match[2].split("/").map((s) => {
    let decoded: string;
    try { decoded = decodeURIComponent(s); } catch { throw new Error("The module return path is malformed."); }
    if (!decoded || decoded === "." || decoded === ".." || /[/%?#\\\s]/.test(decoded)) throw new Error("The module return path contains an unsafe segment.");
    return decoded;
  });
  const provider = modules.find((m) => m.module === match[1]);
  const form = provider?.filterForms?.find((f) => {
    const declared = f.path.split("/");
    return declared.length === segments.length && declared.every((s, i) => s.startsWith(":") || s === segments[i]);
  });
  if (!provider || !form) throw new Error("That module filter form is unavailable or not allowed for your role.");
  return { module: provider.module, title: provider.title, form: { ...form, path: segments.map(encodeURIComponent).join("/") } };
}

export type PeopleFilterContext = { kind: "core" } | { kind: "filter"; raw: string; returnTo: string };
export function peopleFilterContext(url: { audience: string; filter: string; returnTo: string; filterPresent?: boolean; returnPresent?: boolean }): PeopleFilterContext {
  return url.audience || (!url.filterPresent && !url.returnPresent && !url.filter && !url.returnTo) ? { kind: "core" } : { kind: "filter", raw: url.filter, returnTo: url.returnTo };
}
