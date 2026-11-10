/**
 * The field builder (CP7a, docs/core-crm-parity.md "CP7. Field builder"):
 * how an admin's create, rename, hide, archive and picklist edits change an
 * org's extension of a standard object (its `objectDefs` row).
 *
 * Every change keeps a field's `apiName` and `fieldId` (`custom.<slug>`) as
 * they were made: a rename changes only the label, so stored values, saved
 * views, CSV mappings and API callers that name the field keep working. A
 * picklist option's `value` never changes either; renaming, recolouring,
 * reordering and archiving an option change its label, colour, position and
 * `active` flag. Archiving a field keeps it in the definition (its values stay
 * in the ledger and the projection), and it leaves views and forms.
 *
 * Pure: no database access, no Node-only imports.
 */
import { checkFormula, checkRollup, COMPUTED_MAX, FormulaError, type ComputedType, type RollupDef } from "./formula.ts";
import { isRegisterObject, registerListDef } from "./listSpec.ts";
import { checkRuleDefs, type FieldRule } from "./rules.ts";
import { baseFields, CUSTOM_FIELD_API_NAME, isMultiValueType, PICKLIST_COLORS, RegistryError, resolveOrgObject, type FieldDef, type FieldId, type OrgObjectExtension, type PicklistOption, type ResolvedObjectDef, type StandardObjectName } from "./registry.ts";
import { isCustomObjectName } from "../../../modules/kernel/reportLanguage.ts";

/** The field types an admin can create. */
export const BUILDER_TYPES = ["text", "number", "currency", "date", "checkbox", "picklist", "multipicklist", "lookup", "user", "emails", "phones", "links", "formula", "rollup"] as const;
export type BuilderType = (typeof BUILDER_TYPES)[number];

/** Objects a lookup field can point at: the ones with list and record pages. */
export const LOOKUP_TARGETS: readonly StandardObjectName[] = ["account", "contact", "deal", "lead", "task", "note", "call", "meeting", "product"];

/** Objects whose fields the builder edits (Recipes, Data model). Line items, emails and edges have no pages of their own. */
export const MODELED_OBJECTS: readonly StandardObjectName[] = ["account", "contact", "deal", "lead", "task", "note", "call", "meeting", "product"];

export const LABEL_MAX = 80;
export const OPTIONS_MAX = 200;
/** Custom fields per object, archived ones included: each is a column of the object's projection. */
export const CUSTOM_FIELDS_MAX = 200;

type CustomField = OrgObjectExtension["customFields"][number];

/** An option as the builder edits it: an existing one names its `value`; a new one has none and gets one from its label. */
export type OptionEdit = { value?: string; label: string; color?: string; active?: boolean };

/**
 * What a formula or rollup field computes (formula.ts). A formula has an
 * expression and the type it gives; a rollup has its source, and `formula` is
 * its filter over the related records ("" for all), its type following from
 * what it reads.
 */
export type ComputeSpec = { formula: string; returns?: ComputedType; rollup?: RollupDef };

export type NewField = { label: string; type: BuilderType; options?: readonly OptionEdit[]; lookupTo?: string; compute?: ComputeSpec };

/** The definition of another object of the org, for checking a rollup that reads it. */
export type RelatedDefs = (object: string) => ResolvedObjectDef | null;

/** `rules` replaces the field's rules (an empty list clears them); `required` a record must set and an edit cannot clear. */
export type FieldPatch = { label?: string; hidden?: boolean; options?: readonly OptionEdit[]; required?: boolean; rules?: readonly FieldRule[]; compute?: ComputeSpec };

export const cleanLabel = (raw: string, what = "A field name"): string => {
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label || label.length > LABEL_MAX) throw new RegistryError(`${what} is 1 to ${LABEL_MAX} characters`);
  return label;
};

/** A label as a slug: lowercase letters, digits and underscores, starting with a letter. */
export function slugOf(label: string, max = 40): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max).replace(/_+$/, "");
  return /^[a-z]/.test(base) ? base : `f_${base || "field"}`.slice(0, max);
}

/** `base`, or `base_2`, `base_3`… the first one `taken` does not hold. */
function unique(base: string, taken: (s: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * A picklist's options after an edit, in the order given. Existing options
 * keep their values (one left out is an error: archive it instead), new ones
 * get a value from their label.
 */
export function editOptions(current: readonly PicklistOption[], edits: readonly OptionEdit[]): PicklistOption[] {
  if (edits.length === 0) throw new RegistryError("A picklist needs at least one option");
  if (edits.length > OPTIONS_MAX) throw new RegistryError(`A picklist has at most ${OPTIONS_MAX} options`);
  const byValue = new Map(current.map((o) => [o.value, o]));
  const seen = new Set<string>();
  const out: PicklistOption[] = [];
  for (const e of edits) {
    if (e.value !== undefined && !byValue.has(e.value)) throw new RegistryError(`No option ${JSON.stringify(e.value)} to edit`);
    if (e.color !== undefined && !(PICKLIST_COLORS as readonly string[]).includes(e.color)) throw new RegistryError(`${e.color} is not an option colour`);
    const label = cleanLabel(e.label, "An option name");
    if (out.some((o) => o.label.toLowerCase() === label.toLowerCase())) throw new RegistryError(`Two options are named ${label}`);
    const value = e.value ?? unique(slugOf(label), (s) => byValue.has(s) || seen.has(s));
    if (seen.has(value)) throw new RegistryError(`Option ${JSON.stringify(value)} is listed twice`);
    seen.add(value);
    out.push({ value, label, active: e.active ?? true, ...(e.color ? { color: e.color } : {}) });
  }
  const dropped = current.filter((o) => !seen.has(o.value));
  if (dropped.length) throw new RegistryError(`Archive ${dropped.map((o) => o.label).join(", ")} instead of removing it: records still hold it`);
  if (!out.some((o) => o.active)) throw new RegistryError("A picklist needs at least one active option");
  return out;
}

/** The extension with new custom fields; everything else on it (the object, picklist options, its own name) is kept. */
const next = (ext: OrgObjectExtension | undefined, customFields: CustomField[]): OrgObjectExtension => ({
  ...ext,
  registryVersion: (ext?.registryVersion ?? 0) + 1,
  customFields,
});

/** Check the result resolves (no clash with a standard field), and return it. */
function checked(object: string, ext: OrgObjectExtension): OrgObjectExtension {
  if (!resolveOrgObject(object, ext)) throw new RegistryError(`No object ${object}`);
  return ext;
}

/** A formula or rollup field's computed shape, checked against `object` as `ext` defines it. Throws RegistryError. */
function computedShape(object: string, ext: OrgObjectExtension | undefined, rollup: boolean, spec: ComputeSpec | undefined, related: RelatedDefs) {
  const def = resolveOrgObject(object, ext);
  if (!def) throw new RegistryError(`No object ${object}`);
  try {
    if (rollup) {
      if (!spec?.rollup) throw new FormulaError("A rollup needs the records it reads");
      const r = spec.rollup;
      const source = { object: r.object, via: r.via, fn: r.fn, ...(r.field !== undefined ? { field: r.field } : {}) };
      const returns = checkRollup(object, source, related(r.object), spec.formula);
      return { type: "formula" as const, formula: spec.formula.trim(), returns, rollup: source };
    }
    if (!spec?.returns) throw new FormulaError("A formula needs the type of value it gives");
    // A register lists companies and people by registerListDef, which has no createdAt: check against the fields it evaluates.
    checkFormula(isRegisterObject(object) ? registerListDef(object, def) : def, spec.formula, spec.returns);
    return { type: "formula" as const, formula: spec.formula.trim(), returns: spec.returns };
  } catch (e) {
    if (e instanceof FormulaError) throw new RegistryError(e.message);
    throw e;
  }
}

const isComputed = (f: { type: string; archivedAt?: number }) => f.type === "formula" && f.archivedAt === undefined;

/**
 * Add a custom field. Its apiName and fieldId are `custom.<slug>` from the
 * label, made unique against every custom field the object has ever had
 * (archived ones keep theirs) and against `reserved` slugs (AI fields, which
 * register their own `custom.<slug>` when they first answer).
 */
export function addField(
  object: string, ext: OrgObjectExtension | undefined, spec: NewField, reserved: ReadonlySet<string> = new Set(), related: RelatedDefs = () => null,
): { ext: OrgObjectExtension; field: CustomField } {
  if (!(BUILDER_TYPES as readonly string[]).includes(spec.type)) throw new RegistryError(`${spec.type} is not a field type`);
  const label = cleanLabel(spec.label);
  const existing = ext?.customFields ?? [];
  if (existing.length >= CUSTOM_FIELDS_MAX) throw new RegistryError(`An object has at most ${CUSTOM_FIELDS_MAX} custom fields`);
  if (existing.some((f) => f.archivedAt === undefined && f.label.toLowerCase() === label.toLowerCase())) throw new RegistryError(`There is already a field named ${label}`);

  if (baseFields(object).some((f) => f.label.toLowerCase() === label.toLowerCase())) throw new RegistryError(`${label} is a standard field`);
  const slug = unique(slugOf(label), (s) => reserved.has(s) || existing.some((f) => f.apiName === `custom.${s}`));
  const apiName = `custom.${slug}`;
  if (!CUSTOM_FIELD_API_NAME.test(apiName)) throw new RegistryError(`Cannot name a field ${label}`);
  const common = { fieldId: apiName as FieldId, apiName, label };
  let field: CustomField;
  if (spec.type === "formula" || spec.type === "rollup") {
    if (existing.filter(isComputed).length >= COMPUTED_MAX) throw new RegistryError(`An object has at most ${COMPUTED_MAX} formula and rollup fields`);
    field = { ...common, ...computedShape(object, ext, spec.type === "rollup", spec.compute, related) };
  } else if (spec.type === "picklist" || spec.type === "multipicklist") field = { ...common, type: spec.type, options: editOptions([], spec.options ?? []) };
  else if (spec.type === "lookup") {
    if (!spec.lookupTo || !((LOOKUP_TARGETS as readonly string[]).includes(spec.lookupTo) || isCustomObjectName(spec.lookupTo))) throw new RegistryError("A lookup needs an object to point at");
    field = { ...common, type: "lookup", lookupTo: spec.lookupTo };
  } else field = { ...common, type: spec.type };
  return { ext: checked(object, next(ext, [...existing, field])), field };
}

function edit(object: string, ext: OrgObjectExtension | undefined, fieldId: string, change: (f: CustomField) => CustomField): OrgObjectExtension {
  const fields = ext?.customFields ?? [];
  const i = fields.findIndex((f) => f.fieldId === fieldId);
  if (i < 0) throw new RegistryError(`No custom field ${fieldId}`);
  return checked(object, next(ext, fields.map((f, j) => (j === i ? change(f) : f))));
}

/** Rename, hide or show a custom field, make it required, set its rules, or edit its picklist options. apiName and fieldId never change. */
export function updateField(object: string, ext: OrgObjectExtension | undefined, fieldId: string, patch: FieldPatch, related: RelatedDefs = () => null): OrgObjectExtension {
  return edit(object, ext, fieldId, (f) => {
    if (f.archivedAt !== undefined) throw new RegistryError(`${f.label} is archived; restore it first`);
    let out: CustomField = { ...f };
    if (patch.label !== undefined) {
      const label = cleanLabel(patch.label);
      if (ext!.customFields.some((o) => o.fieldId !== f.fieldId && o.archivedAt === undefined && o.label.toLowerCase() === label.toLowerCase())) {
        throw new RegistryError(`There is already a field named ${label}`);
      }
      out.label = label;
    }
    if (patch.hidden && ext!.object?.titleField === f.apiName) throw new RegistryError(`${f.label} is the name of this object; it cannot be hidden`);
    if (patch.hidden !== undefined) {
      const { hidden: _, ...rest } = out;
      out = patch.hidden ? { ...rest, hidden: true } : rest;
    }
    if (patch.required && object === "deal" && (out.type === "multipicklist" || isMultiValueType(out.type))) {
      throw new RegistryError(`${f.label} holds a list, which deals cannot store yet, so it cannot be required`);
    }
    if (patch.required && out.type === "formula") throw new RegistryError(`${f.label} is computed, so it cannot be required`);
    if (patch.compute !== undefined) {
      if (out.type !== "formula") throw new RegistryError(`${f.label} is not a formula or rollup field`);
      const { rollup: _, ...rest } = out;
      out = { ...rest, ...computedShape(object, ext, out.rollup !== undefined, patch.compute, related) };
    }
    if (patch.required !== undefined) {
      const { required: _, ...rest } = out;
      out = patch.required ? { ...rest, required: true } : rest;
    }
    if (patch.rules !== undefined) {
      try {
        checkRuleDefs(out.type, out.label, patch.rules);
      } catch (e) {
        throw new RegistryError((e as Error).message);
      }
      const { rules: _, ...rest } = out;
      out = patch.rules.length ? { ...rest, rules: [...patch.rules] } : rest;
    }
    if (patch.options !== undefined) {
      if (out.type !== "picklist" && out.type !== "multipicklist") throw new RegistryError(`${f.label} has no options`);
      out = { ...out, options: editOptions(out.options, patch.options) };
    }
    return out;
  });
}

/** Archive (delete) a custom field: it takes no writes and leaves views and forms; the ledger keeps its values. */
export function archiveField(object: string, ext: OrgObjectExtension | undefined, fieldId: string, now: number): OrgObjectExtension {
  return edit(object, ext, fieldId, (f) => {
    if (ext?.object?.titleField === f.apiName) throw new RegistryError(`${f.label} is the name of this object; it cannot be archived`);
    return f.archivedAt !== undefined ? f : { ...f, archivedAt: now };
  });
}

/** Bring an archived field back, with every value it held. */
export function restoreField(object: string, ext: OrgObjectExtension | undefined, fieldId: string): OrgObjectExtension {
  return edit(object, ext, fieldId, (f) => {
    if (ext!.customFields.some((o) => o.fieldId !== f.fieldId && o.archivedAt === undefined && o.label.toLowerCase() === f.label.toLowerCase())) {
      throw new RegistryError(`Rename the field named ${f.label} before restoring this one`);
    }
    const { archivedAt: _, ...rest } = f;
    return rest as CustomField;
  });
}

/** Whether a field is one the builder edits: a custom field that is not an AI field's answer. */
export const builderOwns = (f: Pick<FieldDef, "apiName">, aiSlugs: ReadonlySet<string>) =>
  CUSTOM_FIELD_API_NAME.test(f.apiName) && !aiSlugs.has(f.apiName.slice("custom.".length));
