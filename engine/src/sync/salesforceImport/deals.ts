/**
 * Opportunities, their sales processes and their contact roles, mapped for
 * the Canon side of the import (deals, pipelines, `deal_contact` edges).
 * Pure: the engine reads Salesforce, these functions decide, a CanonSink
 * writes.
 */
import type { Mapped } from "./mapping.ts";
import { normalizeSfId } from "./mapping.ts";
import type { CustomValue, HistoryPoint } from "./history.ts";

export type ForecastCategory = "omit" | "pipeline" | "best_case" | "commit" | "closed_won" | "closed_lost";
export type DealRole = "executive" | "n1" | "champion" | "user" | "procurement" | "security" | "signer" | "involved";

/** One Opportunity stage as Salesforce configures it (OpportunityStage). */
export type SfStage = { name: string; probability: number; forecastCategory: ForecastCategory };

/**
 * One sales process: a Canon pipeline. `recordTypeIds` are the record types
 * that use it ("" for opportunities with no record type).
 */
export type SalesProcess = { name: string; recordTypeIds: string[]; stages: SfStage[] };

/** Where a (record type, StageName) pair lands: the Canon stage value. */
export type StagePlacement = { recordTypeId: string; stageName: string; value: string };

/** A Salesforce user, and the Canon member with the same email, if any. */
export type SfOwner = { sfUserId: string; name: string; email?: string; memberId?: string };

/** One opportunity as a Canon deal. Money is cents; probability a fraction. */
export type DealImport = {
  sfId: string;
  name: string;
  amount?: number;
  currency: string;
  closeDate: string;
  stage: string;
  forecastCategory: ForecastCategory;
  probability: number;
  isClosed: boolean;
  isWon: boolean;
  dealType: "new_business" | "expansion" | "renewal" | "one_time";
  revenueType: "one_time" | "recurring";
  ownerSfId?: string;
  memberId?: string;
  accountSfId?: string;
  createdAt?: number;
  modifiedAt?: number;
  nextStep?: string;
  /** Custom field values by Canon apiName (CP11c). */
  custom?: Record<string, CustomValue>;
  /** Dated points from the opportunity's history, oldest first, all older than `modifiedAt`. */
  history?: HistoryPoint[];
};

/** Contact roles of one opportunity, as Canon roles, one per contact. */
export type DealRoles = { opportunitySfId: string; roles: Array<{ roleSfId: string; contactSfId: string; role: DealRole; createdAt?: number }> };

/** Fields the import reads when the org has them (custom fields come later, CP7). */
export const OPPORTUNITY_FIELDS = [
  "Id", "Name", "AccountId", "StageName", "Amount", "Probability", "CloseDate", "Type", "IsClosed", "IsWon", "ForecastCategoryName",
  "NextStep", "OwnerId", "RecordTypeId", "CurrencyIsoCode", "CreatedDate", "LastModifiedDate", "SystemModstamp",
] as const;

export const CONTACT_ROLE_FIELDS = ["Id", "OpportunityId", "ContactId", "Role", "IsPrimary", "CreatedDate"] as const;

/** Salesforce's ForecastCategoryName for an open opportunity. A closed one takes closed_won or closed_lost. */
export function forecastCategoryOf(name: string | undefined, closed: boolean, won: boolean): ForecastCategory {
  if (closed) return won ? "closed_won" : "closed_lost";
  switch ((name ?? "").trim().toLowerCase()) {
    case "omitted": return "omit";
    case "best case": return "best_case";
    case "commit": return "commit";
    default: return "pipeline";
  }
}

export function dealTypeOf(type: string | undefined): DealImport["dealType"] {
  const t = (type ?? "").toLowerCase();
  if (t.includes("renew")) return "renewal";
  if (t.includes("existing") || t.includes("expan") || t.includes("upsell") || t.includes("add-on")) return "expansion";
  if (t.includes("one")) return "one_time";
  return "new_business";
}

/**
 * Salesforce's OpportunityContactRole.Role to a Canon deal role. Standard
 * values plus the custom ones orgs most often add; anything else is
 * `involved`.
 */
export const ROLE_MAP: Readonly<Record<string, DealRole>> = {
  "decision maker": "executive",
  "economic decision maker": "executive",
  "executive sponsor": "executive",
  "economic buyer": "signer",
  "signer": "signer",
  "champion": "champion",
  "technical buyer": "security",
  "security": "security",
  "evaluator": "user",
  "business user": "user",
  "end user": "user",
  "procurement": "procurement",
  "purchasing": "procurement",
  "influencer": "involved",
  "other": "involved",
};

/** Roles one person holds per deal (lib/objects/registry.ts DEAL_SINGLE_ROLES). */
const SINGLE_ROLES: ReadonlySet<DealRole> = new Set<DealRole>(["executive", "n1", "champion", "signer"]);

export const roleOf = (sfRole: string | undefined): DealRole => ROLE_MAP[(sfRole ?? "").trim().toLowerCase()] ?? "involved";

const time = (v: string | undefined) => {
  const t = v ? Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const text = (v: string | undefined, max = 512) => {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : undefined;
};

/**
 * Each opportunity's contact roles, decided the same way whatever order
 * Salesforce returns them in: the primary contact first, then by role id. A
 * contact listed twice keeps its first role. A single-holder role a second
 * person maps to (two Decision Makers) makes that person `involved`, so a
 * re-run never moves the role between them.
 */
export function planDealRoles(rows: readonly Record<string, string>[]): { deals: DealRoles[]; rejected: Array<{ sfId?: string; reason: string }> } {
  const byOpp = new Map<string, Record<string, string>[]>();
  const rejected: Array<{ sfId?: string; reason: string }> = [];
  for (const r of rows) {
    const opp = normalizeSfId(r.OpportunityId);
    const id = normalizeSfId(r.Id);
    if (!id || !opp) { rejected.push({ sfId: r.Id, reason: "invalid Salesforce Id" }); continue; }
    if (!normalizeSfId(r.ContactId)) { rejected.push({ sfId: id, reason: "Contact role has no contact" }); continue; }
    byOpp.set(opp, [...(byOpp.get(opp) ?? []), r]);
  }
  const deals: DealRoles[] = [];
  for (const [opportunitySfId, list] of byOpp) {
    const ordered = [...list].sort((a, b) => Number(isTrue(b.IsPrimary)) - Number(isTrue(a.IsPrimary)) || normalizeSfId(a.Id)!.localeCompare(normalizeSfId(b.Id)!));
    const held = new Set<DealRole>();
    const seen = new Set<string>();
    const roles: DealRoles["roles"] = [];
    for (const r of ordered) {
      const contactSfId = normalizeSfId(r.ContactId)!;
      const roleSfId = normalizeSfId(r.Id)!;
      if (seen.has(contactSfId)) { rejected.push({ sfId: roleSfId, reason: "Contact already has a role on this opportunity; Canon keeps one per person" }); continue; }
      seen.add(contactSfId);
      let role = roleOf(r.Role);
      if (SINGLE_ROLES.has(role)) {
        if (held.has(role)) role = "involved";
        else held.add(role);
      }
      roles.push({ roleSfId, contactSfId, role, ...(time(r.CreatedDate) !== undefined ? { createdAt: time(r.CreatedDate) } : {}) });
    }
    deals.push({ opportunitySfId, roles });
  }
  return { deals, rejected };
}

const isTrue = (v: string | undefined) => String(v).toLowerCase() === "true";

export type OpportunityContext = {
  /** `${recordTypeId}\u0000${StageName}` to the Canon stage value. */
  stages: ReadonlyMap<string, string>;
  owners: ReadonlyMap<string, SfOwner>;
  defaultCurrency: string;
};

export const stageKey = (recordTypeId: string, stageName: string) => `${recordTypeId}\u0000${stageName}`;

/**
 * An opportunity as a Canon deal. A stage outside its record type's process
 * (an inactive or retired stage) keeps its Salesforce name, which Canon
 * registers in the default pipeline.
 */
export function mapOpportunity(row: Record<string, string>, ctx: OpportunityContext, stageDefaults: ReadonlyMap<string, SfStage>): Mapped<DealImport> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const name = text(row.Name, 200);
  if (!name) return { reject: "Opportunity has no Name" };
  const closeDate = (row.CloseDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) return { reject: "Opportunity has no Close Date" };
  const stageName = text(row.StageName, 120);
  if (!stageName) return { reject: "Opportunity has no Stage" };
  const recordTypeId = normalizeSfId(row.RecordTypeId) ?? "";
  const stage = ctx.stages.get(stageKey(recordTypeId, stageName)) ?? ctx.stages.get(stageKey("", stageName)) ?? stageName;
  const closed = isTrue(row.IsClosed);
  const won = closed && isTrue(row.IsWon);
  const amount = row.Amount === "" || row.Amount === undefined ? undefined : Number(row.Amount);
  const probability = row.Probability === "" || row.Probability === undefined ? stageDefaults.get(stageName)?.probability : Number(row.Probability);
  const currency = (text(row.CurrencyIsoCode, 3) ?? ctx.defaultCurrency).toUpperCase();
  const ownerSfId = normalizeSfId(row.OwnerId);
  const memberId = ownerSfId ? ctx.owners.get(ownerSfId)?.memberId : undefined;
  const dealType = dealTypeOf(row.Type);
  return {
    ok: {
      sfId, name, closeDate, stage, currency,
      ...(amount !== undefined && Number.isFinite(amount) ? { amount: Math.round(amount * 100) } : {}),
      forecastCategory: forecastCategoryOf(row.ForecastCategoryName, closed, won),
      probability: Number.isFinite(probability) ? Math.max(0, Math.min(100, probability!)) / 100 : closed ? (won ? 1 : 0) : 0,
      isClosed: closed, isWon: won, dealType, revenueType: dealType === "one_time" ? "one_time" : "recurring",
      ...(ownerSfId ? { ownerSfId } : {}),
      ...(memberId ? { memberId } : {}),
      ...(normalizeSfId(row.AccountId) ? { accountSfId: normalizeSfId(row.AccountId) } : {}),
      ...(time(row.CreatedDate) !== undefined ? { createdAt: time(row.CreatedDate) } : {}),
      ...(time(row.SystemModstamp ?? row.LastModifiedDate) !== undefined ? { modifiedAt: time(row.SystemModstamp || row.LastModifiedDate) } : {}),
      ...(text(row.NextStep) ? { nextStep: text(row.NextStep) } : {}),
    },
  };
}
