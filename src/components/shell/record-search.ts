import type { SearchHit } from "../../../convex/lib/objects/listSpec.ts";
import { formatCurrency } from "../../lib/utils.ts";
import { STANDARD_OBJECTS, type PicklistOption } from "../../../convex/lib/objects/registry.ts";
import { recordHref } from "../records/record-target.ts";
import type { ModuleActivitySearchHit } from "../../../modules/kernel/activities.ts";

export type PaletteRecord = { key: string; id: string; title: string; detail: string | null; href: string };
export type PaletteRecordGroup = { object: string; label: string; records: PaletteRecord[] };

/** Companies, people and deals first; the other objects after them by name. */
const ORDER = ["account", "contact", "deal", "lead"];
const rank = (o: string) => (ORDER.includes(o) ? ORDER.indexOf(o) : ORDER.length);

const labels: Readonly<Record<string, { pluralLabel: string }>> = STANDARD_OBJECTS;
const dealFields: ReadonlyArray<{ apiName: string; options?: readonly PicklistOption[] }> = STANDARD_OBJECTS.deal.fields;
const stageLabel = (value: string) => dealFields.find((f) => f.apiName === "stage")?.options?.find((o) => o.value === value)?.label ?? value;

const text = (v: unknown) => (typeof v === "string" && v ? v : null);

function detailOf(hit: SearchHit): string | null {
  const d = hit.detail ?? {};
  if (hit.object === "account") return text(d.domain);
  if (hit.object === "contact") return text(d.email) ?? text(d.company);
  if (hit.object === "deal") {
    const amount = typeof d.amount === "number" ? formatCurrency(d.amount, text(d.currency) ?? undefined) : null;
    const stage = text(d.stage);
    return [amount, stage && stageLabel(stage)].filter(Boolean).join(" · ") || null;
  }
  return null;
}

/** Search hits grouped by object for the palette, keeping the server's order within each group. `customLabels`: plural labels of the org's own objects. */
export function groupSearchHits(hits: readonly SearchHit[], customLabels: Readonly<Record<string, string>> = {}): PaletteRecordGroup[] {
  const groups = new Map<string, PaletteRecordGroup>();
  for (const hit of hits) {
    let g = groups.get(hit.object);
    if (!g) groups.set(hit.object, (g = { object: hit.object, label: customLabels[hit.object] ?? labels[hit.object]?.pluralLabel ?? hit.object, records: [] }));
    g.records.push({ key: `${hit.object}:${hit.id}`, id: hit.id, title: hit.title || "Untitled", detail: detailOf(hit), href: recordHref(hit.object, hit.id) });
  }
  return [...groups.values()].sort((a, b) => rank(a.object) - rank(b.object) || a.object.localeCompare(b.object));
}

export function groupActivitySearchHits(hits: readonly ModuleActivitySearchHit[]): PaletteRecordGroup[] {
  return hits.length ? [{ object: "module-activity", label: "Activities", records: hits.map((hit) => ({
    key: hit.id, id: hit.id, title: hit.title, detail: `${hit.moduleTitle} · ${hit.activityKind}`, href: hit.source.href,
  })) }] : [];
}
