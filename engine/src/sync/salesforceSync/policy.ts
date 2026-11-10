// Sync policy: which objects and fields sync, and who wins each field.
//
// The policy is built from the Convex fieldDefinitions rows (workstream A's
// metadata import). Standard objects map onto the record service's account
// and contact rows through STANDARD_FIELD_MAP; custom objects map field api
// name to field api name (the record service stores custom records keyed by
// Salesforce api names). DEFAULT_POLICY is used when no metadata is present.
import type { FieldRule, ObjectRule, SyncAuthority, SyncPolicy } from "./types.ts";

/** Salesforce object -> record-service object, and Salesforce field -> record-service field. */
export const STANDARD_FIELD_MAP: Record<string, { local: string; keyPrefix: string; fields: Record<string, string> }> = {
  Account: {
    local: "account",
    keyPrefix: "001",
    fields: { Name: "name", Industry: "industry", NumberOfEmployees: "employees", BillingCountry: "country" },
  },
  Contact: { local: "contact", keyPrefix: "003", fields: { Title: "title", Email: "email" } },
  Lead: { local: "contact", keyPrefix: "00Q", fields: { Title: "title", Email: "email" } },
};

/**
 * The field that names a record's parent of the same object, read with the object's synced fields. It is not a
 * field rule: the parent is Canon's `account_parent` edge, not a register column, so the engine hands it to
 * `EnginePorts.parents` instead of the record port.
 */
export const PARENT_FIELD: Record<string, string> = { Account: "ParentId" };

export const DEFAULT_POLICY: SyncPolicy = {
  objects: Object.entries(STANDARD_FIELD_MAP).map(([sf, m]) => ({
    sf,
    local: m.local,
    keyPrefix: m.keyPrefix,
    fields: Object.entries(m.fields).map(([sfField, local]) => ({ sf: sfField, local, authority: "newest" as SyncAuthority, updateable: true })),
  })),
};

export type ObjectDefinitionLike = { apiName: string; isCustom: boolean; syncEnabled: boolean };
export type FieldDefinitionLike = {
  object: string;
  apiName: string;
  updateable: boolean;
  syncAuthority: SyncAuthority;
  mappedTo?: string;
};

export function policyFromDefinitions(objects: ObjectDefinitionLike[], fields: FieldDefinitionLike[]): SyncPolicy {
  const out: ObjectRule[] = [];
  for (const o of objects) {
    if (!o.syncEnabled) continue;
    const std = STANDARD_FIELD_MAP[o.apiName];
    if (!o.isCustom && !std) continue; // standard objects without a record-service home are not synced
    const rules: FieldRule[] = [];
    for (const f of fields) {
      if (f.object !== o.apiName) continue;
      // Standard objects sync only the curated 1:1 fields in STANDARD_FIELD_MAP.
      // The metadata import's mappedTo also covers import-only mappings
      // (Website -> domain, FirstName/LastName -> fullName, OwnerId -> ownerId,
      // Lead Status -> status) that are not editable or not the same value
      // space in the record service, so it is not used for standard objects.
      const local = o.isCustom ? (f.mappedTo ?? f.apiName) : std?.fields[f.apiName];
      if (!local) continue;
      rules.push({ sf: f.apiName, local, authority: f.syncAuthority, updateable: f.updateable });
    }
    if (rules.length) out.push({ sf: o.apiName, local: o.isCustom ? o.apiName : std!.local, keyPrefix: std?.keyPrefix, fields: rules });
  }
  return { objects: out };
}
