/**
 * Opportunity custom fields and history, mapped for Canon (CP11c). Pure.
 *
 * Custom fields: each non-formula custom field on Opportunity becomes a Canon
 * deal custom field of the nearest builder type. History: OpportunityHistory
 * (stage, amount, close date, probability and forecast as of each stage
 * change) and OpportunityFieldHistory (every other tracked field) become
 * dated points per opportunity, which Canon writes into the deal's ledger as
 * facts valid from when they happened.
 */
import { normalizeSfId } from "./mapping.ts";
import { forecastCategoryOf, type SfStage } from "./deals.ts";

export type CustomFieldType = "text" | "number" | "currency" | "date" | "datetime" | "checkbox" | "picklist" | "multipicklist" | "emails" | "phones" | "links";
export type CustomValue = string | number | boolean | string[] | null;

/** A Salesforce custom field as Canon should hold it. `options` are a picklist's values, in order; `multiline` marks a text area. */
export type CustomFieldSpec = { sfName: string; label: string; type: CustomFieldType; options?: string[]; multiline?: true };
/** Where a Salesforce custom field lands: its Canon apiName, and each picklist value's Canon option value. */
export type CustomFieldPlacement = { sfName: string; apiName: string; type: CustomFieldType; options: Array<{ label: string; value: string }> };

/** One moment of an opportunity's history: the fields that held these values from `at`. */
export type HistoryPoint = { at: number; values: Record<string, CustomValue> };

type DescribedField = { name: string; label: string; type: string; custom?: boolean; calculated?: boolean; picklistValues?: Array<{ value: string; active?: boolean }> };

/** Salesforce field types Canon cannot hold as a field (compound and binary types). */
const SKIPPED = new Set(["address", "location", "base64", "complexvalue"]);

/** The builder type for a Salesforce field type. */
export function customFieldType(sfType: string): CustomFieldType {
  switch (sfType.toLowerCase()) {
    case "int": case "double": case "percent": case "long": return "number";
    case "currency": return "currency";
    case "date": return "date";
    case "datetime": return "datetime";
    case "boolean": return "checkbox";
    case "picklist": return "picklist";
    case "multipicklist": return "multipicklist";
    case "email": return "emails";
    case "phone": return "phones";
    case "url": return "links";
    default: return "text";
  }
}

/**
 * The custom fields worth importing, and the ones left out with why. Formula
 * fields stay in Salesforce: Canon computes its own (CP7c), and a copied
 * value would go stale.
 */
export function customFieldSpecs(fields: readonly DescribedField[]): { specs: CustomFieldSpec[]; skipped: Array<{ sfName: string; reason: string }> } {
  const specs: CustomFieldSpec[] = [];
  const skipped: Array<{ sfName: string; reason: string }> = [];
  for (const f of fields) {
    if (!(f.custom ?? f.name.endsWith("__c"))) continue;
    if (f.calculated) { skipped.push({ sfName: f.name, reason: "formula field; Canon computes its own" }); continue; }
    if (SKIPPED.has(f.type.toLowerCase())) { skipped.push({ sfName: f.name, reason: `${f.type} fields have no Canon type` }); continue; }
    const type = customFieldType(f.type);
    const options = type === "picklist" || type === "multipicklist" ? (f.picklistValues ?? []).map((p) => p.value) : undefined;
    const multiline = f.type.toLowerCase() === "textarea" ? { multiline: true as const } : {};
    specs.push({ sfName: f.name, label: (f.label || f.name.replace(/__c$/, "").replace(/_/g, " ")).slice(0, 80), type, ...(options ? { options } : {}), ...multiline });
  }
  return { specs, skipped };
}

/** A Salesforce value (as Bulk CSV or SOQL gives it) as the Canon field's value. Money is cents, as on deals. */
export function customValue(raw: unknown, p: CustomFieldPlacement): CustomValue {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw);
  switch (p.type) {
    case "number": { const n = Number(s); return Number.isFinite(n) ? n : null; }
    case "currency": { const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) : null; }
    case "checkbox": return s.toLowerCase() === "true";
    case "date": return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
    case "datetime": { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
    case "picklist": return p.options.find((o) => o.label === s)?.value ?? null;
    case "multipicklist": return s.split(";").map((v) => p.options.find((o) => o.label === v)?.value).filter((v): v is string => v !== undefined);
    case "emails": case "phones": case "links": return [s];
    default: return s;
  }
}

/** Opportunity fields whose history comes from OpportunityHistory; OpportunityFieldHistory's rows for them are left out. */
const STAGE_HISTORY_FIELDS = new Set(["StageName", "Amount", "CloseDate", "Probability", "ForecastCategoryName", "ForecastCategory", "created", "opportunityCreatedFromLead"]);
/** Standard fields OpportunityFieldHistory can name, as the deal fields they are. */
const FIELD_HISTORY: Record<string, string> = { Name: "name", NextStep: "nextStep" };

const time = (v: unknown) => {
  const t = v ? Date.parse(String(v).replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Each opportunity's history as dated points, oldest first, one per moment
 * (rows at the same time merge). `stageValue` gives the Canon stage value of
 * a Salesforce stage name for that opportunity's process.
 */
export function historyPoints(
  stageRows: readonly Record<string, unknown>[], fieldRows: readonly Record<string, unknown>[],
  ctx: { stageValue: (opportunitySfId: string, stageName: string) => string; stages: ReadonlyMap<string, SfStage>; custom: ReadonlyMap<string, CustomFieldPlacement> },
): Map<string, HistoryPoint[]> {
  const byOpp = new Map<string, Map<number, Record<string, CustomValue>>>();
  const at = (opp: string, t: number) => {
    const points = byOpp.get(opp) ?? new Map<number, Record<string, CustomValue>>();
    byOpp.set(opp, points);
    const values = points.get(t) ?? {};
    points.set(t, values);
    return values;
  };
  for (const r of stageRows) {
    const opp = normalizeSfId(String(r.OpportunityId ?? ""));
    const t = time(r.CreatedDate);
    const stageName = String(r.StageName ?? "").trim();
    if (!opp || t === undefined || !stageName) continue;
    const stage = ctx.stages.get(stageName);
    const closed = stage?.forecastCategory === "closed_won" || stage?.forecastCategory === "closed_lost";
    const forecastCategory = closed ? stage!.forecastCategory : forecastCategoryOf(String(r.ForecastCategory ?? "").replace("BestCase", "Best Case"), false, false);
    const amount = r.Amount === null || r.Amount === undefined || r.Amount === "" ? null : Math.round(Number(r.Amount) * 100);
    const probability = r.Probability === null || r.Probability === undefined || r.Probability === "" ? null : Number(r.Probability) / 100;
    Object.assign(at(opp, t), {
      stage: ctx.stageValue(opp, stageName), forecastCategory, isClosed: closed, isWon: forecastCategory === "closed_won",
      ...(amount !== null && Number.isFinite(amount) ? { amount } : {}),
      ...(/^\d{4}-\d{2}-\d{2}/.test(String(r.CloseDate ?? "")) ? { closeDate: String(r.CloseDate).slice(0, 10) } : {}),
      ...(probability !== null && Number.isFinite(probability) ? { probability } : {}),
    });
  }
  for (const r of fieldRows) {
    const opp = normalizeSfId(String(r.OpportunityId ?? ""));
    const t = time(r.CreatedDate);
    const field = String(r.Field ?? "");
    if (!opp || t === undefined || STAGE_HISTORY_FIELDS.has(field)) continue;
    const placement = ctx.custom.get(field);
    const apiName = FIELD_HISTORY[field] ?? placement?.apiName;
    if (!apiName) continue;
    const raw = r.NewValue === undefined ? null : r.NewValue;
    at(opp, t)[apiName] = placement ? customValue(raw, placement) : raw === null || raw === "" ? null : String(raw);
  }
  return new Map([...byOpp].map(([opp, points]) => [opp, [...points].sort((a, b) => a[0] - b[0]).map(([t, values]) => ({ at: t, values }))]));
}
