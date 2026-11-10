/**
 * The object registry (docs/cp0-object-layer.md, "Registry"): what objects
 * exist, which fields they have, and how raw input becomes typed field values.
 *
 * Pure: no database access, no Node-only imports. Standard objects are defined
 * here in code; an org's `objectDefs` row extends one with custom fields.
 */
import type { ComputedType, RollupDef } from "./formula.ts";
import { parseSplits, type SplitAllocation } from "./splits.ts";
import { checkRules, RULE_NAMES, type FieldRule, type RuleKind } from "./rules.ts";

export type FieldType =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "checkbox"
  | "picklist"
  | "multipicklist"
  | "lookup"
  | "user"
  | "emails"
  | "phones"
  | "links"
  | "splits"
  | "formula";

/** Field types that hold several values, the first one primary: a person's emails, phones and links (CP7a). */
export const MULTI_VALUE_TYPES = ["emails", "phones", "links"] as const;
export type MultiValueType = (typeof MULTI_VALUE_TYPES)[number];
export const isMultiValueType = (t: FieldType): t is MultiValueType => (MULTI_VALUE_TYPES as readonly string[]).includes(t);
/** The most values one multi-value field holds. */
export const MULTI_VALUES_MAX = 20;

/** The stable key of a field: never renamed, the hot-row key and the DuckDB column `c_<fieldId>`. */
export type FieldId = string & { readonly __brand: "FieldId" };

/**
 * A stored field value. Dates are `YYYY-MM-DD`, datetimes epoch ms,
 * multi-picklists a sorted, de-duplicated string array, and multi-value
 * fields (emails, phones, links) an ordered, de-duplicated array whose first
 * item is the primary. `null` is empty.
 */
export type FieldValue = string | number | boolean | null | readonly string[] | readonly SplitAllocation[];

/** An option's colour on chips and boards, from a fixed palette. */
export const PICKLIST_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type PicklistColor = (typeof PICKLIST_COLORS)[number];

/** `value` is stored and never changes; `label` and `color` may. An inactive option keeps its stored values but takes no new ones. Order is array order. */
export type PicklistOption = { value: string; label: string; active: boolean; color?: string };

/** The per-type part of a field. Options exist only on picklists, a target only on lookups. */
export type FieldShape =
  | { type: "text" | "number" | "currency" | "date" | "datetime" | "checkbox" | "user" | "splits" | MultiValueType }
  | { type: "picklist" | "multipicklist"; options: readonly PicklistOption[] }
  | { type: "lookup"; lookupTo: string }
  /**
   * A computed field (CP7c, formula.ts), never written and never in the ledger.
   * Without `rollup`, `formula` is an expression over the record's fields; with
   * one, it filters the related records the rollup reads ("" for all).
   */
  | { type: "formula"; formula: string; returns: ComputedType; rollup?: RollupDef };

type FieldCommon = {
  fieldId: FieldId;
  apiName: string;
  label: string;
  required?: boolean;
  /** Checks on a custom field's value (CP7b, rules.ts), run by `coerce` on every write. */
  rules?: readonly FieldRule[];
  /** Enforced by the writer against an index; `coerce` cannot see other records. */
  unique?: boolean;
  /** Maintained by the object layer itself (timestamps); never writable. */
  system?: boolean;
  /** A custom field left off record pages and the column chooser; its values are still stored, listed and written. */
  hidden?: boolean;
  /**
   * When an admin archived (deleted) this custom field. Its values stay in the
   * ledger and its history, but it takes no writes and leaves list columns,
   * views and forms. Archived fields stay in the definition so the projection
   * keeps their columns and a restore loses nothing.
   */
  archivedAt?: number;
};

export type FieldDef = FieldCommon & FieldShape;

export type ObjectDef = {
  apiName: string;
  label: string;
  pluralLabel: string;
  kind: "standard" | "custom";
  /** A custom object's icon (OBJECT_ICONS). */
  icon?: string;
  /** When an admin archived this custom object: its records are kept, but it takes no writes and leaves the nav, search and the API. */
  archivedAt?: number;
  /** `all` keeps a Convex hot row for every record; `onDemand` only for records being read. */
  residency: "all" | "onDemand";
  /** `ledger` for editable records, `eventLog` for synced activity the provider can re-send. */
  storage: "ledger" | "eventLog";
  titleFieldId: FieldId;
  fields: readonly FieldDef[];
  registryVersion: number;
};

export type ResolvedObjectDef = ObjectDef & {
  byApiName: ReadonlyMap<string, FieldDef>;
  byFieldId: ReadonlyMap<FieldId, FieldDef>;
};

export type AssociationName = "contact_account" | "deal_contact" | "deal_account" | "account_parent" | "activity_target";

export type AssociationDef = {
  apiName: AssociationName;
  from: StandardObjectName | readonly StandardObjectName[];
  to: StandardObjectName | readonly StandardObjectName[];
  cardinality: "oneToOne" | "manyToOne" | "manyToMany";
  /** Role labels an edge may carry (empty when the edge is unlabeled). */
  labels: readonly string[];
  /** Whether one edge per `from` record can be flagged primary. */
  primary: boolean;
};

/**
 * A standard field as written in code: its `fieldId` is its apiName, because
 * standard apiNames never change. The fields the per-field `facts` ledger
 * tracks are the kernel's FACT_ATTRIBUTES (modules/kernel/facts.ts), each one
 * of these fields.
 */
type StandardFieldSpec = Omit<FieldCommon, "fieldId"> & FieldShape;

type StandardObjectSpec = Omit<ObjectDef, "kind" | "titleFieldId" | "fields" | "registryVersion"> & {
  titleField: string;
  fields: readonly StandardFieldSpec[];
};

/**
 * What makes an `objectDefs` row an object of the org's own (CP7d) rather than
 * an extension of a standard one. The row's apiName is `custom_<slug>`, chosen
 * once and never changed: a rename changes only the labels. `titleField` is the
 * apiName of the primary name field (`custom.<slug>`, in `customFields`).
 * An archived object keeps its records and projection but leaves the nav,
 * search and the API, and takes no writes.
 */
export type CustomObjectMeta = { label: string; pluralLabel: string; icon: string; titleField: string; archivedAt?: number };

/** An org's extension of a standard object (its `objectDefs` row), or the whole definition of a custom one (`object`). */
export type OrgObjectExtension = {
  registryVersion: number;
  object?: CustomObjectMeta;
  customFields: readonly (Omit<FieldCommon, "system"> & FieldShape)[];
  /** Replaces the options of standard picklist fields, keyed by apiName (e.g. an org's own deal stages). */
  picklistOptions?: Readonly<Record<string, readonly PicklistOption[]>>;
  /** A standard object's own name in this org (People called Contacts); a custom object's names are in `object`. */
  labels?: ObjectLabels;
};

export type ObjectLabels = { label: string; pluralLabel: string };

/** `custom.<slug>`: the apiName of an org-defined field. */
export const CUSTOM_FIELD_API_NAME = /^custom\.[a-z][a-z0-9_]{0,62}$/;

/** `custom_<slug>`: the apiName of an org-defined object, stable like a field's. It is a safe SQL identifier (the projection table is `p_custom_<slug>`). */
export const CUSTOM_OBJECT_API_NAME = /^custom_[a-z][a-z0-9_]{0,39}$/;
export const isCustomObjectName = (name: string): boolean => CUSTOM_OBJECT_API_NAME.test(name);

/** The icons an admin picks from for a custom object (lucide names, mapped in src/components/records/object-icons.ts). */
export const OBJECT_ICONS = ["folder", "briefcase", "box", "calendar", "flag", "star", "heart", "file", "users", "building", "tag", "wrench"] as const;
export type ObjectIcon = (typeof OBJECT_ICONS)[number];

const options = (...entries: Array<[value: string, label: string]>): readonly PicklistOption[] =>
  entries.map(([value, label]) => ({ value, label, active: true }));

const TIMESTAMPS = [
  { apiName: "createdAt", label: "Created", type: "datetime", system: true },
  { apiName: "updatedAt", label: "Last modified", type: "datetime", system: true },
] as const;

const OWNER = { apiName: "ownerId", label: "Owner", type: "user" } as const;

/** A lead's status, and a contact's lead status (HubSpot's property of that name). */
const LEAD_STATUSES = options(["new", "New"], ["working", "Working"], ["nurturing", "Nurturing"], ["qualified", "Qualified"], ["unqualified", "Unqualified"]);

const DIRECTION = options(["inbound", "Inbound"], ["outbound", "Outbound"]);

/**
 * What an activity is about, as Salesforce's WhoId and WhatId. Account and
 * contact ids are the register's (`acc_…`, `con_…`): a row keeps its id when
 * its first edit promotes it onto the ledger, and an unworked row has no stream.
 */
const ACTIVITY_LINKS = [
  { apiName: "accountId", label: "Account", type: "lookup", lookupTo: "account" },
  { apiName: "contactId", label: "Person", type: "lookup", lookupTo: "contact" },
  { apiName: "dealId", label: "Opportunity", type: "lookup", lookupTo: "deal" },
] as const;

export const STANDARD_OBJECTS = {
  account: {
    apiName: "account", label: "Account", pluralLabel: "Accounts", residency: "onDemand", storage: "ledger", titleField: "name",
    fields: [
      { apiName: "name", label: "Account name", type: "text", required: true },
      { apiName: "domain", label: "Domain", type: "text", unique: true },
      { apiName: "industry", label: "Industry", type: "text" },
      { apiName: "employees", label: "Employees", type: "number" },
      { apiName: "annualRevenue", label: "Annual revenue", type: "currency" },
      { apiName: "country", label: "Country", type: "text" },
      { apiName: "linkedinUrl", label: "LinkedIn URL", type: "text" },
      { ...OWNER, label: "Account owner" },
      { apiName: "status", label: "Status", type: "picklist", options: options(["new", "New"], ["working", "Working"], ["qualified", "Qualified"], ["disqualified", "Disqualified"]) },
      { apiName: "phone", label: "Phone", type: "text" },
      { apiName: "city", label: "City", type: "text" },
      { apiName: "description", label: "Description", type: "text" },
      ...TIMESTAMPS,
    ],
  },
  contact: {
    apiName: "contact", label: "Person", pluralLabel: "People", residency: "onDemand", storage: "ledger", titleField: "fullName",
    fields: [
      { apiName: "fullName", label: "Full name", type: "text" },
      { apiName: "title", label: "Job title", type: "text" },
      // A person's primary email: the identity key the record is found by.
      { apiName: "email", label: "Email", type: "text", unique: true },
      // Every other email they use (PRIMARY_LISTS). Each one is claimed and identifies them as their primary does.
      { apiName: "additionalEmails", label: "Additional emails", type: "emails", unique: true },
      { apiName: "phone", label: "Phone", type: "text" },
      { apiName: "additionalPhones", label: "Additional phones", type: "phones" },
      { apiName: "linkedinUrl", label: "LinkedIn URL", type: "text" },
      { ...OWNER, label: "Contact owner" },
      {
        apiName: "lifecycleStage", label: "Lifecycle stage", type: "picklist",
        options: options(["subscriber", "Subscriber"], ["lead", "Lead"], ["mql", "Marketing qualified"], ["sql", "Sales qualified"], ["opportunity", "Opportunity"], ["customer", "Customer"], ["evangelist", "Evangelist"], ["other", "Other"]),
      },
      // The same picklist as a lead's `status`, so a conversion carries it across (lib/objects/leadConversion.ts).
      { apiName: "leadStatus", label: "Lead status", type: "picklist", options: LEAD_STATUSES },
      ...TIMESTAMPS,
    ],
  },
  deal: {
    apiName: "deal", label: "Opportunity", pluralLabel: "Opportunities", residency: "all", storage: "ledger", titleField: "name",
    fields: [
      { apiName: "name", label: "Opportunity name", type: "text", required: true },
      // A register id (`acc_…`), as on activities. Not `accountId`: the deals row already has that column, for the CRM mirror.
      { apiName: "companyId", label: "Account", type: "lookup", lookupTo: "account" },
      { apiName: "amount", label: "Amount", type: "currency" },
      { apiName: "currency", label: "Currency", type: "text", required: true },
      { apiName: "closeDate", label: "Close date", type: "date", required: true },
      {
        apiName: "stage", label: "Stage", type: "picklist",
        options: options(["prospecting", "Prospecting"], ["qualification", "Qualification"], ["proposal", "Proposal"], ["negotiation", "Negotiation"], ["closed_won", "Closed won"], ["closed_lost", "Closed lost"]),
      },
      {
        apiName: "forecastCategory", label: "Forecast category", type: "picklist",
        options: options(["omit", "Omitted"], ["pipeline", "Pipeline"], ["best_case", "Best case"], ["commit", "Commit"], ["closed_won", "Closed won"], ["closed_lost", "Closed lost"]),
      },
      { apiName: "probability", label: "Probability", type: "number" },
      { apiName: "isClosed", label: "Closed", type: "checkbox", required: true },
      { apiName: "isWon", label: "Won", type: "checkbox", required: true },
      // The owner is a Canon member and the deal row's `primaryRepId` (convex/lib/canon/dealLedger.ts); the CRM's own owner id is read-only.
      { ...OWNER, label: "Deal owner" },
      { apiName: "crmOwnerId", label: "CRM owner", type: "user" },
      {
        apiName: "dealType", label: "Deal type", type: "picklist", required: true,
        options: options(["new_business", "New business"], ["expansion", "Expansion"], ["renewal", "Renewal"], ["one_time", "One time"]),
      },
      { apiName: "nextStep", label: "Next step", type: "text" },
      { apiName: "splitAllocations", label: "Credit splits", type: "splits" },
      { apiName: "description", label: "Description", type: "text" },
      ...TIMESTAMPS,
    ],
  },
  lead: {
    apiName: "lead", label: "Lead", pluralLabel: "Leads", residency: "onDemand", storage: "ledger", titleField: "lastName",
    fields: [
      { apiName: "firstName", label: "First name", type: "text" },
      { apiName: "lastName", label: "Last name", type: "text", required: true },
      { apiName: "company", label: "Company", type: "text" },
      { apiName: "title", label: "Job title", type: "text" },
      { apiName: "email", label: "Email", type: "text" },
      { apiName: "phone", label: "Phone", type: "text" },
      { apiName: "status", label: "Lead status", type: "picklist", options: LEAD_STATUSES },
      { apiName: "leadSource", label: "Lead source", type: "text" },
      OWNER,
      // Set by converting the lead (convex/leadConversion.ts), never typed: when, and the company, person and deal it became.
      { apiName: "convertedAt", label: "Converted", type: "datetime" },
      { apiName: "convertedAccountId", label: "Converted to company", type: "lookup", lookupTo: "account" },
      { apiName: "convertedContactId", label: "Converted to person", type: "lookup", lookupTo: "contact" },
      { apiName: "convertedDealId", label: "Converted to deal", type: "lookup", lookupTo: "deal" },
      ...TIMESTAMPS,
    ],
  },
  task: {
    apiName: "task", label: "Task", pluralLabel: "Tasks", residency: "all", storage: "ledger", titleField: "subject",
    fields: [
      { apiName: "subject", label: "Subject", type: "text", required: true },
      {
        apiName: "status", label: "Status", type: "picklist",
        options: options(["not_started", "Not started"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["completed", "Completed"], ["deferred", "Deferred"]),
      },
      { apiName: "priority", label: "Priority", type: "picklist", options: options(["low", "Low"], ["normal", "Normal"], ["high", "High"]) },
      { apiName: "dueDate", label: "Due date", type: "date" },
      { apiName: "description", label: "Description", type: "text" },
      OWNER,
      ...ACTIVITY_LINKS,
      ...TIMESTAMPS,
    ],
  },
  note: {
    apiName: "note", label: "Note", pluralLabel: "Notes", residency: "onDemand", storage: "ledger", titleField: "body",
    fields: [
      { apiName: "body", label: "Note", type: "text", required: true },
      OWNER,
      ...ACTIVITY_LINKS,
      ...TIMESTAMPS,
    ],
  },
  call: {
    apiName: "call", label: "Call", pluralLabel: "Calls", residency: "onDemand", storage: "ledger", titleField: "subject",
    fields: [
      { apiName: "subject", label: "Subject", type: "text" },
      { apiName: "direction", label: "Direction", type: "picklist", options: DIRECTION },
      {
        apiName: "outcome", label: "Outcome", type: "picklist",
        options: options(["connected", "Connected"], ["no_answer", "No answer"], ["left_voicemail", "Left voicemail"], ["busy", "Busy"], ["wrong_number", "Wrong number"]),
      },
      { apiName: "callAt", label: "Call time", type: "datetime" },
      { apiName: "durationSeconds", label: "Duration (seconds)", type: "number" },
      { apiName: "notes", label: "Notes", type: "text" },
      { apiName: "recordingUrl", label: "Recording URL", type: "text" },
      OWNER,
      ...ACTIVITY_LINKS,
      ...TIMESTAMPS,
    ],
  },
  meeting: {
    apiName: "meeting", label: "Meeting", pluralLabel: "Meetings", residency: "onDemand", storage: "ledger", titleField: "title",
    fields: [
      { apiName: "title", label: "Title", type: "text", required: true },
      { apiName: "startAt", label: "Start time", type: "datetime", required: true },
      { apiName: "endAt", label: "End time", type: "datetime" },
      { apiName: "location", label: "Location", type: "text" },
      {
        apiName: "outcome", label: "Outcome", type: "picklist",
        options: options(["scheduled", "Scheduled"], ["completed", "Completed"], ["rescheduled", "Rescheduled"], ["no_show", "No show"], ["canceled", "Canceled"]),
      },
      { apiName: "notes", label: "Notes", type: "text" },
      OWNER,
      ...ACTIVITY_LINKS,
      ...TIMESTAMPS,
    ],
  },
  email: {
    apiName: "email", label: "Email", pluralLabel: "Emails", residency: "onDemand", storage: "eventLog", titleField: "subject",
    fields: [
      { apiName: "subject", label: "Subject", type: "text" },
      { apiName: "direction", label: "Direction", type: "picklist", options: DIRECTION },
      { apiName: "sentAt", label: "Sent", type: "datetime" },
      { apiName: "fromAddress", label: "From", type: "text" },
      { apiName: "toAddresses", label: "To", type: "text" },
      { apiName: "bodyText", label: "Body", type: "text" },
      OWNER,
      ...TIMESTAMPS,
    ],
  },
  product: {
    apiName: "product", label: "Product", pluralLabel: "Products", residency: "all", storage: "ledger", titleField: "name",
    fields: [
      { apiName: "name", label: "Product name", type: "text", required: true },
      { apiName: "sku", label: "SKU", type: "text", unique: true },
      { apiName: "family", label: "Product family", type: "text" },
      { apiName: "unitPrice", label: "Unit price", type: "currency" },
      { apiName: "active", label: "Active", type: "checkbox" },
      { apiName: "description", label: "Description", type: "text" },
      ...TIMESTAMPS,
    ],
  },
  lineItem: {
    apiName: "lineItem", label: "Line item", pluralLabel: "Line items", residency: "all", storage: "ledger", titleField: "name",
    fields: [
      { apiName: "name", label: "Name", type: "text" },
      { apiName: "dealId", label: "Opportunity", type: "lookup", lookupTo: "deal", required: true },
      { apiName: "productId", label: "Product", type: "lookup", lookupTo: "product", required: true },
      { apiName: "quantity", label: "Quantity", type: "number", required: true },
      { apiName: "unitPrice", label: "Unit price", type: "currency" },
      { apiName: "discountPercent", label: "Discount (%)", type: "number" },
      { apiName: "listPrice", label: "List price", type: "currency" },
      { apiName: "totalPrice", label: "Total price", type: "currency" },
      { apiName: "billingFrequency", label: "Billing frequency", type: "picklist", options: options(["one_time", "One-time"], ["monthly", "Monthly"], ["annual", "Annual"]) },
      { apiName: "termMonths", label: "Term (months)", type: "number" },
      { apiName: "startDate", label: "Start date", type: "date" },
      { apiName: "position", label: "Position", type: "number" },
      { apiName: "bundle", label: "Bundle", type: "text" },
      { apiName: "source", label: "Source", type: "text" },
      { apiName: "sourceRef", label: "Source reference", type: "text" },
      { apiName: "crmId", label: "CRM ID", type: "text" },
      ...TIMESTAMPS,
    ],
  },
} as const satisfies Record<string, StandardObjectSpec>;

export type StandardObjectName = keyof typeof STANDARD_OBJECTS;

/**
 * The roles a person holds on a deal (`deal_contact` labels): the buying
 * committee's slots (docs/account-plays.md), then `involved` for someone on
 * the deal with no slot. A deal's edges have one label each, so a person holds
 * one role per deal.
 */
export const DEAL_ROLES = ["executive", "n1", "champion", "user", "procurement", "security", "signer", "involved"] as const;
export type DealRole = (typeof DEAL_ROLES)[number];
/** Roles one person holds per deal; giving one to someone moves its holder to `involved`. */
export const DEAL_SINGLE_ROLES: ReadonlySet<DealRole> = new Set<DealRole>(["executive", "n1", "champion", "signer"]);

export const STANDARD_ASSOCIATIONS: readonly AssociationDef[] = [
  { apiName: "contact_account", from: "contact", to: "account", cardinality: "manyToMany", labels: [], primary: true },
  { apiName: "deal_contact", from: "deal", to: "contact", cardinality: "manyToMany", primary: false, labels: DEAL_ROLES },
  { apiName: "deal_account", from: "deal", to: "account", cardinality: "manyToOne", labels: [], primary: false },
  { apiName: "account_parent", from: "account", to: "account", cardinality: "manyToOne", labels: [], primary: false },
  // What an activity is about (CP5a): one edge per record a note, task, call or meeting targets, so it shows on each one's
  // timeline. `from` is the activity's stream id, `to` the target's id (`acc_…`, `con_…` or a deal's stream id).
  { apiName: "activity_target", from: ["note", "task", "call", "meeting"], to: ["account", "contact", "deal", "lead"], cardinality: "manyToMany", labels: [], primary: false },
];

export const associationDef = (name: AssociationName): AssociationDef => STANDARD_ASSOCIATIONS.find((a) => a.apiName === name)!;

/**
 * Edge streams (CP3, docs/cp0-object-layer.md "Registry"): each typed edge is
 * a ledger stream of this object, one per (association, from, to). Its create
 * entry names the association and both ends; later entries change its label
 * or primary flag, and lifecycle entries remove (delete) and re-add (restore)
 * it, so an edge has the ledger's history and receipts. Ends are register ids
 * for accounts and contacts (`acc_…`, `con_…`), as activity lookups are, so an
 * edge never needs its ends to be worked. Not a standard object: it has no
 * list or record page of its own.
 */
export const ASSOCIATION_OBJECT = "association";

const ASSOCIATION_SPEC: StandardObjectSpec = {
  apiName: ASSOCIATION_OBJECT, label: "Association", pluralLabel: "Associations", residency: "all", storage: "ledger", titleField: "association",
  fields: [
    { apiName: "association", label: "Association", type: "text", required: true },
    { apiName: "fromId", label: "From", type: "text", required: true },
    { apiName: "toId", label: "To", type: "text", required: true },
    { apiName: "label", label: "Label", type: "text" },
    { apiName: "primary", label: "Primary", type: "checkbox" },
    { apiName: "reason", label: "Reason", type: "text" },
  ],
};

export const associationObjectDef = (): ResolvedObjectDef => resolveObjectDef(ASSOCIATION_SPEC);

/** One edge as an edge stream projects it. `active` is false once removed (its stream deleted). */
export type Edge = {
  association: AssociationName; fromId: string; toId: string; label: string | null; primary: boolean;
  /** Why the edge was set, when Canon suggested it and a person accepted. */
  reason: string | null;
  active: boolean;
};

/** The edge a projected association row describes, or null when the row is not one (no association or ends). */
export function edgeOf(values: Readonly<Record<string, FieldValue>>, deletedAt: number | null): Edge | null {
  const { association, fromId, toId, label, primary, reason } = values;
  if (typeof association !== "string" || !STANDARD_ASSOCIATIONS.some((a) => a.apiName === association)) return null;
  if (typeof fromId !== "string" || !fromId || typeof toId !== "string" || !toId) return null;
  return {
    association: association as AssociationName, fromId, toId, label: typeof label === "string" && label ? label : null, primary: primary === true,
    reason: typeof reason === "string" && reason ? reason : null, active: deletedAt === null,
  };
}

/**
 * A scalar field that holds the primary of several values, and the list field
 * that holds the others (#299): a person's email and phone. The primary stays a
 * scalar, so every reader of it, and the email's identity, is unchanged; the
 * whole list is the primary followed by the others. A record that predates the
 * list fields reads as a one-item list. A write that makes one of the others
 * primary moves the old primary into the list (lib/objects/write.ts).
 */
export const PRIMARY_LISTS: Readonly<Record<string, ReadonlyArray<{ primary: string; others: string }>>> = {
  contact: [{ primary: "email", others: "additionalEmails" }, { primary: "phone", others: "additionalPhones" }],
};

/** Every value of a primary-and-others pair, primary first, de-duplicated whatever the case. */
export function allValuesOf(primary: unknown, others: unknown): string[] {
  const out: string[] = [];
  for (const v of [primary, ...(Array.isArray(others) ? others : [])]) {
    if (typeof v === "string" && v.trim() && !out.some((x) => x.toLowerCase() === v.trim().toLowerCase())) out.push(v.trim());
  }
  return out;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Merge an org's custom fields and picklist overrides onto a standard object. */
export function resolveObjectDef(standard: StandardObjectSpec, extension?: OrgObjectExtension): ResolvedObjectDef {
  const overrides = extension?.picklistOptions ?? {};
  const standardFields: FieldDef[] = standard.fields.map((spec) => {
    const field: FieldDef = { ...spec, fieldId: spec.apiName as FieldId };
    const replaced = overrides[field.apiName];
    if (!replaced) return field;
    if (field.type !== "picklist" && field.type !== "multipicklist") {
      throw new RegistryError(`${standard.apiName}.${field.apiName} is not a picklist; its options cannot be overridden`);
    }
    return { ...field, options: replaced };
  });
  for (const apiName of Object.keys(overrides)) {
    if (!standardFields.some((f) => f.apiName === apiName)) throw new RegistryError(`${standard.apiName} has no field ${apiName} to override`);
  }

  const fields: FieldDef[] = [...standardFields];
  for (const custom of extension?.customFields ?? []) {
    if (!CUSTOM_FIELD_API_NAME.test(custom.apiName)) throw new RegistryError(`custom field apiName must look like custom.<slug>: ${custom.apiName}`);
    if (fields.some((f) => f.fieldId === custom.fieldId || f.apiName === custom.apiName)) {
      throw new RegistryError(`${standard.apiName} already has a field ${custom.apiName} (${custom.fieldId})`);
    }
    fields.push({ ...custom, system: false });
  }

  const titleField = fields.find((f) => f.apiName === standard.titleField);
  if (!titleField) throw new RegistryError(`${standard.apiName} has no title field ${standard.titleField}`);
  return {
    apiName: standard.apiName,
    label: extension?.labels?.label ?? standard.label,
    pluralLabel: extension?.labels?.pluralLabel ?? standard.pluralLabel,
    kind: "standard",
    residency: standard.residency,
    storage: standard.storage,
    titleFieldId: titleField.fieldId,
    fields,
    registryVersion: extension?.registryVersion ?? 0,
    byApiName: new Map(fields.map((f) => [f.apiName, f])),
    byFieldId: new Map(fields.map((f) => [f.fieldId, f])),
  };
}

/** The registry entry of a custom object: its system fields; the rest, its title field included, are the org's own `customFields`. */
function customObjectSpec(apiName: string, meta: CustomObjectMeta): StandardObjectSpec {
  return {
    apiName, label: meta.label, pluralLabel: meta.pluralLabel, residency: "onDemand", storage: "ledger", titleField: meta.titleField,
    fields: [OWNER, ...TIMESTAMPS],
  };
}

/**
 * An object's definition for an org, by apiName: a standard object with the
 * org's extension, or a custom object (`custom_<slug>`) from its own row.
 * Null when there is no such object, which includes a `custom_` name with no
 * row. One entry point, so a custom object is served by the same code paths as
 * a standard one.
 */
export function resolveOrgObject(apiName: string, extension?: OrgObjectExtension): ResolvedObjectDef | null {
  if (Object.hasOwn(STANDARD_OBJECTS, apiName)) return resolveObjectDef(STANDARD_OBJECTS[apiName as StandardObjectName], extension);
  if (!isCustomObjectName(apiName) || !extension?.object) return null;
  const { icon, archivedAt } = extension.object;
  return { ...resolveObjectDef(customObjectSpec(apiName, extension.object), extension), kind: "custom", icon, ...(archivedAt !== undefined ? { archivedAt } : {}) };
}

/** The fields an object has before an admin adds any: a standard object's, or a custom one's owner and timestamps. */
export function baseFields(apiName: string): readonly { apiName: string; label: string }[] {
  return Object.hasOwn(STANDARD_OBJECTS, apiName) ? STANDARD_OBJECTS[apiName as StandardObjectName].fields : [OWNER, ...TIMESTAMPS];
}

/** Whether `name` could be a ledger-stored object with list views and records: a standard one or an org's own (which may not exist for a given org). */
export const isLedgerObjectName = (name: string): boolean =>
  (Object.hasOwn(STANDARD_OBJECTS, name) && STANDARD_OBJECTS[name as StandardObjectName].storage === "ledger") || isCustomObjectName(name);

/** A resolved definition without its lookup maps, as it crosses the wire (Convex values and JSON cannot hold a Map). */
export function plainObjectDef(def: ResolvedObjectDef): ObjectDef {
  const { apiName, label, pluralLabel, kind, residency, storage, titleFieldId, fields, registryVersion, icon, archivedAt } = def;
  return { apiName, label, pluralLabel, kind, residency, storage, titleFieldId, fields, registryVersion, ...(icon ? { icon } : {}), ...(archivedAt !== undefined ? { archivedAt } : {}) };
}

/** A definition received over the wire, with its lookup maps rebuilt. */
export function indexObjectDef(def: ObjectDef): ResolvedObjectDef {
  return { ...def, byApiName: new Map(def.fields.map((f) => [f.apiName, f])), byFieldId: new Map(def.fields.map((f) => [f.fieldId, f])) };
}

/**
 * The option a free-text value names, ignoring case, spaces and punctuation: a CRM's
 * `Closed Won` or `closedwon` is the `closed_won` option, not a second stage beside it.
 * The value itself when it is already an option's value, else null.
 */
export function matchPicklistOption(options: readonly PicklistOption[], raw: string): string | null {
  if (options.some((o) => o.value === raw && o.active)) return raw;
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = key(raw);
  if (!wanted) return null;
  return options.find((o) => o.active && key(o.value) === wanted)?.value ?? options.find((o) => o.active && key(o.label) === wanted)?.value ?? null;
}

/**
 * An org's extension with `value` added (or reactivated) as an option of the
 * standard picklist `apiName`, keeping every option it had. Null when the
 * value is already an active option. A system of record's own values, such
 * as a CRM's deal stages, are registered this way rather than rejected.
 */
export function withPicklistOption(standard: StandardObjectSpec, extension: OrgObjectExtension | undefined, apiName: string, value: string): OrgObjectExtension | null {
  const field = resolveObjectDef(standard, extension).byApiName.get(apiName);
  if (!field || (field.type !== "picklist" && field.type !== "multipicklist")) throw new RegistryError(`${standard.apiName}.${apiName} is not a picklist`);
  if (field.options.some((o) => o.value === value && o.active)) return null;
  const options = [...field.options.filter((o) => o.value !== value), { value, label: value, active: true }];
  return { registryVersion: extension?.registryVersion ?? 0, customFields: extension?.customFields ?? [], picklistOptions: { ...extension?.picklistOptions, [apiName]: options } };
}

/** The field type a custom field takes from a value it is first written with. */
export function customFieldType(value: unknown): "text" | "number" | "checkbox" | null {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  return null;
}

/**
 * An org's extension with the custom field `apiName` (`custom.<slug>`) added,
 * its fieldId the apiName, so a `facts` attribute and its ledger field share
 * one key. Null when the object already has the field. A new column bumps
 * `registryVersion`.
 */
export function withCustomField(
  standard: StandardObjectSpec, extension: OrgObjectExtension | undefined, apiName: string, type: "text" | "number" | "checkbox",
): OrgObjectExtension | null {
  if (!CUSTOM_FIELD_API_NAME.test(apiName)) throw new RegistryError(`custom field apiName must look like custom.<slug>: ${apiName}`);
  if (resolveObjectDef(standard, extension).byApiName.has(apiName)) return null;
  const label = apiName.slice("custom.".length).replace(/_/g, " ");
  return {
    registryVersion: (extension?.registryVersion ?? 0) + 1,
    customFields: [...(extension?.customFields ?? []), { fieldId: apiName as FieldId, apiName, label, type }],
    ...(extension?.picklistOptions ? { picklistOptions: extension.picklistOptions } : {}),
  };
}

/** `retryable`: refused for now (a unique value another record holds), not for good. */
export type CoerceError = { field: string; message: string; retryable?: true; /** Set when a custom field's rule refused the value. */ rule?: RuleKind };

/**
 * How `coerce` treats a custom field's `required` and `rules` (CP7b):
 * `enforce` checks both, for a person, an import or an agent; `system` skips
 * only the must-be-set-on-create check, for Canon's own creates (market fills,
 * enrichment) that have no one to fill the field; `off` skips both, for a CRM
 * sync, whose provider owns the value. Standard fields are always checked.
 */
export type RuleMode = "enforce" | "system" | "off";

/** The rule mode a write from `sourceKind` runs under: a CRM's values are never refused, Canon's own creates skip the required check. */
export const ruleModeFor = (sourceKind: string): RuleMode =>
  sourceKind === "salesforce" || sourceKind === "hubspot" ? "off" : sourceKind === "enrichment" || sourceKind === "pipeline" || sourceKind === "call" || sourceKind === "email" || sourceKind === "linkedin" ? "system" : "enforce";
export type CoercedValue = { fieldId: FieldId; value: FieldValue };
export type CoerceResult = { ok: true; values: CoercedValue[] } | { ok: false; errors: CoerceError[] };

/**
 * Parse raw input (a form, an API call, a CSV row) keyed by apiName into typed
 * field values. Rejects unknown, system and formula fields, values of the
 * wrong type, unknown or inactive picklist values, and empty required fields.
 * On create every required field must be present; on update only the fields
 * given are checked. Empty input (`null`, `""`, `[]`) clears a field.
 */
export function coerce(def: ResolvedObjectDef, input: Record<string, unknown>, opts: { mode: "create" | "update"; rules?: RuleMode; now?: number }): CoerceResult {
  const ruleMode = opts.rules ?? "enforce";
  const now = opts.now ?? Date.now();
  const custom = (f: FieldDef) => CUSTOM_FIELD_API_NAME.test(f.apiName);
  const values: CoercedValue[] = [];
  const errors: CoerceError[] = [];
  for (const [apiName, raw] of Object.entries(input)) {
    const field = def.byApiName.get(apiName);
    if (!field) {
      errors.push({ field: apiName, message: `${def.apiName} has no field ${apiName}` });
      continue;
    }
    if (field.type === "formula") {
      errors.push({ field: apiName, message: `${field.label} is a ${field.rollup ? "rollup" : "formula"} field: its value is computed, so it cannot be written` });
      continue;
    }
    if (field.system) {
      errors.push({ field: apiName, message: `${field.label} is set by the system and cannot be written` });
      continue;
    }
    if (field.archivedAt !== undefined) {
      errors.push({ field: apiName, message: `${field.label} is archived and takes no new values` });
      continue;
    }
    const parsed = parseValue(field, raw);
    if (!parsed.ok) errors.push({ field: apiName, message: parsed.message });
    else if (parsed.value === null && field.required && !(ruleMode === "off" && custom(field))) errors.push({ field: apiName, message: `${field.label} is required` });
    else {
      const broken = parsed.value !== null && field.rules && ruleMode !== "off" ? checkRules(field.rules, parsed.value, now) : null;
      if (broken) errors.push({ field: apiName, message: `${field.label} breaks its ${RULE_NAMES[broken.rule]} rule: ${broken.message}`, rule: broken.rule });
      else values.push({ fieldId: field.fieldId, value: parsed.value });
    }
  }
  if (opts.mode === "create") {
    for (const field of def.fields) {
      if (field.required && field.archivedAt === undefined && !(field.apiName in input) && !(ruleMode !== "enforce" && custom(field))) errors.push({ field: field.apiName, message: `${field.label} is required` });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

type Parsed = { ok: true; value: FieldValue } | { ok: false; message: string };

const isEmpty = (raw: unknown) => raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
const DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;

function parseValue(field: FieldDef, raw: unknown): Parsed {
  const listy = field.type === "multipicklist" || isMultiValueType(field.type);
  if (listy ? isEmpty(raw) || (Array.isArray(raw) && raw.length === 0) : isEmpty(raw)) return { ok: true, value: null };
  const fail = (expected: string): Parsed => ({ ok: false, message: `${field.label} must be ${expected}` });
  switch (field.type) {
    case "splits":
      return parseSplits(raw);
    case "text":
    case "user":
    case "lookup":
      return typeof raw === "string" ? { ok: true, value: raw.trim() } : fail("text");
    case "number":
    case "currency": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && DECIMAL.test(raw.trim()) ? Number(raw.trim()) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : fail("a number");
    }
    case "checkbox": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return s === "true" || s === "false" ? { ok: true, value: s === "true" } : fail("true or false");
    }
    case "date":
      return parseDate(raw) ?? fail("a date (YYYY-MM-DD)");
    case "datetime":
      return parseDatetime(raw) ?? fail("a date and time with a timezone, or epoch milliseconds");
    case "picklist": {
      if (typeof raw !== "string") return fail("one of its options");
      const problem = picklistProblem(field.options, raw);
      return problem ? { ok: false, message: `${field.label}: ${problem}` } : { ok: true, value: raw };
    }
    case "multipicklist": {
      // A string is the Salesforce and CSV form: options separated by semicolons.
      const items = typeof raw === "string" ? raw.split(";").map((s) => s.trim()).filter(Boolean) : raw;
      if (!Array.isArray(items) || !items.every((x): x is string => typeof x === "string")) return fail("a list of its options");
      const problems = items.map((x) => picklistProblem(field.options, x)).filter((p): p is string => p !== null);
      if (problems.length) return { ok: false, message: `${field.label}: ${problems.join("; ")}` };
      const value = [...new Set(items)].sort();
      return { ok: true, value: value.length ? value : null };
    }
    case "emails":
    case "phones":
    case "links":
      return parseMultiValue(field.label, field.type, raw);
    case "formula":
      return fail("computed, not written");
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().\-]{4,30}(\s*(x|ext\.?)\s*\d{1,6})?$/i;
const LINK = /^(https?:\/\/)?[^\s/$.?#][^\s]*\.[^\s]+$/i;

const MULTI_RULE: Record<MultiValueType, { what: string; valid: (s: string) => boolean; normal: (s: string) => string }> = {
  emails: { what: "an email address", valid: (s) => EMAIL.test(s), normal: (s) => s.toLowerCase() },
  phones: { what: "a phone number", valid: (s) => PHONE.test(s) && /\d{4}/.test(s.replace(/\D/g, "")), normal: (s) => s.replace(/\s+/g, " ") },
  links: { what: "a web address", valid: (s) => LINK.test(s), normal: (s) => s },
};

/**
 * Several emails, phones or links, the first the primary. A string is the
 * CSV form: values separated by semicolons. Order is kept; a repeat (emails
 * whatever their case) is dropped.
 */
function parseMultiValue(label: string, type: MultiValueType, raw: unknown): Parsed {
  const rule = MULTI_RULE[type];
  const items = typeof raw === "string" ? raw.split(";") : raw;
  if (!Array.isArray(items) || !items.every((x): x is string => typeof x === "string")) return { ok: false, message: `${label} must be a list of text` };
  const out: string[] = [];
  for (const item of items.map((x) => x.trim()).filter(Boolean)) {
    if (!rule.valid(item)) return { ok: false, message: `${label}: ${JSON.stringify(item)} is not ${rule.what}` };
    const v = rule.normal(item);
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > MULTI_VALUES_MAX) return { ok: false, message: `${label} holds at most ${MULTI_VALUES_MAX} values` };
  return { ok: true, value: out.length ? out : null };
}

function picklistProblem(opts: readonly PicklistOption[], value: string): string | null {
  const option = opts.find((o) => o.value === value);
  if (!option) return `${JSON.stringify(value)} is not an option`;
  return option.active ? null : `${JSON.stringify(value)} is no longer an active option`;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Epoch ms whose UTC year has four digits; JavaScript dates span far wider and can be invalid. */
const inDateRange = (ms: number) => {
  const year = new Date(ms).getUTCFullYear();
  return Number.isFinite(year) && year >= 1 && year <= 9999;
};

function isoDateUtc(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** A `YYYY-MM-DD` date that exists on the calendar (rejects 2026-02-30). */
function parseDate(raw: unknown): Parsed | null {
  if (typeof raw === "number") return Number.isFinite(raw) && inDateRange(raw) ? { ok: true, value: isoDateUtc(raw) } : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const m = DATE_PREFIX.exec(s);
  if (!m || !ISO_DATETIME.test(s) || (s.length > 10 && !Number.isFinite(Date.parse(s)))) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  // The date as written: a timestamp's own calendar day, not shifted to UTC.
  return isoDateUtc(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) === date ? { ok: true, value: date } : null;
}

/** Epoch ms, or an ISO string with an explicit timezone (a bare local time would depend on the server's zone). */
function parseDatetime(raw: unknown): Parsed | null {
  if (typeof raw === "number") return Number.isInteger(raw) && inDateRange(raw) ? { ok: true, value: raw } : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!ISO_DATETIME.test(s) || !parseDate(s)) return null;
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(ms) ? { ok: true, value: ms } : null;
}
