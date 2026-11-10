/**
 * Describe-driven metadata import: every queryable object and every field,
 * with a default sync authority per field. Pure over an SfConn, so the
 * Convex action and the simulator tests run the same code.
 */
import { describeGlobal, describeSObject, type SfConn, type SFieldDescribe, type SObjectDescribe, type SObjectSummary } from "./client.ts";

export type SyncAuthority = "fsgtm" | "salesforce" | "newest" | "review";
export type RecordFieldType = "string" | "number" | "boolean" | "date" | "datetime" | "picklist" | "reference" | "json";

export type ObjectMeta = {
  apiName: string;
  label: string;
  isCustom: boolean;
  syncEnabled: boolean;
  queryable: boolean;
};

export type FieldMeta = {
  object: string;
  apiName: string;
  label: string;
  type: string; // Salesforce type
  picklistValues?: string[];
  referenceTo?: string[];
  updateable: boolean;
  syncAuthority: SyncAuthority;
  mappedTo?: string;
};

/** Standard objects synced by default (plus every custom object). */
export const DEFAULT_SYNCED_STANDARD = ["Account", "Contact", "Lead", "Opportunity", "User"];
/** Objects with typed record-service tables; the rest are stored as generic records. */
export const TYPED_OBJECTS = ["Account", "Contact"];

/** System audit fields Salesforce owns. */
export const SYSTEM_FIELDS = new Set([
  "Id", "IsDeleted", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "SystemModstamp", "LastActivityDate",
  "LastViewedDate", "LastReferencedDate", "MasterRecordId", "ConnectionReceivedId", "ConnectionSentId", "RecordTypeId",
]);

/** Salesforce field -> record-service field, for the typed objects and Lead. */
export const FIELD_MAP: Record<string, Record<string, string>> = {
  Account: { Name: "name", Website: "domain", Industry: "industry", NumberOfEmployees: "employees", BillingCountry: "country", OwnerId: "ownerId" },
  Contact: { FirstName: "fullName", LastName: "fullName", Title: "title", Email: "email", AccountId: "accountId" },
  Lead: { FirstName: "fullName", LastName: "fullName", Title: "title", Email: "email", Website: "accountDomain", Company: "accountName", Status: "status" },
};

/** Fields CanonCRM owns: fit/ICP scores and lifecycle status. */
const FSGTM_OWNED = /(^|_)(fit|icp)(_?score)?(__c)?$|^fsgtm_/i;

/**
 * Default authority:
 * - owner, system, and non-updateable (incl. formula) fields: salesforce
 * - fit and status fields: fsgtm
 * - everything else: newest (last writer by timestamp wins)
 */
export function defaultSyncAuthority(object: string, f: Pick<SFieldDescribe, "name" | "updateable" | "calculated">): SyncAuthority {
  if (f.name === "OwnerId" || SYSTEM_FIELDS.has(f.name) || !f.updateable || f.calculated) return "salesforce";
  const mapped = FIELD_MAP[object]?.[f.name];
  if (mapped === "status" || mapped === "fit" || FSGTM_OWNED.test(f.name)) return "fsgtm";
  return "newest";
}

/** Salesforce field type -> record-service ObjectDef field type. */
export function recordFieldType(sfType: string): RecordFieldType {
  switch (sfType) {
    case "int": case "double": case "currency": case "percent": case "long":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "picklist": case "multipicklist": case "combobox":
      return "picklist";
    case "reference": case "id":
      return "reference";
    case "address": case "location": case "complexvalue":
      return "json";
    default:
      return "string";
  }
}

export function isSyncedByDefault(o: Pick<SObjectSummary, "name" | "custom" | "customSetting">) {
  return DEFAULT_SYNCED_STANDARD.includes(o.name) || (o.custom && !o.customSetting && o.name.endsWith("__c"));
}

export function fieldMeta(object: string, f: SFieldDescribe): FieldMeta {
  const picks = (f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value);
  const mapped = FIELD_MAP[object]?.[f.name];
  return {
    object, apiName: f.name, label: f.label, type: f.type, updateable: f.updateable && !f.calculated,
    syncAuthority: defaultSyncAuthority(object, f),
    ...(picks.length ? { picklistValues: picks.slice(0, 1000) } : {}),
    ...(f.referenceTo?.length ? { referenceTo: f.referenceTo } : {}),
    ...(mapped ? { mappedTo: mapped } : {}),
  };
}

/** Record-service ObjectDef for a described object (system fields included, compound fields as json). */
export function objectDef(d: Pick<SObjectDescribe, "name" | "label" | "fields">) {
  return {
    name: d.name,
    label: d.label,
    fields: d.fields
      .filter((f) => f.name !== "Id")
      .map((f) => ({ name: f.name, type: recordFieldType(f.type), ...(f.referenceTo?.length ? { referenceTo: f.referenceTo.slice(0, 50) } : {}) })),
  };
}

export type MetadataImport = { objects: ObjectMeta[]; fields: FieldMeta[]; described: SObjectDescribe[]; failed: Array<{ apiName: string; error: string }> };

/**
 * describeGlobal + describe every queryable object (bounded concurrency).
 * `onObject` is called per described object so callers can persist as they go.
 */
export async function importMetadataCore(
  c: SfConn,
  o: { concurrency?: number; only?: string[]; onObject?: (meta: ObjectMeta, fields: FieldMeta[], d: SObjectDescribe) => Promise<void> } = {},
): Promise<MetadataImport> {
  const all = await describeGlobal(c);
  const targets = all.filter((s) => s.queryable && (!o.only || o.only.includes(s.name)));
  const out: MetadataImport = { objects: [], fields: [], described: [], failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const s = targets[next++];
      try {
        const d = await describeSObject(c, s.name);
        const meta: ObjectMeta = { apiName: s.name, label: s.label, isCustom: s.custom, syncEnabled: isSyncedByDefault(s), queryable: s.queryable };
        const fields = d.fields.map((f) => fieldMeta(s.name, f));
        if (o.onObject) await o.onObject(meta, fields, d);
        out.objects.push(meta);
        out.fields.push(...fields);
        out.described.push(d);
      } catch (e) {
        out.failed.push({ apiName: s.name, error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 8, targets.length || 1) }, worker));
  out.objects.sort((a, b) => a.apiName.localeCompare(b.apiName));
  return out;
}
