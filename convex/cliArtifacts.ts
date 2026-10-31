import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { artifactSha256 } from "./lib/artifactVersioning";
import { getCurrentUser, requireCap } from "./lib";

const kind = v.union(v.literal("icp"), v.literal("signal_run"), v.literal("lead_run"));
const MAX_HISTORY = 100;

async function ensureLegacyRevision(ctx: MutationCtx, artifact: Doc<"cliArtifacts">) {
  const revision = artifact.currentRevision ?? 1;
  const existing = await ctx.db.query("cliArtifactRevisions")
    .withIndex("by_artifactId_and_revision", (q) => q.eq("artifactId", artifact._id).eq("revision", revision)).unique();
  if (!existing) {
    await ctx.db.insert("cliArtifactRevisions", {
      orgId: artifact.orgId, artifactId: artifact._id, revision,
      document: artifact.document,
      documentSha256: artifact.documentSha256 ?? await artifactSha256(artifact.document),
      origin: artifact.origin ?? "cli", changeSummary: "Imported legacy canonical artifact",
      createdAt: artifact.publishedAt ?? artifact.updatedAt,
      createdByUserId: artifact.updatedByUserId,
      createdByCliTokenId: artifact.updatedByCliTokenId,
    });
  }
  return revision;
}

export const list = query({
  args: { kind: v.optional(kind), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 50), 100));
    if (args.kind) {
      const selectedKind = args.kind;
      return ctx.db.query("cliArtifacts")
        .withIndex("by_org_kind_updatedAt", (q) => q.eq("orgId", user.orgId).eq("kind", selectedKind)).order("desc").take(limit);
    }
    const groups = await Promise.all((["icp", "signal_run", "lead_run"] as const).map((selectedKind) =>
      ctx.db.query("cliArtifacts").withIndex("by_org_kind_updatedAt", (q) => q.eq("orgId", user.orgId).eq("kind", selectedKind)).order("desc").take(limit)));
    return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  },
});

export const get = query({
  args: { artifactId: v.id("cliArtifacts") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const artifact = await ctx.db.get(args.artifactId);
    return artifact?.orgId === user.orgId ? artifact : null;
  },
});

export const history = query({
  args: { artifactId: v.id("cliArtifacts"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.orgId !== user.orgId) return [];
    return ctx.db.query("cliArtifactRevisions")
      .withIndex("by_orgId_and_artifactId_and_createdAt", (q) => q.eq("orgId", user.orgId).eq("artifactId", args.artifactId))
      .order("desc").take(Math.max(1, Math.min(Math.floor(args.limit ?? 50), MAX_HISTORY)));
  },
});

export const getDraft = query({
  args: { artifactId: v.id("cliArtifacts") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return ctx.db.query("cliArtifactDrafts").withIndex("by_orgId_and_artifactId", (q) => q.eq("orgId", user.orgId).eq("artifactId", args.artifactId)).unique();
  },
});

export const saveDraft = mutation({
  args: { artifactId: v.id("cliArtifacts"), baseRevision: v.number(), icp: v.any(), manualEvidence: v.optional(v.array(v.object({ label: v.string(), excerpt: v.string(), sourceUrl: v.string() }))), changeSummary: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.orgId !== user.orgId || artifact.kind !== "icp") throw new Error("Artifact not found");
    const currentRevision = artifact.currentRevision ?? 1;
    if (args.baseRevision !== currentRevision) throw new ConvexError({ code: "ARTIFACT_CONFLICT", currentRevision });
    if (!args.icp || typeof args.icp !== "object" || Array.isArray(args.icp)) throw new Error("ICP must be an object");
    const icp = args.icp as Record<string, any>;
    if (typeof icp.name !== "string" || !icp.name.trim() || !icp.persona || (!Array.isArray(icp.persona.titleKeywords) && !Array.isArray(icp.persona.jobLevels))) throw new Error("ICP needs a name and buyer persona");
    const published = artifact.document && typeof artifact.document === "object" && !Array.isArray(artifact.document) ? artifact.document as Record<string, any> : {};
    const immutableEvidence = Array.isArray(published.evidence) ? published.evidence.filter((item: any) => item?.provenance?.kind !== "manual") : [];
    const manualEvidence = (args.manualEvidence ?? []).slice(0, 50).map((item) => {
      let url: URL; try { url = new URL(item.sourceUrl); } catch { throw new Error("Manual evidence needs a valid source URL"); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Manual evidence source must use http(s)");
      const label = item.label.trim().slice(0, 200); const excerpt = item.excerpt.trim().slice(0, 4000);
      if (!label || !excerpt) throw new Error("Manual evidence needs a label and excerpt");
      return { label, excerpt, sourceUrl: url.href, provenance: { kind: "manual", addedByUserId: user._id, addedAt: Date.now() } };
    });
    const document = { ...published, icp: { ...icp, name: icp.name.trim() }, evidence: [...immutableEvidence, ...manualEvidence], humanReview: { source: "hosted", reviewedAt: new Date().toISOString(), reviewedByUserId: user._id, modelConfidencePreservedAsGenerated: typeof published.confidence === "number" } };
    const documentSha256 = await artifactSha256(document);
    const existing = await ctx.db.query("cliArtifactDrafts").withIndex("by_orgId_and_artifactId", (q) => q.eq("orgId", user.orgId).eq("artifactId", args.artifactId)).unique();
    const value = { baseRevision: args.baseRevision, document, documentSha256, changeSummary: args.changeSummary?.trim().slice(0, 500), updatedAt: Date.now(), updatedByUserId: user._id };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("cliArtifactDrafts", { orgId: user.orgId, artifactId: args.artifactId, ...value });
    return { documentSha256, baseRevision: args.baseRevision };
  },
});

export const publishDraft = mutation({
  args: { artifactId: v.id("cliArtifacts"), expectedRevision: v.number(), changeSummary: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.orgId !== user.orgId || artifact.kind !== "icp") throw new Error("Artifact not found");
    const currentRevision = await ensureLegacyRevision(ctx, artifact);
    if (args.expectedRevision !== currentRevision) throw new ConvexError({ code: "ARTIFACT_CONFLICT", currentRevision });
    const draft = await ctx.db.query("cliArtifactDrafts").withIndex("by_orgId_and_artifactId", (q) => q.eq("orgId", user.orgId).eq("artifactId", args.artifactId)).unique();
    if (!draft || draft.baseRevision !== currentRevision) throw new ConvexError({ code: "ARTIFACT_CONFLICT", currentRevision });
    const revision = currentRevision + 1;
    const now = Date.now();
    const changeSummary = args.changeSummary?.trim().slice(0, 500) || draft.changeSummary || "Published hosted edit";
    await ctx.db.insert("cliArtifactRevisions", { orgId: user.orgId, artifactId: artifact._id, revision, document: draft.document, documentSha256: draft.documentSha256, origin: "hosted", changeSummary, parentRevision: currentRevision, createdAt: now, createdByUserId: user._id });
    const draftIcp = draft.document && typeof draft.document === "object" && !Array.isArray(draft.document) ? (draft.document as Record<string, any>).icp : undefined;
    const label = draftIcp && typeof draftIcp.name === "string" && draftIcp.name.trim() ? draftIcp.name.trim().slice(0, 200) : artifact.label;
    await ctx.db.patch(artifact._id, { label, document: draft.document, documentSha256: draft.documentSha256, currentRevision: revision, origin: "hosted", publishedAt: now, updatedAt: now, updatedByUserId: user._id, updatedByCliTokenId: undefined });
    await ctx.db.delete(draft._id);
    return { revision, documentSha256: draft.documentSha256, updatedAt: now };
  },
});

export const rollback = mutation({
  args: { artifactId: v.id("cliArtifacts"), revision: v.number(), expectedRevision: v.number(), changeSummary: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.orgId !== user.orgId || artifact.kind !== "icp") throw new Error("Artifact not found");
    const currentRevision = await ensureLegacyRevision(ctx, artifact);
    if (args.expectedRevision !== currentRevision) throw new ConvexError({ code: "ARTIFACT_CONFLICT", currentRevision });
    const source = await ctx.db.query("cliArtifactRevisions").withIndex("by_artifactId_and_revision", (q) => q.eq("artifactId", artifact._id).eq("revision", args.revision)).unique();
    if (!source || source.orgId !== user.orgId) throw new Error("Revision not found");
    const revision = currentRevision + 1;
    const now = Date.now();
    await ctx.db.insert("cliArtifactRevisions", { orgId: user.orgId, artifactId: artifact._id, revision, document: source.document, documentSha256: source.documentSha256, origin: "hosted", changeSummary: args.changeSummary?.trim().slice(0, 500) || `Restored revision ${args.revision}`, parentRevision: currentRevision, restoredFromRevision: args.revision, createdAt: now, createdByUserId: user._id });
    await ctx.db.patch(artifact._id, { document: source.document, documentSha256: source.documentSha256, currentRevision: revision, origin: "hosted", publishedAt: now, updatedAt: now, updatedByUserId: user._id, updatedByCliTokenId: undefined });
    const draft = await ctx.db.query("cliArtifactDrafts").withIndex("by_orgId_and_artifactId", (q) => q.eq("orgId", user.orgId).eq("artifactId", artifact._id)).unique();
    if (draft) await ctx.db.delete(draft._id);
    return { revision, documentSha256: source.documentSha256, updatedAt: now };
  },
});

export const getForCli = internalQuery({
  args: { orgId: v.id("organizations"), kind, key: v.string() },
  handler: (ctx, args) => ctx.db.query("cliArtifacts").withIndex("by_org_kind_key", (q) => q.eq("orgId", args.orgId).eq("kind", args.kind).eq("key", args.key)).unique(),
});

export const upsert = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), cliTokenId: v.id("cliTokens"), kind, key: v.string(), label: v.string(), domain: v.optional(v.string()), document: v.any(), sourceVersion: v.optional(v.string()), expectedRevision: v.optional(v.number()), changeSummary: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("cliArtifacts").withIndex("by_org_kind_key", (q) => q.eq("orgId", args.orgId).eq("kind", args.kind).eq("key", args.key)).unique();
    const now = Date.now();
    const documentSha256 = await artifactSha256(args.document);
    if (existing) {
      const currentRevision = await ensureLegacyRevision(ctx, existing);
      if ((args.expectedRevision === undefined && existing.origin === "hosted") || (args.expectedRevision !== undefined && args.expectedRevision !== currentRevision)) {
        throw new ConvexError({ code: "ARTIFACT_CONFLICT", currentRevision, documentSha256: existing.documentSha256 ?? await artifactSha256(existing.document) });
      }
      if (documentSha256 === (existing.documentSha256 ?? await artifactSha256(existing.document))) return { artifactId: existing._id, updatedAt: existing.updatedAt, created: false, revision: currentRevision, documentSha256, unchanged: true };
      const revision = currentRevision + 1;
      await ctx.db.insert("cliArtifactRevisions", { orgId: args.orgId, artifactId: existing._id, revision, document: args.document, documentSha256, origin: "cli", changeSummary: args.changeSummary?.trim().slice(0, 500) || "Published from CLI", parentRevision: currentRevision, createdAt: now, createdByUserId: args.userId, createdByCliTokenId: args.cliTokenId });
      await ctx.db.patch(existing._id, { label: args.label, domain: args.domain, document: args.document, documentSha256, sourceVersion: args.sourceVersion, currentRevision: revision, origin: "cli", publishedAt: now, updatedAt: now, updatedByUserId: args.userId, updatedByCliTokenId: args.cliTokenId });
      return { artifactId: existing._id, updatedAt: now, created: false, revision, documentSha256, unchanged: false };
    }
    if (args.expectedRevision !== undefined && args.expectedRevision !== 0) throw new ConvexError({ code: "ARTIFACT_CONFLICT", currentRevision: 0 });
    const artifactId = await ctx.db.insert("cliArtifacts", { orgId: args.orgId, kind: args.kind, key: args.key, label: args.label, domain: args.domain, document: args.document, documentSha256, sourceVersion: args.sourceVersion, currentRevision: 1, origin: "cli", createdAt: now, publishedAt: now, updatedAt: now, updatedByUserId: args.userId, updatedByCliTokenId: args.cliTokenId });
    await ctx.db.insert("cliArtifactRevisions", { orgId: args.orgId, artifactId, revision: 1, document: args.document, documentSha256, origin: "cli", changeSummary: args.changeSummary?.trim().slice(0, 500) || "Created from CLI", createdAt: now, createdByUserId: args.userId, createdByCliTokenId: args.cliTokenId });
    return { artifactId, updatedAt: now, created: true, revision: 1, documentSha256, unchanged: false };
  },
});

/** One-time, bounded migration for artifacts created before revision history. */
export const backfillLegacyRevisions = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("cliArtifacts").take(Math.max(1, Math.min(Math.floor(args.limit ?? 100), 500)));
    let migrated = 0;
    for (const artifact of rows) {
      if (artifact.currentRevision !== undefined && artifact.documentSha256) continue;
      const documentSha256 = artifact.documentSha256 ?? await artifactSha256(artifact.document);
      await ensureLegacyRevision(ctx, { ...artifact, documentSha256 });
      await ctx.db.patch(artifact._id, { currentRevision: artifact.currentRevision ?? 1, documentSha256, origin: artifact.origin ?? "cli", publishedAt: artifact.publishedAt ?? artifact.updatedAt });
      migrated++;
    }
    return { scanned: rows.length, migrated };
  },
});
