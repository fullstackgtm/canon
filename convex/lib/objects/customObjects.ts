/**
 * Custom objects (CP7d, docs/core-crm-parity.md "CP7. Field builder"): how an
 * admin's create, rename and archive change an org's own objects.
 *
 * An object's id is `custom_<slug>` from its first label, made unique among
 * every object the org has ever had (archived ones keep theirs) and never
 * changed: a rename changes only the labels, so records, saved views, webhooks
 * and API callers that name the object keep working. The row is the object's
 * whole definition (registry.ts `resolveOrgObject`): its primary name field
 * `custom.name`, then the fields the field builder adds.
 *
 * Pure: no database access, no Node-only imports.
 */
import { cleanLabel, slugOf } from "./fieldBuilder.ts";
import { OBJECT_ICONS, RegistryError, resolveOrgObject, type CustomObjectMeta, type FieldId, type ObjectLabels, type OrgObjectExtension } from "./registry.ts";
import { CUSTOM_OBJECT_API_NAME } from "../../../modules/kernel/reportLanguage.ts";

/** Objects an org may define, archived ones included: each is a projection table in the record service. */
export const CUSTOM_OBJECTS_MAX = 30;

/** The apiName of every custom object's primary name field. */
export const TITLE_FIELD = "custom.name";

export type NewObject = { label: string; pluralLabel: string; icon: string; titleLabel: string };

/** The objects an org already has, standard and custom, for uniqueness: `apiName` and the labels of the live ones. */
export type ExistingObject = { apiName: string; label: string; pluralLabel: string; archivedAt?: number };

const taken = (existing: readonly ExistingObject[], label: string, except?: string) =>
  existing.some((o) => o.apiName !== except && o.archivedAt === undefined && [o.label, o.pluralLabel].some((l) => l.toLowerCase() === label.toLowerCase()));

/** Standard objects' labels are taken too: two lists named Deals would be confusing in the nav and in search. */
const STANDARD_LABELS = ["account", "accounts", "company", "companies", "contact", "contacts", "person", "people", "opportunity", "opportunities", "deal", "deals", "lead", "leads", "task", "tasks", "note", "notes", "call", "calls", "meeting", "meetings", "email", "emails", "product", "products", "line item", "line items"];

function cleanNames(spec: Pick<NewObject, "label" | "pluralLabel" | "icon">, existing: readonly ExistingObject[], except?: string) {
  const label = cleanLabel(spec.label, "An object name");
  const pluralLabel = cleanLabel(spec.pluralLabel, "An object's plural name");
  if (!(OBJECT_ICONS as readonly string[]).includes(spec.icon)) throw new RegistryError(`${spec.icon} is not an icon`);
  for (const l of [label, pluralLabel]) {
    if (STANDARD_LABELS.includes(l.toLowerCase()) || taken(existing, l, except)) throw new RegistryError(`There is already an object named ${l}`);
  }
  return { label, pluralLabel };
}

/** The `objectDefs` extension for a new custom object, and its apiName. */
export function newObject(spec: NewObject, existing: readonly ExistingObject[]): { apiName: string; ext: OrgObjectExtension } {
  if (existing.filter((o) => CUSTOM_OBJECT_API_NAME.test(o.apiName)).length >= CUSTOM_OBJECTS_MAX) throw new RegistryError(`An org has at most ${CUSTOM_OBJECTS_MAX} custom objects`);
  const { label, pluralLabel } = cleanNames(spec, existing);
  const titleLabel = cleanLabel(spec.titleLabel, "The name field");
  const base = `custom_${slugOf(label, 30)}`.replace(/_+$/, "");
  const ids = new Set(existing.map((o) => o.apiName));
  let apiName = base;
  for (let n = 2; ids.has(apiName); n++) apiName = `${base}_${n}`;
  if (!CUSTOM_OBJECT_API_NAME.test(apiName)) throw new RegistryError(`Cannot name an object ${label}`);
  const meta: CustomObjectMeta = { label, pluralLabel, icon: spec.icon, titleField: TITLE_FIELD };
  const ext: OrgObjectExtension = {
    registryVersion: 1, object: meta,
    customFields: [{ fieldId: TITLE_FIELD as FieldId, apiName: TITLE_FIELD, label: titleLabel, type: "text", required: true }],
  };
  if (!resolveOrgObject(apiName, ext)) throw new RegistryError(`Cannot define ${label}`);
  return { apiName, ext };
}

/** Rename an object's labels, or change its icon. The apiName and every field stay as they were. */
export function editObject(
  apiName: string, ext: OrgObjectExtension, patch: { label?: string; pluralLabel?: string; icon?: string }, existing: readonly ExistingObject[],
): OrgObjectExtension {
  const meta = ext.object;
  if (!meta) throw new RegistryError(`${apiName} is not a custom object`);
  const names = cleanNames({ label: patch.label ?? meta.label, pluralLabel: patch.pluralLabel ?? meta.pluralLabel, icon: patch.icon ?? meta.icon }, existing, apiName);
  return { ...ext, registryVersion: ext.registryVersion + 1, object: { ...meta, ...names, icon: patch.icon ?? meta.icon } };
}

/**
 * A standard object's own name in the org (People called Contacts), or its default again with `null`. Only the
 * labels change, so records, views and API callers that name the object keep working. No other live object, standard
 * or custom, may already be called it.
 */
export function relabelObject(apiName: string, ext: OrgObjectExtension | undefined, labels: ObjectLabels | null, existing: readonly ExistingObject[]): OrgObjectExtension {
  const { labels: _, ...base } = ext ?? { registryVersion: 0, customFields: [] };
  const names = labels ? { label: cleanLabel(labels.label, "An object name"), pluralLabel: cleanLabel(labels.pluralLabel, "An object's plural name") } : resolveOrgObject(apiName, base);
  if (!names) throw new RegistryError(`Unknown object ${apiName}`);
  for (const l of [names.label, names.pluralLabel]) if (taken(existing, l, apiName)) throw new RegistryError(`There is already an object named ${l}`);
  return { ...base, registryVersion: base.registryVersion + 1, ...(labels ? { labels: { label: names.label, pluralLabel: names.pluralLabel } } : {}) };
}

/** Archive an object (hidden from the nav, search and the API; its records are kept) or bring it back. */
export function setObjectArchived(ext: OrgObjectExtension, archived: boolean, now: number, existing: readonly ExistingObject[], apiName: string): OrgObjectExtension {
  const meta = ext.object;
  if (!meta) throw new RegistryError(`${apiName} is not a custom object`);
  if (archived === (meta.archivedAt !== undefined)) return ext;
  if (!archived) cleanNames(meta, existing, apiName);
  const { archivedAt: _, ...rest } = meta;
  return { ...ext, registryVersion: ext.registryVersion + 1, object: archived ? { ...rest, archivedAt: now } : rest };
}

