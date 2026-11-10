/**
 * Salesforce metadata import (Phase 1b, workstream A).
 *
 * `importMetadata` describes every queryable object in the connected org and
 * stores objects and fields with a default sync authority per field. Custom
 * objects (and synced standard objects with no typed record-service table)
 * are defined in the workspace record service via `objects/define`.
 *
 * Auth reuses the existing connection: tokens come only from
 * internal.salesforceActions.getOrgAccessToken, and a 401 triggers
 * internal.salesforceActions.refreshAccessToken.
 */
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEV_ORG_CLERK_ID, getCurrentUser, requireCap } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";
import {
  importMetadataCore, objectDef, soql, TYPED_OBJECTS, type FieldMeta, type SfConn,
} from "../engine/src/connectors/salesforce/index.ts";

const API_VERSION = "v62.0";
/** Clerk id of the dedicated org devSeedTokens creates when the demo org is absent. */
const SF_TEST_ORG_CLERK_ID = "p1b_sf_sync_test_org";
const authority = v.union(v.literal("fsgtm"), v.literal("salesforce"), v.literal("newest"), v.literal("review"));
const fieldMetaV = v.object({
  object: v.string(),
  apiName: v.string(),
  label: v.string(),
  type: v.string(),
  picklistValues: v.optional(v.array(v.string())),
  referenceTo: v.optional(v.array(v.string())),
  updateable: v.boolean(),
  syncAuthority: authority,
  mappedTo: v.optional(v.string()),
});

type ImportSummary = {
  objects: number;
  fields: number;
  syncEnabled: string[];
  defined: number;
  recordService: "defined" | "not_configured" | "failed";
  failed: Array<{ apiName: string; error: string }>;
};

// ---------- queries / mutations ----------

export const listObjects = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("objectDefinitions")
      .withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", user.orgId).eq("provider", "salesforce"))
      .take(5000);
  },
});

export const listFields = query({
  args: { object: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("fieldDefinitions")
      .withIndex("by_orgId_and_object_and_apiName", (q) => q.eq("orgId", user.orgId).eq("object", args.object))
      .take(2000);
  },
});

export const setObjectSyncEnabled = mutation({
  args: { apiName: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "integrations.manage");
    const row = await ctx.db
      .query("objectDefinitions")
      .withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", user.orgId).eq("provider", "salesforce").eq("apiName", args.apiName))
      .unique();
    if (!row) throw new ConvexError(`Unknown object ${args.apiName}`);
    await ctx.db.patch(row._id, { syncEnabled: args.enabled });
    return null;
  },
});

/** Resolves the caller's org for the public action; admins and managers only. */
export const callerOrg = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"organizations">> => {
    const user = await requireCap(ctx, "integrations.manage");
    return user.orgId;
  },
});

/** Upserts one described object and its fields. Keeps user choices (syncEnabled, syncAuthority) on re-import. */
export const saveObject = internalMutation({
  args: {
    orgId: v.id("organizations"),
    object: v.object({ apiName: v.string(), label: v.string(), isCustom: v.boolean(), syncEnabled: v.boolean() }),
    fields: v.array(fieldMetaV),
    describedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("objectDefinitions")
      .withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", args.orgId).eq("provider", "salesforce").eq("apiName", args.object.apiName))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { label: args.object.label, isCustom: args.object.isCustom, describedAt: args.describedAt });
    } else {
      await ctx.db.insert("objectDefinitions", { orgId: args.orgId, provider: "salesforce", ...args.object, describedAt: args.describedAt });
    }
    const seen = new Set<string>();
    const current = await ctx.db
      .query("fieldDefinitions")
      .withIndex("by_orgId_and_object_and_apiName", (q) => q.eq("orgId", args.orgId).eq("object", args.object.apiName))
      .take(4000);
    const byName = new Map(current.map((f) => [f.apiName, f]));
    for (const f of args.fields) {
      seen.add(f.apiName);
      const prev = byName.get(f.apiName);
      if (prev) {
        // A field that became read-only falls back to salesforce authority; otherwise keep the stored choice.
        const syncAuthority = !f.updateable ? "salesforce" : prev.syncAuthority;
        await ctx.db.patch(prev._id, { ...f, orgId: args.orgId, syncAuthority });
      } else {
        await ctx.db.insert("fieldDefinitions", { ...f, orgId: args.orgId });
      }
    }
    // Fields deleted in Salesforce.
    for (const f of current) if (!seen.has(f.apiName)) await ctx.db.delete(f._id);
    return existing?.syncEnabled ?? args.object.syncEnabled;
  },
});

export const setRecordCount = internalMutation({
  args: { orgId: v.id("organizations"), apiName: v.string(), recordCount: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("objectDefinitions")
      .withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", args.orgId).eq("provider", "salesforce").eq("apiName", args.apiName))
      .unique();
    if (row) await ctx.db.patch(row._id, { recordCount: args.recordCount });
    return null;
  },
});

/** Counts for verification: stored objects and fields (optionally for one object). */
export const metadataCounts = internalQuery({
  args: { orgId: v.id("organizations"), object: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const objects = await ctx.db
      .query("objectDefinitions")
      .withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", args.orgId).eq("provider", "salesforce"))
      .take(5000);
    let fields = 0;
    let withoutAuthority = 0;
    if (args.object) {
      const rows = await ctx.db
        .query("fieldDefinitions")
        .withIndex("by_orgId_and_object_and_apiName", (q) => q.eq("orgId", args.orgId).eq("object", args.object!))
        .take(4000);
      fields = rows.length;
      withoutAuthority = rows.filter((r) => !r.syncAuthority).length;
    }
    return { objects: objects.length, syncEnabled: objects.filter((o) => o.syncEnabled).map((o) => o.apiName).sort(), fields, withoutAuthority };
  },
});

// ---------- dev-only token seeding ----------

/**
 * DEV ONLY. Seeds a Salesforce integration row from a token obtained with
 * `sf org display` so the import can run against a test org without the web
 * OAuth flow. Internal (admin key only); refuses to overwrite a connection
 * made through OAuth unless `force` is set; never schedules a sync; never
 * returns the token. The CLI's token cannot be refreshed with our connected
 * app, so tokenExpiresAt is left unset and a 401 means re-seed.
 */
export const devSeedTokens = internalMutation({
  args: { accessToken: v.string(), instanceUrl: v.string(), orgId: v.optional(v.id("organizations")), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const host = new URL(args.instanceUrl).host;
    if (!/\.salesforce\.com$/.test(host)) throw new ConvexError("instanceUrl must be a *.salesforce.com org");
    let orgId = args.orgId;
    if (!orgId) {
      // The demo org if seeded, else a dedicated Phase 1b test org (created once).
      const org =
        (await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first()) ??
        (await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", SF_TEST_ORG_CLERK_ID)).first());
      const now = Date.now();
      orgId = org?._id ?? (await ctx.db.insert("organizations", {
        clerkOrgId: SF_TEST_ORG_CLERK_ID, name: "Phase 1b Salesforce Sync Test", slug: "p1b-sf-sync-test", fiscalYearStartMonth: 1,
        defaultCurrency: "USD", timezone: "America/Los_Angeles", planTier: "free", createdAt: now, updatedAt: now,
      }));
    }
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId!).eq("provider", "salesforce"))
      .first();
    const devSeeded = (existing?.syncConfig as { devSeeded?: boolean } | undefined)?.devSeeded === true;
    if (existing && !devSeeded && !args.force) {
      throw new ConvexError("An OAuth Salesforce connection exists for this org; pass force: true to replace it");
    }
    const now = Date.now();
    const patch = {
      accessToken: await encryptForStorage(args.accessToken),
      refreshToken: await encryptForStorage("dev-seeded-no-refresh"),
      instanceUrl: args.instanceUrl,
      tokenExpiresAt: undefined,
      displayName: `Salesforce — ${host} (dev-seeded)`,
      externalOrgDomain: host,
      isActive: true,
      syncConfig: { ...((existing?.syncConfig as object | undefined) ?? {}), devSeeded: true },
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("integrations", { orgId, provider: "salesforce", ...patch, createdAt: now, connectedAt: now });
    return { orgId, instanceHost: host, replaced: Boolean(existing) };
  },
});

// ---------- the import ----------

async function connFor(ctx: ActionCtx, orgId: Id<"organizations">): Promise<SfConn> {
  const creds: { accessToken: string; instanceUrl: string } = await ctx.runAction(internal.salesforceActions.getOrgAccessToken, { orgId });
  let token = creds.accessToken;
  return {
    instanceUrl: creds.instanceUrl,
    apiVersion: API_VERSION,
    getToken: async () => token,
    refreshToken: async () => {
      const r: { accessToken: string } = await ctx.runAction(internal.salesforceActions.refreshAccessToken, { orgId });
      token = r.accessToken;
      return token;
    },
  };
}

async function defineInRecordService(orgId: string, defs: Array<ReturnType<typeof objectDef>>): Promise<ImportSummary["recordService"]> {
  const base = process.env.RECORD_SERVICE_URL;
  const token = process.env.RECORD_SERVICE_TOKEN;
  if (!base || !token) return "not_configured";
  const headers = { Authorization: `Bearer ${token}`, "X-Workspace-Id": orgId, "Content-Type": "application/json" };
  const url = (p: string) => `${base.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(orgId)}/${p}`;
  const prov = await fetch(url("provision"), { method: "POST", headers, body: "{}" });
  if (!prov.ok) return "failed";
  for (let i = 0; i < defs.length; i += 200) {
    const res = await fetch(url("objects/define"), {
      method: "POST", headers,
      body: JSON.stringify({ objects: defs.slice(i, i + 200).map((d) => ({ ...d, fields: d.fields.slice(0, 1000) })) }),
    });
    if (!res.ok) {
      console.error("record service objects/define failed", res.status, (await res.text()).slice(0, 300));
      return "failed";
    }
  }
  return "defined";
}

async function runImport(ctx: ActionCtx, orgId: Id<"organizations">): Promise<ImportSummary> {
  const c = await connFor(ctx, orgId);
  const describedAt = Date.now();
  const enabled: string[] = [];
  const result = await importMetadataCore(c, {
    concurrency: 8,
    onObject: async (meta, fields: FieldMeta[]) => {
      const syncEnabled: boolean = await ctx.runMutation(internal.salesforceMetadata.saveObject, {
        orgId,
        object: { apiName: meta.apiName, label: meta.label, isCustom: meta.isCustom, syncEnabled: meta.syncEnabled },
        fields,
        describedAt,
      });
      if (syncEnabled) enabled.push(meta.apiName);
    },
  });
  // Record counts for synced objects (one COUNT() each).
  for (const apiName of enabled) {
    try {
      const r = await soql(c, `SELECT COUNT() FROM ${apiName}`);
      await ctx.runMutation(internal.salesforceMetadata.setRecordCount, { orgId, apiName, recordCount: r.totalSize });
    } catch (e) {
      console.warn(`COUNT() failed for ${apiName}`, String((e as Error).message).slice(0, 200));
    }
  }
  // Every custom object, plus synced standard objects with no typed table, becomes a record-service object.
  const defs = result.described
    .filter((d) => (d.custom && d.name.endsWith("__c")) || (enabled.includes(d.name) && !TYPED_OBJECTS.includes(d.name)))
    .map(objectDef);
  const recordService = defs.length ? await defineInRecordService(orgId, defs) : "defined";
  return {
    objects: result.objects.length,
    fields: result.fields.length,
    syncEnabled: enabled.sort(),
    defined: recordService === "defined" ? defs.length : 0,
    recordService,
    failed: result.failed,
  };
}

/** Describe every queryable object in the caller's connected org (admins and managers). */
export const importMetadata = action({
  args: {},
  handler: async (ctx): Promise<ImportSummary> => {
    const orgId: Id<"organizations"> = await ctx.runQuery(internal.salesforceMetadata.callerOrg, {});
    return runImport(ctx, orgId);
  },
});

/** Same import for a given org (scheduler, CLI and tests via the admin key). */
export const importMetadataForOrg = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<ImportSummary> => runImport(ctx, args.orgId),
});
