/**
 * Local shim of the Phase 1b shared contracts that workstream A owns
 * (record service 1.2.0, Salesforce client modules). These are copied from
 * the plan's "sharedContracts" section so B can build and test before A
 * merges. When A lands, replace these with imports from
 * services/record-service/src/contract.ts and connectors/salesforce/.
 *
 * Pure types: no runtime imports.
 */
import type { DealImport, DealRoles, SalesProcess, StagePlacement } from "./deals.ts";
import type { ActivityImport } from "./activities.ts";
import type { CustomFieldPlacement, CustomFieldSpec } from "./history.ts";

// ---------- Salesforce client (A: engine/src/connectors/salesforce/) ----------

export type SfConn = {
  instanceUrl: string;
  getToken(): Promise<string>;
  apiVersion: string;
  /** Called after a 401; returns a fresh token. Optional. */
  refreshToken?(): Promise<string>;
  fetchImpl?: typeof fetch;
};

// ---------- Record service 1.2.0 ----------

export type AccountInput = {
  domain: string;
  name: string;
  industry?: string;
  employees?: number;
  country?: string;
  linkedinUrl?: string;
  status?: "new" | "working" | "qualified" | "disqualified";
  ownerId?: string;
  segmentIds?: string[];
  sfId?: string;
};

export type ContactInput = {
  accountId?: string;
  accountDomain?: string;
  fullName: string;
  title?: string;
  email?: string;
  emailStatus?: string;
  linkedinUrl?: string;
  status?: "new" | "working" | "qualified" | "disqualified";
  sfId?: string;
};

export type MatchKey = "sfId" | "domain" | "email" | "linkedinUrl";

export type UpsertResult = {
  upserted: number;
  ids: string[];
  created: number;
  merged: number;
  rejected: Array<{ index: number; sfId?: string; reason: string }>;
};

export type ObjectFieldType = "string" | "number" | "boolean" | "date" | "datetime" | "picklist" | "reference" | "json";

export type ObjectDef = {
  name: string;
  label: string;
  fields: Array<{ name: string; type: ObjectFieldType; referenceTo?: string[] }>;
};

export type CustomRecordInput = { sfId?: string; externalKey?: string; fields: Record<string, unknown> };

/** The slice of the record service the import writes through. */
export interface ImportSink {
  upsertAccounts(body: { records: AccountInput[]; source: string; idempotencyKey: string; merge?: { matchBy: MatchKey[] } }): Promise<UpsertResult>;
  upsertContacts(body: { records: ContactInput[]; source: string; idempotencyKey: string; merge?: { matchBy: MatchKey[] } }): Promise<UpsertResult>;
  defineObjects(objects: ObjectDef[]): Promise<{ defined: number }>;
  upsertCustom(object: string, body: { records: CustomRecordInput[]; source: string; idempotencyKey: string }): Promise<UpsertResult>;
}

// ---------- Canon (Convex) side: deals, pipelines, roles, owners ----------

/**
 * What the import writes into Canon itself rather than the record service.
 * Every method is idempotent: re-sending a chunk converges on the same rows.
 */
export interface CanonSink {
  /** Canon members with these emails (lowercase). An email with no member is left out. */
  membersByEmail(emails: string[]): Promise<Array<{ email: string; memberId: string }>>;
  /** Make each Salesforce custom field a Canon custom field of `object`, matched by label on a re-import. */
  prepareCustomFields(object: "deal", specs: CustomFieldSpec[]): Promise<CustomFieldPlacement[]>;
  /** Make each sales process a Canon pipeline and say where each of its stages lands. */
  preparePipelines(processes: SalesProcess[]): Promise<StagePlacement[]>;
  /** Remember the Canon record each Salesforce id became (accounts and contacts: register ids). */
  rememberIds(object: string, pairs: Array<{ sfId: string; canonId: string }>): Promise<void>;
  upsertDeals(rows: DealImport[]): Promise<{ created: number; updated: number; rejected: Array<{ index: number; reason: string }> }>;
  setDealRoles(deals: DealRoles[]): Promise<{ applied: number; rejected: Array<{ sfId: string; reason: string }> }>;
  /** Tasks, calls, meetings and notes by Salesforce id, each with an `activity_target` edge to every record it names that Canon has. */
  upsertActivities(rows: ActivityImport[]): Promise<{ created: number; updated: number; rejected: Array<{ index: number; reason: string }> }>;
}

/** Records one Salesforce owner held in a chunk, and the Canon member it maps to (none: unmapped). */
export type OwnerTally = { sfUserId: string; name: string; email?: string; memberId?: string; records: number };

// ---------- Convex sfImportJobs row shape (A owns the table) ----------

export type ObjectImportState = {
  apiName: string;
  sfTotal: number;
  upserted: number;
  merged: number;
  rejected: number;
  bulkJobId?: string;
  state: "pending" | "running" | "done" | "failed";
  /** B extension: resume point inside the bulk job. */
  locator?: string;
  chunksDone?: number;
  /** B extension: source rows read so far (upserted + rejected == seen). */
  seen?: number;
  error?: string;
};

export type RejectedRow = { object: string; sfId?: string; reason: string };
