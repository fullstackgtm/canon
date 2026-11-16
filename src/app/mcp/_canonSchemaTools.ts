import { v, type GenericValidator } from "convex/values";
import { api } from "../../../convex/_generated/api.js";
import * as shapes from "../../../convex/lib/objects/validators.ts";
import { CUSTOM_FIELDS_MAX, LABEL_MAX, OPTIONS_MAX, LOOKUP_TARGETS } from "../../../convex/lib/objects/fieldBuilder.ts";
import { CUSTOM_OBJECTS_MAX } from "../../../convex/lib/objects/customObjects.ts";
import { MAX_STAGES, MAX_LABEL } from "../../../convex/lib/pipelines.ts";
import { COMPUTED_MAX, FORMULA_MAX, FUNCTIONS } from "../../../convex/lib/objects/formula.ts";
import { PICKLIST_COLORS } from "../../../convex/lib/objects/registry.ts";
import { groupTool, m, q } from "./_canonJobTools.ts";
import type { CanonTool } from "./_canonTools.ts";

// Render the validators themselves, including nested unions, rather than maintaining a second schema.
export function argsText(fields: Record<string, GenericValidator>): string {
  return shapeText(v.object(fields));
}
function shapeText(shape: GenericValidator): string {
  switch (shape.kind) {
    case "object": return `{ ${Object.entries(shape.fields as Record<string, GenericValidator>).map(([key, field]) => `${key}${field.isOptional === "optional" ? "?" : ""}: ${shapeText(field)}`).join(", ")} }`;
    case "union": return shape.members.map(shapeText).join(" | ");
    case "array": return `(${shapeText(shape.element)})[]`;
    case "literal": return JSON.stringify(shape.value);
    case "id": return `id<${shape.tableName}>`;
    case "float64": return "number";
    default: return shape.kind;
  }
}

export const schemaActions = {
  objects: q(api.dataModel.objects),
  fields: q(api.dataModel.fields, "{ object: string } (includes rollupSources for compute.rollup)"),
  create_object: m(api.customObjects.create, argsText(shapes.customObjectsCreateArgs)),
  edit_object: m(api.customObjects.edit, argsText(shapes.customObjectsEditArgs)),
  archive_object: m(api.customObjects.setArchived, argsText(shapes.customObjectsSetArchivedArgs)),
  rename_standard_object: m(api.dataModel.relabel, argsText(shapes.dataModelRelabelArgs)),
  create_field: m(api.dataModel.createField, argsText(shapes.dataModelCreateFieldArgs)),
  update_field: m(api.dataModel.updateFieldDef, argsText(shapes.dataModelUpdateFieldDefArgs)),
  archive_field: m(api.dataModel.setArchived, argsText(shapes.dataModelSetArchivedArgs)),
  pipelines: q(api.pipelines.list),
  save_pipeline: m(api.pipelines.save, argsText(shapes.pipelinesSaveArgs)),
  history: q(api.dataModel.history, "{ limit?: number } (default 50, integer 1–200; newest first; needs dataModel.edit)"),
};
export const canonSchemaTools: CanonTool[] = [
  groupTool("canon_data_model", `Define the workspace's objects, fields and deal pipelines directly. Needs a role that may edit the data model (admins); pipelines use pipelines.edit. Custom objects are custom_<slug>, custom fields custom.<slug>; ids never change on rename. Every edit is logged. Read objects, fields and pipelines first.
Labels are trimmed and whitespace collapsed, 1–${LABEL_MAX} characters; object names must be distinct from existing and reserved standard names. At most ${CUSTOM_OBJECTS_MAX} custom objects (including archived), ${CUSTOM_FIELDS_MAX} custom fields per object (including archived). titleLabel names a new object's required primary text field custom.name. archived:false restores; archiving preserves values. Empty label and pluralLabel together reset a standard object's names.
Picklists need 1–${OPTIONS_MAX} options with distinct labels and at least one active option. On update send the full ordered options list, preserving every existing value; active:false retires an option. Omit value for a new option (generated from label). color is one of ${PICKLIST_COLORS.join(", ")}. lookupTo is an object apiName (${LOOKUP_TARGETS.join(", ")} or a live custom_<slug>), not a record id. multiline is for text. Field types cannot be changed. rules replaces all rules; [] clears them. unique:true starts a background duplicate check.
Computed fields are limited to ${COMPUTED_MAX} per object; expressions to ${FORMULA_MAX} characters. Functions: ${FUNCTIONS.join(", ")}; arithmetic, comparisons, and/or/not are supported. Formulas read and return currency in whole units. For type formula, compute is {formula: an expression using field apiNames, returns: its value type}; e.g. {formula:"amount * 2",returns:"currency"}. For rollup, compute is {formula:"",rollup:{object: source object apiName,via: its lookup field apiName pointing here,fn: aggregate,field: source field apiName}}; formula is a filter over source records (empty means all), field is omitted for count. Use fields.rollupSources to choose a supported source and field.
Pipeline save replaces the full ordered stage list: preserve every existing stage value, no removing or stealing another pipeline's stage. pipelineId:null creates a pipeline; "default" edits the virtual default (id:null from pipelines); otherwise use its id. A stage value:null creates a new stage with a generated value; existing values retain identity on rename. 1–${MAX_STAGES} stages, names 1–${MAX_LABEL} characters, probability an integer percent 0–100.`, schemaActions, { destructive: true }),
  {
    name: "canon_members", description: "List the workspace's members: id, name, email, role, title (when set), and isActive. Use ids for owners and user fields.",
    inputSchema: {}, writes: false,
    run: async (convex) => (await convex.query(api.users.list, {})).map((user) => ({ id: user._id, name: user.name, email: user.email, role: user.role, ...(user.title ? { title: user.title } : {}), isActive: user.isActive })),
  },
];
