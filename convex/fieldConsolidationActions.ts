"use node";

/**
 * Field consolidation, the CRM side (docs/field-consolidation.md). Canon keeps one mapped canonical value per record,
 * not every custom column, so discovery and profiling read the connected CRMs live, as free fill does:
 * - `discover` reads column definitions (HubSpot properties, Salesforce describe) and keeps those naming the concept;
 * - `profileObject` reads one object's records, a column set at a time, into fill, values and pairwise agreement;
 * - `preview` decides every record against the map and policy and saves the result as a run;
 * - `writeRun` applies a run's writes (or undoes them) as one unit once a person approves it, a chunk at a time,
 *   through the engine's compare-and-set apply. It is the only function here that writes to a CRM.
 */
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hubspot as hubspotGet } from "./enrichFreeFill";
import { accessTokenForOrg, connectorForOrg as hubspotConnectorForOrg } from "./hubspotActions";
import { connectorForOrg as salesforceConnectorForOrg, credentialsForOrg } from "./salesforceActions";
import { resolveLlm } from "./lib/llmResolver";
import { forcedToolCall, DEFAULT_MODELS } from "../engine/src/llm.ts";
import { HUBSPOT_DEFAULT_FIELD_MAPPINGS, SALESFORCE_DEFAULT_FIELD_MAPPINGS, mappedField, type FieldMappings } from "../engine/src/mappings.ts";
import { applyPatchPlan } from "../engine/src/connector.ts";
import type { GtmConnector, PatchOperation, PatchPlan } from "../engine/src/types.ts";
import {
  COLUMN_OBJECTS, DEFAULT_POLICY, HUBSPOT_SALESFORCE_LINK, MAX_COLUMNS_PER_OBJECT, MAX_MAP_ENTRIES, OBJECTS_BY_SYSTEM, ProfileBuilder, salesforceOwned,
  autoMap, canonAttribute, canonFactValue, canonRecords, canonValue, cleanValue, decideDestination, destinationsOf, fieldDefinition, magnitudeBand, parseQuantity, enrichmentColumns, enrichmentValue,
  hubspotColumn, isCatchAll, isEnrichmentName, mapKey, mapOf, matchesConcept, optionFor, salesforceColumn, suggestScales, writableColumn,
  COMBINE_LABEL, DECISION_LABEL, toCsv, type CanonValue, type Column, type ColumnObject, type CrmRecord, type CrmSystem, type DecisionKind, type DestinationMode,
  type FieldDefinition, type MapEntry, type Measure, type ObjectProfile, type Policy, type ScaleEntry,
} from "./lib/consolidate";

const SF_API = "v59.0";
/** A read stops after this long or this many records and says it was capped. */
const READ_BUDGET_MS = 5 * 60_000;
const MAX_RECORDS = 250_000;
/** Columns a concept keeps; a vaguer keyword list is cut here. */
const MAX_COLUMNS = 60;
const SAMPLES_PER_KIND = 25;

/** The field that names a record in a preview row. */
const NAME_FIELD: Record<ColumnObject, string> = { companies: "name", contacts: "email", Account: "Name", Contact: "Email", Lead: "Email" };

type JobPhase = { key: string; label: string; status: "processing" | "completed" | "failed"; done?: number; total?: number; note?: string };

/**
 * A suggest, preview, apply or undo as a background job: the page shows its bars while it runs, and the tray keeps it
 * after the page is left. Progress is written at most every two seconds; finishing always writes.
 */
async function startProgress(ctx: ActionCtx, id: Id<"fieldConsolidations">, userId: Id<"users">, task: "suggest" | "preview" | "apply" | "undo", detail: string, phases: JobPhase[]) {
  const jobId = await ctx.runMutation(internal.fieldConsolidations.startJob, {
    id, userId, task, detail, phases: phases.map((p) => ({ key: p.key, label: p.label, status: "processing" as const, ...(p.total !== undefined ? { total: p.total, done: p.done ?? 0 } : {}) })),
  });
  return attachProgress(ctx, jobId, phases);
}

/** The progress writer for a job already started (an apply's later chunks). */
function attachProgress(ctx: ActionCtx, jobId: Id<"backgroundJobs">, phases: JobPhase[]) {
  let last = Date.now();
  const write = (patch: { detail?: string; status?: "completed" | "failed"; error?: string }) =>
    ctx.runMutation(internal.backgroundJobs.update, { jobId, phases, ...patch });
  return {
    phases,
    async tick(detail?: string, now = false) {
      if (!now && Date.now() - last < 2000) return;
      last = Date.now();
      await write(detail ? { detail } : {});
    },
    async done(detail: string) {
      for (const p of phases) if (p.status === "processing") p.status = "completed";
      await write({ status: "completed", detail });
    },
    jobId,
    async fail(error: unknown) {
      for (const p of phases) if (p.status === "processing") p.status = "failed";
      await write({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error) }).catch(() => undefined);
    },
  };
}
type Progress = ReturnType<typeof attachProgress>;

type RecordRow = { id: string; values: Record<string, string | null> };
type Reader = { total(): Promise<number | null>; pages(fields: string[]): AsyncGenerator<RecordRow[]> };

async function salesforce(ctx: ActionCtx, orgId: Id<"organizations">) {
  const { accessToken, instanceUrl } = await credentialsForOrg(ctx, orgId);
  return async (path: string): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${instanceUrl.replace(/\/$/, "")}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if ((res.status === 429 || res.status === 503) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        // Salesforce errors name the field or object at fault, never record values.
        const body = await res.json().catch(() => null);
        const message = Array.isArray(body) ? body[0]?.message : body?.message;
        throw new ConvexError(`Salesforce ${path.split("?")[0]}: HTTP ${res.status}${message ? ` (${String(message).slice(0, 200)})` : ""}`);
      }
      return res.json();
    }
  };
}

async function readerFor(ctx: ActionCtx, orgId: Id<"organizations">, object: ColumnObject): Promise<Reader> {
  if (COLUMN_OBJECTS[object].system === "hubspot") {
    const get = await hubspotGet(ctx, orgId);
    return {
      async total() {
        try {
          return Number((await get(`/crm/v3/objects/${object}/search`, { method: "POST", body: { limit: 1, filterGroups: [] } })).total ?? 0) || null;
        } catch {
          return null;
        }
      },
      async *pages(fields) {
        const enriched = fields.filter(isEnrichmentName);
        const properties = fields.filter((f) => !isEnrichmentName(f));
        let after: string | undefined;
        do {
          const q = new URLSearchParams({ limit: "100", archived: "false", properties: properties.join(",") });
          if (after) q.set("after", after);
          const page = await get(`/crm/v3/objects/${object}?${q}`);
          const rows: RecordRow[] = (page.results ?? []).map((r: any) => ({
            id: String(r.id),
            values: Object.fromEntries(properties.map((f) => [f, r.properties?.[f] ?? null])),
          }));
          if (enriched.length && rows.length) {
            const matches = await ctx.runQuery(internal.enrichmentMatches.forRecords, { orgId, recordIds: rows.map((r) => r.id) });
            for (const row of rows) for (const f of enriched) row.values[f] = enrichmentValue(f, matches[row.id]);
          }
          yield rows;
          after = page.paging?.next?.after;
        } while (after);
      },
    };
  }
  const sf = await salesforce(ctx, orgId);
  return {
    async total() {
      try {
        return Number((await sf(`/services/data/${SF_API}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${object}`)}`)).totalSize ?? 0);
      } catch {
        return null;
      }
    },
    async *pages(fields) {
      const select = [...new Set(["Id", ...fields])].join(", ");
      let next: string | null = `/services/data/${SF_API}/query?q=${encodeURIComponent(`SELECT ${select} FROM ${object}`)}`;
      while (next) {
        const page: any = await sf(next);
        yield (page.records ?? []).map((r: any) => ({
          id: String(r.Id),
          values: Object.fromEntries(fields.map((f) => [f, r[f] === null || r[f] === undefined ? null : String(r[f])])),
        }));
        next = page.done ? null : page.nextRecordsUrl ?? null;
      }
    },
  };
}

/** Which CRMs the org has connected. */
async function connectedSystems(ctx: ActionCtx, orgId: Id<"organizations">): Promise<CrmSystem[]> {
  const [hs, sf] = await Promise.all([
    ctx.runQuery(internal.hubspot.getIntegration, { orgId }),
    ctx.runQuery(internal.salesforce.getIntegration, { orgId }),
  ]);
  return [...(hs?.isActive ? (["hubspot"] as const) : []), ...(sf?.isActive ? (["salesforce"] as const) : [])];
}

async function columnsFor(ctx: ActionCtx, orgId: Id<"organizations">, system: CrmSystem, keywords: string[]): Promise<Column[]> {
  const out: Column[] = [];
  if (system === "hubspot") {
    const get = await hubspotGet(ctx, orgId);
    for (const object of OBJECTS_BY_SYSTEM.hubspot) {
      const props = await get(`/crm/v3/properties/${object}?archived=false`);
      for (const p of props.results ?? []) {
        const column = hubspotColumn(object, p);
        if (column && matchesConcept(column, keywords)) out.push(column);
      }
    }
    out.push(...enrichmentColumns(keywords));
  } else {
    const sf = await salesforce(ctx, orgId);
    for (const object of OBJECTS_BY_SYSTEM.salesforce) {
      const described = await sf(`/services/data/${SF_API}/sobjects/${object}/describe`);
      for (const f of described.fields ?? []) {
        const column = salesforceColumn(object, f);
        if (column && matchesConcept(column, keywords)) out.push(column);
      }
    }
  }
  return out;
}

export const discover = internalAction({
  args: { id: v.id("fieldConsolidations") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.fieldConsolidations.forAction, { id: args.id, caller: false });
    if (!found) return;
    const { doc } = found;
    try {
      const systems = await connectedSystems(ctx, doc.orgId);
      if (!systems.length) throw new Error("Connect HubSpot or Salesforce first: consolidation reads their columns.");
      const statuses: Array<{ system: string; status: string; detail?: string }> = [];
      const columns: Column[] = [];
      for (const system of systems) {
        try {
          columns.push(...(await columnsFor(ctx, doc.orgId, system, doc.keywords)));
          statuses.push({ system, status: "read" });
        } catch (error) {
          statuses.push({ system, status: "error", detail: error instanceof Error ? error.message : String(error) });
        }
      }
      // Within each object: CRM columns before enrichment sources, picklists first, then the CRM's own columns.
      const order = Object.keys(COLUMN_OBJECTS);
      columns.sort((a, b) =>
        order.indexOf(a.object) - order.indexOf(b.object) || Number(Boolean(a.enrichment)) - Number(Boolean(b.enrichment)) ||
        Number(b.kind === "picklist") - Number(a.kind === "picklist") || Number(b.standard) - Number(a.standard));
      const perObject = new Map<string, number>();
      const kept = columns
        .filter((c) => {
          const n = (perObject.get(c.object) ?? 0) + 1;
          perObject.set(c.object, n);
          return n <= MAX_COLUMNS_PER_OBJECT;
        })
        .slice(0, MAX_COLUMNS);
      const objects = [...new Set(kept.map((c) => c.object))];
      await ctx.runMutation(internal.fieldConsolidations.saveColumns, { id: args.id, columns: kept, systems: statuses, objects });
      for (const object of objects) await ctx.scheduler.runAfter(0, internal.fieldConsolidationActions.profileObject, { id: args.id, object });
    } catch (error) {
      await ctx.runMutation(internal.fieldConsolidations.fail, { id: args.id, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const profileObject = internalAction({
  args: { id: v.id("fieldConsolidations"), object: v.string() },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.fieldConsolidations.forAction, { id: args.id, caller: false });
    if (!found) return;
    const object = args.object as ColumnObject;
    const names = ((found.doc.columns ?? []) as Column[]).filter((c) => c.object === object).map((c) => c.name);
    const link = HUBSPOT_SALESFORCE_LINK[object] ?? [];
    try {
      const reader = await readerFor(ctx, found.doc.orgId, object);
      const total = await reader.total();
      const builder = new ProfileBuilder(names);
      const started = Date.now();
      let read = 0;
      let lastReport = started;
      let capped = false;
      for await (const page of reader.pages([...names, ...link])) {
        for (const row of page) builder.add(row.values, salesforceOwned(object, row.values));
        read += page.length;
        if (Date.now() - lastReport > 3000) {
          lastReport = Date.now();
          await ctx.runMutation(internal.fieldConsolidations.profileProgress, { id: args.id, object, read });
        }
        if (Date.now() - started > READ_BUDGET_MS || read >= MAX_RECORDS) {
          capped = true;
          break;
        }
      }
      await ctx.runMutation(internal.fieldConsolidations.saveProfile, { id: args.id, object, profile: builder.result(object, total, capped) });
    } catch (error) {
      await ctx.runMutation(internal.fieldConsolidations.saveProfile, { id: args.id, object, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

// ── Mapping suggestions ──────────────────────────────────────────────────────

type Setup = {
  doc: Doc<"fieldConsolidations">;
  userId: Id<"users">;
  field: FieldDefinition;
  /** The columns the field writes or shadows, in order; turned-off ones are left out. */
  destinations: Array<{ column: Column; mode: DestinationMode }>;
  sources: Column[];
  map: Map<string, MapEntry>;
  scales: ScaleEntry[];
  policy: Policy;
  measure: Measure;
};

async function setup(ctx: ActionCtx, id: Id<"fieldConsolidations">): Promise<Setup> {
  const found = await ctx.runQuery(internal.fieldConsolidations.forAction, { id, caller: true });
  if (!found?.userId) throw new ConvexError("Consolidation not found");
  const { doc, userId } = found;
  const list = (doc.columns ?? []) as Column[];
  const columns = new Map(list.map((c) => [c.key, c]));
  const field = fieldDefinition(doc, list);
  if (!field) throw new ConvexError("Define the field first.");
  return {
    doc,
    userId,
    field,
    destinations: destinationsOf(doc).flatMap((d) => {
      const column = columns.get(d.column);
      return column && d.mode !== "off" ? [{ column, mode: d.mode }] : [];
    }),
    sources: (doc.sources ?? []).map((k) => columns.get(k)).filter((c): c is Column => Boolean(c)),
    map: mapOf(doc.valueMap ?? []),
    scales: doc.scales ?? [],
    policy: doc.policy ?? DEFAULT_POLICY,
    measure: field.measure,
  };
}

/** Source values per model call, and calls in flight at once. */
const SUGGEST_BATCH = 50;
const SUGGEST_PARALLEL = 3;

const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "The source value, exactly as given." },
          target: { type: ["string", "null"], description: "The internal value of the one target option it means, or null when none fits." },
          confidence: { type: "number", description: "0 to 1: how sure the source value means that option." },
        },
        required: ["source", "target", "confidence"],
      },
    },
  },
  required: ["mappings"],
};

/**
 * Suggest mappings for source values the map doesn't cover: first the values that name a target option, then (when
 * the user has connected ChatGPT) a model's pick and confidence for the rest. Suggestions never replace a user's edit.
 */
export const suggest = action({
  args: { id: v.id("fieldConsolidations"), ai: v.boolean() },
  handler: async (ctx, args): Promise<{ added: number; ai: "done" | "no_llm" | "skipped" | "failed"; detail?: string }> => {
    const s = await setup(ctx, args.id);
    const profiles = (await ctx.runQuery(api.fieldConsolidations.get, { id: args.id }))?.profiles ?? [];
    // A quantity has no value map: suggest each source's scale into the standard's units from the values read.
    if (s.measure === "quantity") {
      const suggested = suggestScales({
        profiles: new Map(profiles.flatMap((p) => (p.profile ? [[p.object, p.profile as ObjectProfile] as const] : []))),
        // Amounts scale into the destinations' units, or the column the field was defined from.
        destinations: [...s.destinations.map((d) => d.column), ...((s.doc.columns ?? []) as Column[]).filter((c) => c.key === s.doc.optionsFrom || c.key === s.doc.target)],
        sources: s.sources,
        scales: s.scales,
      });
      const kept = s.scales.filter((e) => e.origin === "user" || !s.sources.some((c) => c.key === e.column));
      await ctx.runMutation(api.fieldConsolidations.setScales, { id: args.id, scales: [...kept, ...suggested] });
      return { added: suggested.length, ai: "skipped" };
    }
    // Every distinct source value with its record count, by map key.
    const counts = new Map<string, { value: string; n: number }>();
    for (const column of s.sources) {
      const profile = profiles.find((p) => p.object === column.object)?.profile as ObjectProfile | null;
      for (const [value, n] of profile?.columns[column.name]?.values ?? []) {
        const key = mapKey(value);
        const prev = counts.get(key);
        counts.set(key, { value: prev?.value ?? value, n: (prev?.n ?? 0) + n });
      }
    }
    const open = [...counts.entries()].filter(([key]) => !s.map.has(key)).sort((a, b) => b[1].n - a[1].n);
    const added: MapEntry[] = autoMap(open.map(([, c]) => c.value), s.field.options);
    const auto = new Set(added.map((e) => e.from));
    let ai: "done" | "no_llm" | "skipped" | "failed" = "skipped";
    let detail: string | undefined;
    const rest = open.filter(([key]) => !auto.has(key)).slice(0, 300);
    if (args.ai && rest.length) {
      const llm = await resolveLlm(ctx, s.userId);
      if (!llm) ai = "no_llm";
      else {
        const progress = await startProgress(ctx, args.id, s.userId, "suggest", `Asking the AI about ${rest.length} unmapped values`, [
          { key: "exact", label: `${added.length} exact matches`, status: "completed" },
          { key: "ai", label: "Values the AI has mapped", status: "processing", done: 0, total: rest.length },
        ]);
        const aiPhase = progress.phases[1]!;
        try {
          const options = s.field.options.map((o) => `- ${o.value}: ${o.label}${isCatchAll(o) ? " (catch-all)" : ""}`).join("\n");
          const batches: Array<typeof rest> = [];
          for (let i = 0; i < rest.length; i += SUGGEST_BATCH) batches.push(rest.slice(i, i + SUGGEST_BATCH));
          // A few batches at once: each call takes a while, and the model's answers don't depend on each other. After a
          // failure no new batch starts, and every call in flight finishes before the map is saved.
          let failure: unknown = null;
          await Promise.all(Array.from({ length: Math.min(SUGGEST_PARALLEL, batches.length) }, async () => {
            for (let batch = batches.shift(); batch && !failure; batch = batches.shift()) {
              try {
                const prompt = `You standardize a CRM field called "${s.doc.concept}". Map each source value to the one target option it means. Use a catch-all option only when no specific option fits, and null when the value says nothing about ${s.doc.concept}. Answer with each option's internal value.\n\nTarget options (internal value: label):\n${options}\n\nSource values:\n${batch.map(([, c]) => `- ${c.value}`).join("\n")}`;
                const result = (await forcedToolCall(prompt, "map_values", SUGGEST_SCHEMA, llm.model ?? DEFAULT_MODELS[llm.provider], llm)) as {
                  mappings?: Array<{ source?: string; target?: string | null; confidence?: number }>;
                };
                const valid = new Set(s.field.options.map((o) => o.value));
                for (const m of result.mappings ?? []) {
                  const from = m.source ? mapKey(m.source) : "";
                  if (!from || !counts.has(from) || auto.has(from) || added.some((e) => e.from === from)) continue;
                  const to = m.target && valid.has(m.target) ? m.target : m.target ? (optionFor(m.target, s.field.options)?.value ?? null) : null;
                  added.push({ from, to, origin: "ai", confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0)) });
                }
                aiPhase.done = (aiPhase.done ?? 0) + batch.length;
                await progress.tick(`${added.length} suggestions so far`);
              } catch (error) {
                failure ??= error;
              }
            }
          }));
          if (failure) throw failure;
          ai = "done";
          await progress.done(`${added.length} suggestions to review`);
        } catch (error) {
          ai = "failed";
          detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
          await progress.fail(error);
        }
      }
    }
    if (added.length) {
      const entries = [...s.map.values(), ...added].slice(0, MAX_MAP_ENTRIES);
      await ctx.runMutation(api.fieldConsolidations.setMap, { id: args.id, entries });
    }
    return { added: added.length, ai, ...(detail ? { detail } : {}) };
  },
});

// ── Decisions: preview, then apply and undo as one run ───────────────────────

export type PreviewRow = {
  kind: DecisionKind;
  id: string;
  name: string | null;
  current: string | null;
  /** The value exactly as the CRM holds it, which compare-and-set checks before writing. */
  before: string | null;
  proposed: string | null;
  column: string | null;
  raw: string | null;
  confidence: number | null;
};

type Section = {
  measure: Measure;
  /** Shadow: shown, never written. */
  mode: DestinationMode;
  object: ColumnObject;
  system: CrmSystem;
  column: Column;
  read: number;
  total: number | null;
  capped: boolean;
  counts: Record<DecisionKind, number>;
  /** Value changes by from → to, most common first. */
  changes: Array<{ from: string; to: string; count: number }>;
  fills: Array<{ to: string; count: number }>;
  /** Fills and changes by the label of the source column that decided them. */
  bySource: Record<string, number>;
  /** Records whose column is still blank after the run (not owned by Salesforce). */
  blank: number;
  samples: PreviewRow[];
  /** Every record that isn't "agrees" or "no source", for the CSV. */
  rows: PreviewRow[];
  /** Every fill and change: the run's writes. */
  writes: PreviewRow[];
};

const EMPTY_COUNTS = (): Record<DecisionKind, number> => ({ fill: 0, change: 0, agree: 0, kept: 0, protected: 0, noSource: 0, missingOption: 0, salesforceOwned: 0 });

type Read = { object: ColumnObject; records: CrmRecord[]; total: number | null; capped: boolean };

/** Read every record of one object with the columns a run needs, a page at a time, within the read budget. */
async function readObject(ctx: ActionCtx, s: Setup, object: ColumnObject, fields: string[], phase: JobPhase, progress: Progress): Promise<Read> {
  const reader = await readerFor(ctx, s.doc.orgId, object);
  const total = await reader.total();
  if (total !== null) {
    phase.total = total;
    await progress.tick(undefined, true);
  }
  const records: CrmRecord[] = [];
  const started = Date.now();
  let capped = false;
  for await (const page of reader.pages(fields)) {
    for (const record of page) records.push({ object, id: record.id, values: record.values });
    phase.done = records.length;
    if (phase.total === undefined) phase.note = `${records.length.toLocaleString("en-US")} read`;
    await progress.tick();
    if (Date.now() - started > READ_BUDGET_MS || records.length >= MAX_RECORDS) {
      capped = true;
      break;
    }
  }
  phase.status = "completed";
  return { object, records, total, capped };
}

/** Canon records looked up per query, values saved per mutation, and shards saving at once while a preview runs. */
const RESOLVE_PAGE = 400;
const STORE_PAGE = 50;
const STORE_LANES = 16;

/**
 * Save each Canon record's value onto Canon's company or person (docs/canon-fields-above-the-crm.md), found by the CRM
 * ids of its records. A Canon record with no value is left alone: the field has nothing to say, which is not a clear.
 * A record already holding the value from a Canon field is skipped before the write. The rest save one ledger shard
 * per lane, the lanes side by side: every ledger write bumps its shard's head, so writes to different shards never
 * collide with each other.
 */
async function storeValues(ctx: ActionCtx, s: Setup, runId: Id<"fieldConsolidationRuns">, groups: readonly CrmRecord[][], canonOf: ReadonlyMap<CrmRecord, CanonValue>, progress: Progress) {
  const attribute = s.doc.attribute ?? canonAttribute(s.doc.concept, s.field, [s.doc.optionsFrom ?? s.doc.target ?? "", ...s.destinations.map((d) => d.column.key)]);
  const kind = s.field.level === "account" ? "account" : "contact";
  const rows = groups.flatMap((group) => {
    const value = canonOf.get(group[0]!);
    if (!value) return [];
    return [{
      ids: group.map((r) => ({ provider: `${COLUMN_OBJECTS[r.object].system}:${kind}`, externalId: r.id })),
      value: canonFactValue(value, s.field, attribute),
      evidence: `${s.doc.concept}: ${value.evidence.raw.includes(": ") ? value.evidence.raw : `${value.evidence.column} is "${value.evidence.raw}"`}`.slice(0, 300),
    }];
  });
  const phase: JobPhase = { key: "canon", label: "Saving values in Canon", status: "processing", total: rows.length, done: 0 };
  progress.phases.push(phase);
  const stored = { written: 0, unchanged: 0, missing: 0 };
  const lanes = new Map<number, Array<{ entityId: Id<"canonEntities">; value: string | number; evidence: string }>>();
  for (let i = 0; i < rows.length; i += RESOLVE_PAGE) {
    const page = rows.slice(i, i + RESOLVE_PAGE);
    const found = await ctx.runQuery(internal.fieldConsolidations.resolveForStore, { orgId: s.doc.orgId, attribute, rows: page.map(({ ids, value }) => ({ ids, value })) });
    found.forEach((hit, j) => {
      if (!hit) stored.missing++;
      else if (hit.held) stored.unchanged++;
      else lanes.set(hit.shard, [...(lanes.get(hit.shard) ?? []), { entityId: hit.entityId, value: page[j]!.value, evidence: page[j]!.evidence }]);
    });
  }
  phase.done = stored.missing + stored.unchanged;
  await progress.tick(undefined, true);
  const at = Date.now();
  const queue = [...lanes.values()];
  await Promise.all(Array.from({ length: Math.min(STORE_LANES, queue.length) }, async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (let i = 0; i < lane.length; i += STORE_PAGE) {
        const counts = await ctx.runMutation(internal.fieldConsolidations.storeValues, { id: s.doc._id, runId, attribute, object: kind, at, rows: lane.slice(i, i + STORE_PAGE) });
        stored.written += counts.written;
        stored.unchanged += counts.unchanged;
        phase.done = (phase.done ?? 0) + Math.min(STORE_PAGE, lane.length - i);
        await progress.tick();
      }
    }
  }));
  await ctx.runMutation(internal.fieldConsolidations.recordStored, { id: s.doc._id, runId, attribute, stored });
  phase.status = "completed";
}

/** Each destination column's records against their Canon records' values: the counts, samples and writes of a section. */
function decideColumn(s: Setup, column: Column, mode: DestinationMode, read: Read, canonOf: ReadonlyMap<CrmRecord, CanonValue>): Section {
  const object = column.object;
  const nameField = NAME_FIELD[object];
  const quantity = s.measure === "quantity";
  const counts = EMPTY_COUNTS();
  const changes = new Map<string, number>();
  const largest: Array<{ from: string; to: string; count: number; move: number }> = [];
  const fills = new Map<string, number>();
  const bySource: Record<string, number> = {};
  let blank = 0;
  const samples: PreviewRow[] = [];
  const perKind = new Map<DecisionKind, number>();
  const rows: PreviewRow[] = [];
  const writes: PreviewRow[] = [];
  for (const record of read.records) {
    const current = cleanValue(record.values[column.name]);
    // Salesforce owns a linked HubSpot record: it is fixed there and the sync carries it over.
    const decision = salesforceOwned(object, record.values)
      ? { kind: "salesforceOwned" as const, current, proposed: null, evidence: null }
      : decideDestination(current, canonOf.get(record) ?? null, s.field, column, s.policy);
    counts[decision.kind]++;
    const row: PreviewRow = {
      kind: decision.kind, id: record.id, name: cleanValue(record.values[nameField]), current: decision.current, before: record.values[column.name] ?? null, proposed: decision.proposed,
      column: decision.evidence?.column ?? null, raw: decision.evidence?.raw ?? null, confidence: decision.evidence?.confidence ?? null,
    };
    if (decision.kind === "change") {
      // A quantity's changes are kept by how far they move a value, so the largest show first; a category's by from → to.
      if (quantity) largest.push({ from: decision.current!, to: decision.proposed!, count: 1, move: Math.abs(Math.log10(Number(decision.proposed) / (parseQuantity(decision.current!)?.amount ?? 1))) || 0 });
      else changes.set(`${decision.current}\u0000${decision.proposed}`, (changes.get(`${decision.current}\u0000${decision.proposed}`) ?? 0) + 1);
    }
    if (decision.kind === "fill") {
      const key = quantity ? magnitudeBand(Number(decision.proposed)) : decision.proposed!;
      fills.set(key, (fills.get(key) ?? 0) + 1);
    }
    if (decision.kind === "fill" || decision.kind === "change") {
      writes.push(row);
      // By the source column's key: two CRMs can name a column alike.
      const source = decision.evidence?.source ?? row.column!;
      bySource[source] = (bySource[source] ?? 0) + 1;
    } else if (decision.current === null && decision.kind !== "salesforceOwned") blank++;
    if (decision.kind !== "agree" && decision.kind !== "noSource") rows.push(row);
    const n = perKind.get(decision.kind) ?? 0;
    if (n < SAMPLES_PER_KIND && decision.kind !== "noSource") {
      perKind.set(decision.kind, n + 1);
      samples.push(row);
    }
  }
  return {
    measure: s.measure, mode, object, system: COLUMN_OBJECTS[object].system, column, read: read.records.length, total: read.total, capped: read.capped, counts,
    changes: quantity
      ? largest.sort((a, b) => b.move - a.move).slice(0, 50).map(({ from, to, count }) => ({ from, to, count }))
      : [...changes].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, count]) => {
        const [from, to] = k.split("\u0000");
        return { from: from!, to: to!, count };
      }),
    fills: [...fills].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([to, count]) => ({ to, count })),
    bySource, blank, samples, rows, writes,
  };
}

/** The canonical field a raw CRM column name would be rewritten to by the org's field mappings (null when untouched). */
function remappedName(system: CrmSystem, object: ColumnObject, name: string, mappings: FieldMappings | undefined): string | null {
  const type = COLUMN_OBJECTS[object].level === "account" ? "accounts" : "contacts";
  const defaults = (system === "hubspot" ? HUBSPOT_DEFAULT_FIELD_MAPPINGS : SALESFORCE_DEFAULT_FIELD_MAPPINGS)[type] ?? {};
  const resolved = mappedField(mappings, type, name, defaults[name] ?? name);
  return resolved === name ? null : resolved;
}

/** Refuse a column Canon can't write, or one the workspace's field mappings would send to another column. */
async function checkWritable(ctx: ActionCtx, orgId: Id<"organizations">, columns: Array<{ object: ColumnObject; name: string }>) {
  for (const column of columns) {
    const system = COLUMN_OBJECTS[column.object].system;
    if (!writableColumn(column)) throw new ConvexError(`${COLUMN_OBJECTS[column.object].label} ${column.name} can't be written by Canon.`);
    const mappings = system === "hubspot" ? (await accessTokenForOrg(ctx, orgId)).fieldMappings : (await credentialsForOrg(ctx, orgId)).fieldMappings;
    const remapped = remappedName(system, column.object, column.name, mappings);
    if (remapped) {
      throw new ConvexError(`This workspace's ${system} field mappings rewrite ${column.name} to ${remapped}, so a write would land in the wrong column. Remove that mapping or choose another column.`);
    }
  }
}

const writeSummary = (sections: Array<Pick<Section, "counts">>) => {
  const n = (k: DecisionKind) => sections.reduce((sum, x) => sum + x.counts[k], 0).toLocaleString("en-US");
  return `${n("fill")} to fill, ${n("change")} to change, ${n("agree")} already agree`;
};

/** Writes saved per mutation while a preview finishes. */
const WRITE_PAGE = 500;

/**
 * Decide every record of the standard column and its counterpart against the map and policy, and save the result as
 * a run: the summary the page shows, a CSV of every record that isn't "agrees" or "no source", and the writes an
 * apply makes. Nothing is written to a CRM. The page shows the saved run again after a reload or a visit elsewhere.
 */
export const preview = action({
  args: { id: v.id("fieldConsolidations") },
  handler: async (ctx, args): Promise<Id<"fieldConsolidationRuns">> => {
    const s = await setup(ctx, args.id);
    if (!s.destinations.length) throw new ConvexError("Add a destination first: a column the field writes or shadows.");
    const runId = await ctx.runMutation(internal.fieldConsolidations.startRun, { id: args.id, userId: s.userId, settingsVersion: s.doc.settingsVersion ?? 0 });
    // Every object a destination or a source lives on, read once with the columns this run needs.
    const objects = [...new Set([...s.destinations.map((d) => d.column.object), ...s.sources.map((c) => c.object)])];
    const progress = await startProgress(ctx, args.id, s.userId, "preview", "Reading every record", objects.map((object) => ({ key: object, label: `Reading ${COLUMN_OBJECTS[object].label}`, status: "processing" })));
    try {
      const reads = await Promise.all(objects.map((object, i) => {
        const fields = [
          ...s.destinations.filter((d) => d.column.object === object).map((d) => d.column.name),
          ...s.sources.filter((c) => c.object === object).map((c) => c.name),
          NAME_FIELD[object], ...(HUBSPOT_SALESFORCE_LINK[object] ?? []),
        ];
        return readObject(ctx, s, object, [...new Set(fields)], progress.phases[i]!, progress);
      }));
      // One value per Canon record: the records HubSpot links to Salesforce decide together.
      const groups = canonRecords(reads.flatMap((r) => r.records));
      const canonOf = new Map<CrmRecord, CanonValue>();
      for (const group of groups) {
        const value = canonValue(group, s.sources, s.field, s.map, s.scales, s.policy);
        for (const record of group) canonOf.set(record, value);
      }
      await storeValues(ctx, s, runId, groups, canonOf, progress);
      const sections = s.destinations.map((d) => decideColumn(s, d.column, d.mode, reads.find((r) => r.object === d.column.object)!, canonOf));
      const written = sections.filter((x) => x.mode !== "shadow" && x.writes.length);
      if (written.length) await checkWritable(ctx, s.doc.orgId, written.map((x) => x.column));
      progress.phases.push({ key: "save", label: "Saving the proposed writes", status: "processing", done: 0, total: written.reduce((sum, x) => sum + x.writes.length, 0) });
      const saving = progress.phases[progress.phases.length - 1]!;
      for (const section of written) {
        const labelOf = new Map(section.column.options.map((o) => [o.value, o.label]));
        const label = (value: string | null) => (value === null ? "(blank)" : labelOf.get(value) ?? value);
        const objectType = COLUMN_OBJECTS[section.object].level === "account" ? ("account" as const) : ("contact" as const);
        for (let i = 0; i < section.writes.length; i += WRITE_PAGE) {
          const writes = section.writes.slice(i, i + WRITE_PAGE).map((w) => ({
            provider: section.system, objectType, recordId: w.id, field: section.column.name, before: w.before, after: w.proposed!,
            kind: w.kind as "fill" | "change",
            reason: (s.measure === "quantity"
              ? `${w.name ?? w.id}: ${COMBINE_LABEL[s.policy.combine ?? "first"].toLowerCase()} (${w.raw?.includes(": ") ? w.raw : `${w.column}: ${w.raw}`}) is ${w.proposed}${w.current ? ` (was ${w.current})` : ""}.`
              : `${w.name ?? w.id}: ${w.column} is "${w.raw}", which maps to ${label(w.proposed)}${w.current ? ` (was ${label(w.current)})` : ""}.`).slice(0, 300),
          }));
          await ctx.runMutation(internal.fieldConsolidations.insertWrites, { runId, writes });
          saving.done = (saving.done ?? 0) + writes.length;
          await progress.tick();
        }
      }
      const csvRows = sections.flatMap((x) => {
        const labelOf = new Map(x.column.options.map((o) => [o.value, o.label]));
        const label = (value: string | null) => (value === null ? "" : labelOf.get(value) ?? value);
        const destination = `${x.column.label} (${COLUMN_OBJECTS[x.object].label})`;
        return x.rows.map((r) => [destination, x.mode, x.object, r.id, r.name, DECISION_LABEL[r.kind], label(r.current), label(r.proposed), r.column, r.raw, r.confidence]);
      });
      const csv = toCsv(["destination", "mode", "object", "record_id", "record", "decision", "current", "proposed", "source_column", "source_value", "confidence"], csvRows);
      const csvId = await ctx.storage.store(new Blob([csv], { type: "text/csv" }));
      const summary = sections.map(({ writes: _writes, rows: _rows, column, ...rest }) => ({
        ...rest, column: { key: column.key, label: column.label, name: column.name, options: column.options },
      }));
      await ctx.runMutation(internal.fieldConsolidations.finishPreview, { runId, sections: JSON.parse(JSON.stringify(summary)), csv: csvId, csvRows: csvRows.length });
      await progress.done(writeSummary(sections.filter((x) => x.mode !== "shadow")));
      return runId;
    } catch (error) {
      await ctx.runMutation(internal.fieldConsolidations.failRun, { runId, during: "preview", error: error instanceof Error ? error.message : String(error) });
      await progress.fail(error);
      throw error;
    }
  },
});

/** CRM values compare as compare-and-set does: blank and missing are the same. */
const sameValue = (a: unknown, b: unknown) => (a === undefined || a === null || a === "" ? null : String(a)) === (b === undefined || b === null || b === "" ? null : String(b));

/** Writes per connector call, and how long one action writes before handing the rest to the next. */
const WRITE_CHUNK = 200;
const WRITE_BUDGET_MS = 4 * 60_000;

/**
 * Apply (or undo) a run, a chunk at a time, through the engine's applyPatchPlan: each write is compared with the value
 * the preview saw (for an undo, the value the apply wrote) and skipped as a conflict when the record changed since.
 * A chunk records its outcomes before the next starts; an action that runs out of time schedules the next one.
 */
export const writeRun = internalAction({
  args: {
    runId: v.id("fieldConsolidationRuns"),
    mode: v.union(v.literal("apply"), v.literal("undo")),
    userId: v.id("users"),
    first: v.boolean(),
    jobId: v.optional(v.id("backgroundJobs")),
    // Retry an applied run's failed writes instead of applying pending ones.
    retry: v.optional(v.boolean()),
    // Writes this apply, undo or retry has handled so far, carried from one chunk's action to the next.
    done: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // A retry puts the failed writes back where they wait (pending, or applied for an undo) first, then handles them
    // like any other.
    let requeued = 0;
    if (args.retry && args.first) {
      for (;;) {
        const n = await ctx.runMutation(internal.fieldConsolidations.requeueFailed, { runId: args.runId, mode: args.mode });
        if (!n) break;
        requeued += n;
      }
    }
    const found = await ctx.runQuery(internal.fieldConsolidations.runForAction, { runId: args.runId });
    if (!found) return;
    const { run, doc } = found;
    // Shadow sections are shown, never written, so only the others are checked.
    const sections = ((run.sections ?? []) as Array<{ object: ColumnObject; system: CrmSystem; mode?: DestinationMode; column: { name: string } }>).filter((x) => x.mode !== "shadow");
    const counts = () => (args.mode === "apply" ? run.applied : run.undone) ?? { applied: 0, conflict: 0, failed: 0 };
    const tally = { ...counts() };
    const total = args.mode === "apply" ? run.writes : (run.applied?.applied ?? 0);
    const phase: JobPhase = { key: "writes", label: args.mode === "apply" ? "Records written" : "Records put back", status: "processing", total, done: 0 };
    let done = args.done ?? tally.applied + tally.conflict + tally.failed;
    const describe = () =>
      `${tally.applied.toLocaleString("en-US")} ${args.mode === "apply" ? "written" : "put back"}` +
      (tally.conflict ? ` · ${tally.conflict.toLocaleString("en-US")} changed since, left alone` : "") +
      (tally.failed ? ` · ${tally.failed.toLocaleString("en-US")} failed` : "");
    const sync = () => { phase.done = done; };
    sync();
    const progress = args.jobId
      ? attachProgress(ctx, args.jobId, [phase])
      : await startProgress(ctx, doc._id, args.userId, args.mode, args.retry ? `Retrying ${requeued.toLocaleString("en-US")} failed ${args.mode === "apply" ? "writes" : "undo writes"}` : args.mode === "apply" ? `Writing ${total.toLocaleString("en-US")} changes` : `Putting back ${total.toLocaleString("en-US")} values`, [phase]);
    try {
      // Every action, both ways: a field mapping added since would send the saved column name somewhere else.
      await checkWritable(ctx, doc.orgId, sections.map((x) => ({ object: x.object, name: x.column.name })));
      const connectors = new Map<CrmSystem, GtmConnector>();
      const connector = async (system: CrmSystem) => {
        if (!connectors.has(system)) {
          connectors.set(system, system === "hubspot" ? await hubspotConnectorForOrg(ctx, doc.orgId) : (await salesforceConnectorForOrg(ctx, doc.orgId)).connector);
        }
        return connectors.get(system)!;
      };
      const started = Date.now();
      while (Date.now() - started < WRITE_BUDGET_MS) {
        const batch = await ctx.runQuery(internal.fieldConsolidations.nextWrites, { runId: run._id, mode: args.mode, limit: WRITE_CHUNK });
        if (!batch.length) {
          await ctx.runMutation(internal.fieldConsolidations.finishWriting, { runId: run._id, mode: args.mode, userId: args.userId });
          await progress.done(describe());
          for (const system of new Set(sections.map((x) => x.system))) {
            await ctx.scheduler.runAfter(0, system === "salesforce" ? internal.salesforceActions.syncAllInternal : internal.hubspotActions.syncAllInternal, { orgId: doc.orgId, trigger: "system" });
          }
          return;
        }
        for (const system of ["hubspot", "salesforce"] as const) {
          const writes = batch.filter((w) => w.provider === system);
          if (!writes.length) continue;
          const operations: PatchOperation[] = writes.map((w) => {
            const [from, to] = args.mode === "apply" ? [w.before, w.after] : [w.after, w.before];
            return {
              id: w._id,
              objectType: w.objectType,
              objectId: w.recordId,
              operation: to === null || to === "" ? "clear_field" : "set_field",
              field: w.field,
              beforeValue: from,
              afterValue: to,
              reason: args.mode === "apply" ? w.reason : `Undo consolidation: put ${w.field} back to ${w.before ?? "blank"}.`,
              riskLevel: w.kind === "change" || args.mode === "undo" ? "medium" : "low",
              approvalRequired: true,
              sourceRuleOrPolicy: args.mode === "apply" ? "consolidate.field" : "consolidate.undo",
            } as PatchOperation;
          });
          const plan = {
            id: `consolidate_${args.mode}_${run._id}_${Date.now()}`,
            title: `${args.mode === "apply" ? "Consolidate" : "Undo consolidation of"} ${doc.concept}`,
            createdAt: new Date().toISOString(),
            status: "approved",
            dryRun: false,
            summary: `${operations.length} write(s) of an approved consolidation run.`,
            findings: [],
            operations,
          } as unknown as PatchPlan;
          // Writes an earlier action sent without recording what happened: this run may already have changed them.
          const sentBefore = new Set(writes.filter((w) => w.status === "writing" || w.status === "unwriting").map((w) => w._id));
          // Connect first: only a chunk about to reach the CRM is marked sent.
          const crm = await connector(system);
          await ctx.runMutation(internal.fieldConsolidations.markSent, { ids: writes.map((w) => w._id), mode: args.mode });
          const result = await applyPatchPlan(crm, plan, { approvedOperationIds: operations.map((o) => o.id), checkConflicts: true });
          const byId = new Map(result.results.map((r) => [r.operationId, r]));
          const results = writes.map((w) => {
            const r = byId.get(w._id);
            // A write an earlier action sent whose record now holds the value it sets: that attempt wrote it and its
            // outcome was lost, so it counts as written and the run can still undo it. Only for writes already sent:
            // a matching value on a record never sent was set by someone else.
            const target = args.mode === "apply" ? w.after : w.before;
            const holds = sentBefore.has(w._id) && r?.status === "conflict" && sameValue((r.providerData as { currentValue?: unknown } | undefined)?.currentValue, target);
            const outcome = r?.status === "applied" || holds ? ("applied" as const) : r?.status === "conflict" ? ("conflict" as const) : ("failed" as const);
            tally[outcome]++;
            const detail = holds ? undefined : r?.detail ?? (r ? undefined : "No result from the connector");
            return { id: w._id, outcome, ...(detail && outcome !== "applied" ? { detail } : {}) };
          });
          // These records were written: keep trying to record it, since a lost record can't be undone.
          for (let attempt = 0; ; attempt++) {
            try {
              await ctx.runMutation(internal.fieldConsolidations.recordWrites, { runId: run._id, mode: args.mode, results });
              break;
            } catch (error) {
              if (attempt >= 4) throw error;
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
          done += results.length;
          sync();
          await progress.tick(describe());
        }
      }
      await ctx.scheduler.runAfter(0, internal.fieldConsolidationActions.writeRun, { ...args, first: false, jobId: progress.jobId, done });
    } catch (error) {
      await ctx.runMutation(internal.fieldConsolidations.failRun, { runId: run._id, during: args.mode, error: error instanceof Error ? error.message : String(error) });
      await progress.fail(error);
    }
  },
});

/**
 * Undo a patch plan an earlier version of this page created (before runs applied as one unit): a new plan that puts
 * every applied value back. It needs approval like any plan, and its compare-and-set skips a record someone changed
 * after the consolidation wrote it.
 */
export const createUndoPlan = action({
  args: { id: v.id("fieldConsolidations"), patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args): Promise<{ patchPlanId: Id<"patchPlans">; operations: number }> => {
    const s = await setup(ctx, args.id);
    const applied = await ctx.runQuery(internal.fieldConsolidations.appliedOperations, { id: args.id, patchPlanId: args.patchPlanId });
    if (!applied.operations.length) throw new ConvexError("That plan has no applied changes to undo yet.");
    const now = new Date();
    const ops: PatchOperation[] = applied.operations.map((op) => ({
      id: `consolidate_undo:${op.objectType}:${op.objectId}:${op.field}`,
      objectType: op.objectType as PatchOperation["objectType"],
      objectId: op.objectId,
      operation: op.beforeValue === null || op.beforeValue === "" ? "clear_field" : "set_field",
      field: op.field,
      beforeValue: op.afterValue,
      afterValue: op.beforeValue,
      reason: `Undo consolidation: put ${op.field} back to ${op.beforeValue ?? "blank"}.`,
      riskLevel: "medium",
      approvalRequired: true,
      sourceRuleOrPolicy: "consolidate.undo",
    }));
    const plan = {
      id: `consolidate_undo_${now.getTime()}`,
      title: `Undo consolidation of ${s.doc.concept}`,
      createdAt: now.toISOString(),
      status: "needs_approval",
      dryRun: true,
      summary: `Put back ${ops.length} value(s) a consolidation plan wrote. Records changed since then are left alone.`,
      findings: [],
      operations: ops,
    } as PatchPlan;
    const { patchPlanId } = await ctx.runMutation(internal.hygiene.persistRulePlan, {
      userId: s.userId,
      orgId: s.doc.orgId,
      rule: "consolidate.undo",
      summary: plan.summary,
      operations: ops.map((operation) => ({ ...operation, packageOpId: operation.id })),
      document: JSON.parse(JSON.stringify(plan)),
      foundOperationCount: ops.length,
      provider: applied.provider as CrmSystem,
    });
    await ctx.runMutation(internal.fieldConsolidations.recordPlans, {
      id: args.id,
      plans: [{ patchPlanId, provider: applied.provider, operations: ops.length, kind: "undo" }],
    });
    return { patchPlanId, operations: ops.length };
  },
});

