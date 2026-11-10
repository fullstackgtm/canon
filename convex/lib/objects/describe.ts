/**
 * What `objects.describe` answers for one object, as a pure function of the
 * loaded definition and the caller's access: the fields their role sees, which
 * of those they may not write, and the verbs they may use. The record API's
 * OpenAPI document (src/app/api/v1/_openapi.ts) is built from the same answer,
 * so the document cannot promise a field or a verb the routes refuse.
 */
import { hiddenFields, lockedFields, may, type Access, type RecordOp } from "../access.ts";
import { builderOwns } from "./fieldBuilder.ts";
import { ICP_FIELDS, isRegisterObject, registerListDef } from "./listSpec.ts";
import { plainObjectDef, type ObjectDef, type PicklistOption, type ResolvedObjectDef } from "./registry.ts";
import { EDITABLE_ACCOUNT_FIELDS, EDITABLE_CONTACT_FIELDS } from "../recordContract.ts";
import { isStandardEditField } from "../canon/partyLedger.ts";
import { LEDGER_OBJECTS } from "./write.ts";
import { isCustomObjectName } from "../../../modules/kernel/reportLanguage.ts";

/**
 * Objects whose records are created, deleted and restored by stream id: the generic standard ones and an org's own
 * custom objects (CP7d).
 */
export const isGenericObject = (o: string) => (LEDGER_OBJECTS as readonly string[]).includes(o) || isCustomObjectName(o);
/**
 * Objects `write` and `bulk` edit: the generic ones, plus deals, which save through their own writer
 * (`saveDealValues`) so the `deals` row and the `facts` mirror stay in step.
 */
export const EDITABLE_OBJECTS = [...LEDGER_OBJECTS, "deal"] as const;
/**
 * Deal fields the generic pages show but do not write: the CRM owner id is the CRM's identity, not a Canon user
 * (owner changes go through ownership.ts), and closed and won follow the forecast category.
 */
export const DEAL_READ_ONLY = ["crmOwnerId", "isClosed", "isWon"] as const;
/** Lead fields a conversion sets (convex/leadConversion.ts): shown on the generic pages, never typed or bulk-set there. */
export const LEAD_READ_ONLY = ["convertedAt", "convertedAccountId", "convertedContactId", "convertedDealId"] as const;
/** The line item fields a person or agent sets; the rest are derived from them. */
export const LINE_INPUT_FIELDS = ["dealId", "productId", "quantity", "unitPrice", "totalPrice", "position"];

export type DescribedObject = ObjectDef & {
  /** The generic list and record pages serve it. */
  pages: boolean;
  /** Accounts and contacts: listed from the register by record id, edited through records.edit. */
  register: boolean;
  /** The caller's role may list and read its records. */
  readable: boolean;
  writable: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** Every update, archive and restore must name the version it expects (a line item, objects.ts saveDealLinesAsCaller). */
  versionRequired: boolean;
  /** Fields the caller sees but may not write: computed, set by a conversion or the CRM, or locked for their role. */
  readOnlyFields: string[];
};

export type DescribeInput = {
  object: string;
  /** The org's definition: a standard object with its extension, or a custom object. Archived objects never get here. */
  def: ResolvedObjectDef;
  access: Access | null;
  /** The caller holds `deals.write` (admins and managers): deals, line items and register deletes follow it. */
  dealsWrite: boolean;
  /** The workspace's saved ICPs, the options of the register's ICP columns. */
  icpOptions: readonly PicklistOption[];
  /** The slugs of the org's AI fields, whose answers come from runs, not edits. */
  aiSlugs: ReadonlySet<string>;
};

export function describeObject({ object, def: loaded, access, dealsWrite, icpOptions, aiSlugs }: DescribeInput): DescribedObject {
  // What the caller's role allows on the object (CP14); a page offers only that.
  const allows = (op: RecordOp) => access !== null && may(access, object, op);
  const hiddenSet = new Set(access ? hiddenFields(access, object) : []);
  const locked = access ? lockedFields(access, object).filter((f) => !hiddenSet.has(f)) : [];
  if (isRegisterObject(object)) {
    // Accounts and contacts list from the register, by record-service id; an edit goes through records.edit, which
    // promotes an unworked row onto the ledger, as a delete does (records.bulkRegister). Created on their own pages for now.
    const listed = registerListDef(object, loaded);
    const fields = listed.fields.filter((f) => !hiddenSet.has(f.apiName)).map((f) => (ICP_FIELDS.includes(f.apiName) ? { ...f, options: icpOptions } : f));
    const editable: readonly string[] = object === "account" ? EDITABLE_ACCOUNT_FIELDS : EDITABLE_CONTACT_FIELDS;
    // Custom fields are edited through records.edit too, except an AI field's answers, which come from its runs.
    // A formula or rollup field (CP7c) is computed, never edited.
    const mayEdit = (f: { apiName: string; type: string }) => f.type !== "formula" && (editable.includes(f.apiName) || isStandardEditField(object, f.apiName) || builderOwns(f, aiSlugs));
    return {
      ...plainObjectDef({ ...listed, fields }), pages: true, register: true, readable: allows("read"), writable: allows("edit"), canCreate: false, versionRequired: false,
      // Only admins and managers delete and restore, as deals are edited.
      canDelete: dealsWrite && allows("delete"),
      readOnlyFields: [...fields.filter((f) => !f.system && !mayEdit(f)).map((f) => f.apiName), ...locked],
    };
  }
  // An archived field leaves forms, views and the API; the ledger keeps its values.
  const def = plainObjectDef({ ...loaded, fields: loaded.fields.filter((f) => f.archivedAt === undefined && !hiddenSet.has(f.apiName)) });
  const generic = isGenericObject(object);
  const editable = (EDITABLE_OBJECTS as readonly string[]).includes(object) || isCustomObjectName(object);
  // Deal edits and creates follow the Deals page's rule: admins and managers.
  const mayEdit = object === "lineItem" ? dealsWrite && allows("read") && access !== null && may(access, "deal", "edit") : object !== "deal" || dealsWrite;
  return {
    ...def, pages: editable && object !== "lineItem", register: false, readable: allows("read"), writable: editable && mayEdit && allows("edit"), versionRequired: object === "lineItem",
    canCreate: (generic || object === "deal") && mayEdit && allows("create"), canDelete: (generic || object === "deal") && mayEdit && allows("delete"),
    readOnlyFields: [...(object === "deal" ? DEAL_READ_ONLY : object === "lead" ? LEAD_READ_ONLY : object === "lineItem" ? def.fields.filter((f) => !LINE_INPUT_FIELDS.includes(f.apiName)).map((f) => f.apiName) : []), ...def.fields.filter((f) => f.type === "formula").map((f) => f.apiName), ...locked],
  };
}
