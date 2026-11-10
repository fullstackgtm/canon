/**
 * A workspace's own recipes (docs/recipes.md, "Customizing in the app"). Customize copies a recipe, first-party or
 * installed, into a package whose source is the workspace; its recipe.md is then edited in the app and each save is
 * a revision, as settings are. Customize, save and revert are an admin's or manager's (requireDecider); agents read
 * the markdown and its revisions.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { invalidateFit } from "./lib/fitInvalidation";
import { action, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { callerOf, mayDecide, requireDecider } from "./recipes";
import { currentRevision, modelSettings, upstreamChange, orgConnections, packageRow, recipeIn, requireRecipe, storedOverrides } from "./lib/recipes";
import { proposalEvals } from "./lib/recipeAgent";
import { runEvals } from "./lib/recipeRuntime";
import { recipeAgentStandIn } from "./lib/recipeAgentStandIn";
import { openSource, type Connection } from "./lib/recipeSources";
import { BUILTINS_BUNDLE, FIRST_PARTY_MARKDOWN, RECIPE_BUNDLES } from "../recipes/_bundles.generated.ts";
import { codeNames, markdownBundle, runnable } from "../recipes/compose.ts";
import { isFirstParty, parseOverrides } from "../recipes/index.ts";
import { RECIPE_MAX_BYTES, fromManifest, parseManifest, toManifest, type Manifest } from "../recipes/manifest.ts";
import { parseRecipe, type Runnable } from "../recipes/md/parse.ts";
import { copySlug, copyTitle, forkMarkdown, isWorkspaceId, lineDiff, orgSlug, workspaceId, workspaceProblems, type WorkspaceSource } from "../recipes/workspace.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";

const REVISIONS_SHOWN = 20;
const NOTE_MAX = 300;
const ERRORS_SHOWN = 8;
const PACKAGES_READ = 200;
const REFUSED = "Only an admin or manager customizes or edits the workspace's packages, in person. An agent reads them with canon_customization get_markdown.";

type Db = Pick<QueryCtx, "db">;
type Workspace = Doc<"recipePackages"> & { source: WorkspaceSource };
const isWorkspace = (pkg: Doc<"recipePackages"> | null): pkg is Workspace => pkg?.source.kind === "workspace";

const revisionAt = (ctx: Db, orgId: Id<"organizations">, recipeId: string, revision: number) =>
  ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId).eq("revision", revision)).unique();

async function currentMarkdown(ctx: Db, orgId: Id<"organizations">, recipeId: string): Promise<Doc<"recipeMarkdownRevisions">> {
  for await (const row of ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).order("desc")) {
    if (row.status === "current") return row;
  }
  throw new ConvexError(`${recipeId} has no markdown in force.`);
}

async function requireWorkspace(ctx: Db, orgId: Id<"organizations">, recipeId: string): Promise<Workspace> {
  const pkg = await packageRow(ctx, orgId, recipeId);
  if (!isWorkspace(pkg) || pkg.status !== "installed") throw new ConvexError(`This workspace has no package of its own called ${recipeId}. Customize a package on the Customization page first.`);
  return pkg;
}

/**
 * `markdown` as a workspace recipe, checked as the editor checks it, with the manifest a save stores. A kept bundle
 * pins the prompts and logic to `frozen`, the ones its bundle carries.
 */
function checked(markdown: string, rules: { id: string; frozen: Runnable | null }) {
  if (markdown.length > RECIPE_MAX_BYTES) throw new ConvexError(`A customization.md is at most ${RECIPE_MAX_BYTES / 1024} KB.`);
  const { recipe, problems } = workspaceProblems(markdown, rules);
  const errors = problems.filter((p) => p.level === "error").map((p) => `line ${p.line}: ${p.message}`);
  const listed = (e: string[]) => `${e.slice(0, ERRORS_SHOWN).join("; ")}${e.length > ERRORS_SHOWN ? ` (and ${e.length - ERRORS_SHOWN} more)` : ""}`;
  if (errors.length) throw new ConvexError(`customization.md has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${listed(errors)}.`);
  const manifest = toManifest(recipe);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  if (!parsed.ok) throw new ConvexError(`customization.md doesn't hold together: ${listed(parsed.errors)}.`);
  return { recipe, manifest, manifestText: JSON.stringify(manifest) };
}

const frozenOf = (bundle: WorkspaceSource["bundle"], markdown: string): Runnable | null => (bundle === "kept" ? runnable(parseRecipe(markdown).recipe) : null);

// ───────────────────────────── Customize ─────────────────────────────

type PackageSource = { pkg: { source: Doc<"recipePackages">["source"]; bundleHash: string; bundleStorageId: Id<"_storage"> }; connections: Connection[] };
type CustomizeBase = { canDecide: boolean; org: { name: string; slug: string }; taken: string[]; title: string; version: string; from: PackageSource | null };

export const customizeBase = internalQuery({
  args: { recipeId: v.string() },
  handler: async (ctx, args): Promise<CustomizeBase> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const orgId = caller.user.orgId;
    const org = await ctx.db.get(orgId);
    if (!org) throw new ConvexError("No workspace");
    if (isWorkspaceId(args.recipeId)) throw new ConvexError(`${args.recipeId} is already this workspace's own package. Edit it instead.`);
    const { recipe, pkg } = await requireRecipe(ctx, orgId, args.recipeId);
    const rows = await ctx.db.query("recipePackages").withIndex("by_orgId_and_recipeId", (q) => q.eq("orgId", orgId)).take(PACKAGES_READ);
    return {
      canDecide: mayDecide(caller), org: { name: org.name, slug: org.slug }, taken: rows.map((r) => r.recipeId), title: recipe.title, version: recipe.version,
      from: pkg && { pkg: { source: pkg.source, bundleHash: pkg.bundleHash, bundleStorageId: pkg.bundleStorageId }, connections: await orgConnections(ctx, orgId) },
    };
  },
});

/** The source recipe's recipe.md, and the bundle a copy keeps when the source has TypeScript (null when it has none). */
async function sourceOf(ctx: ActionCtx, recipeId: string, from: PackageSource | null): Promise<{ markdown: string; kept: { code: string; hash: string } | null }> {
  if (!from) {
    if (!isFirstParty(recipeId)) throw new ConvexError(`This workspace has no package ${recipeId}.`);
    const markdown = FIRST_PARTY_MARKDOWN[recipeId];
    const bundle = RECIPE_BUNDLES[recipeId];
    return { markdown, kept: codeNames(parseRecipe(markdown).recipe).length && bundle ? bundle : null };
  }
  const s = from.pkg.source;
  if (s.kind === "workspace") throw new ConvexError(`${recipeId} is already this workspace's own package.`);
  const { markdown, code } = await (await openSource(s, from.connections)).fetchPackage(s.sha);
  if (code === null) return { markdown, kept: null };
  const hash = await bundleHash(code);
  if (hash !== from.pkg.bundleHash) throw new ConvexError(`The package at ${s.sha.slice(0, 12)} isn't the one installed. Check it for updates, then customize it.`);
  return { markdown, kept: { code, hash } };
}

/**
 * Copy a recipe into the workspace as `@workspace/<name>`, titled "<Org>'s <title>": its recipe.md, and when it has
 * TypeScript the exact bundle it runs. The copy starts on the source's settings in force. It is off everywhere
 * until someone picks it at a point, like any recipe.
 */
export const customize = action({
  args: { recipeId: v.string() },
  handler: async (ctx, args): Promise<{ recipeId: string }> => copyOf(ctx, args),
});

/**
 * Customize's work. `text` stands in for the source's recipe.md only on a local stack (devSeed.customizeLocal), whose
 * locally installed packages have no GitHub commit to fetch again.
 */
export async function copyOf(ctx: ActionCtx, args: { recipeId: string }, text?: string): Promise<{ recipeId: string }> {
  const base: CustomizeBase = await ctx.runQuery(internal.workspaceRecipes.customizeBase, { recipeId: args.recipeId });
  if (!base.canDecide) throw new ConvexError(REFUSED);
  const source = text === undefined ? await sourceOf(ctx, args.recipeId, base.from) : { markdown: text, kept: null };
  const id = workspaceId(copySlug(args.recipeId, new Set(base.taken)));
  const markdown = forkMarkdown(source.markdown, { id, title: copyTitle(base.org.name, base.title), org: orgSlug(base.org.slug) });
  const bundle = source.kept ? "kept" : "builtins";
  const { recipe, manifestText } = checked(markdown, { id, frozen: frozenOf(bundle, source.markdown) });
  const markdownHash = await bundleHash(markdown);
  const code = source.kept?.code ?? markdownBundle(BUILTINS_BUNDLE, recipe, markdownHash);
  const storageId = await ctx.storage.store(new Blob([code], { type: "text/javascript" }));
  try {
    await ctx.runMutation(internal.workspaceRecipes.storeCopy, {
      recipeId: id, sourceId: args.recipeId, version: recipe.meta.version, manifest: manifestText, markdown, markdownHash, bundle,
      forkedFrom: { id: args.recipeId, version: text === undefined ? base.version : recipe.meta.version, markdownHash: await bundleHash(source.markdown) },
      diff: lineDiff(source.markdown, markdown), bundleHash: source.kept?.hash ?? await bundleHash(code), storageId,
    });
  } catch (e) {
    await ctx.storage.delete(storageId);
    throw e;
  }
  return { recipeId: id };
}

const diffValidator = v.object({ added: v.number(), removed: v.number(), text: v.string() });

export const storeCopy = internalMutation({
  args: {
    recipeId: v.string(), sourceId: v.string(), version: v.string(), manifest: v.string(), markdown: v.string(), markdownHash: v.string(),
    bundle: v.union(v.literal("builtins"), v.literal("kept")), forkedFrom: v.object({ id: v.string(), version: v.string(), markdownHash: v.string() }),
    diff: diffValidator, bundleHash: v.string(), storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    if (!isWorkspaceId(args.recipeId)) throw new ConvexError(`${args.recipeId} isn't a workspace package id.`);
    if (await packageRow(ctx, user.orgId, args.recipeId)) throw new ConvexError(`${args.recipeId} was just made. Reload the Customization page.`);
    const at = Date.now();
    await ctx.db.insert("recipePackages", {
      orgId: user.orgId, recipeId: args.recipeId, version: args.version, manifest: args.manifest, bundleHash: args.bundleHash, bundleStorageId: args.storageId,
      source: { kind: "workspace", markdownHash: args.markdownHash, bundle: args.bundle, forkedFrom: args.forkedFrom },
      installedBy: user._id, installedAt: at, status: "installed",
    });
    const from = await requireRecipe(ctx, user.orgId, args.sourceId);
    await ctx.db.insert("recipeMarkdownRevisions", {
      orgId: user.orgId, recipeId: args.recipeId, revision: 1, markdown: args.markdown, markdownHash: args.markdownHash, parent: null,
      author: { kind: "user", id: user._id }, note: `Customized from ${from.recipe.title} v${args.forkedFrom.version}`, diff: args.diff,
      ...(args.bundle === "kept" ? { bundle: { hash: args.bundleHash, storageId: args.storageId } } : {}), status: "current", createdAt: at,
    });
    const settings = await currentRevision(ctx, user.orgId, args.sourceId);
    const copy = fromManifest(JSON.parse(args.manifest) as Manifest);
    const { overrides } = parseOverrides(copy, storedOverrides(from.recipe, settings));
    if (settings && Object.keys(overrides).length) {
      await ctx.db.insert("recipeRevisions", {
        orgId: user.orgId, recipeId: args.recipeId, revision: 1, settings: overrides, parent: null, author: { kind: "user", id: user._id },
        note: `Copied from ${from.recipe.title}'s settings revision ${settings.revision}`, status: "current", createdAt: at,
      });
    }
    return null;
  },
});

// ───────────────────────────── Edit, save and revert ─────────────────────────────

type EditBase = {
  canDecide: boolean; revision: number; markdown: string; markdownHash: string; bundle: WorkspaceSource["bundle"]; bundleHash: string; storageId: Id<"_storage">;
  target: string | null; overrides: Record<string, unknown>; forkedFrom: WorkspaceSource["forkedFrom"];
  /** A revert on a kept bundle: the bundle the revision it goes back to ran on, which the revert puts back. */
  restore: Bundle | null;
};
type Bundle = { hash: string; storageId: Id<"_storage"> };

/**
 * The kept bundle `target` ran on. A revision records it (#499); one from before that ran on the bundle in force,
 * unless an upstream merge since may have replaced it, whose code is then gone: that revert is refused.
 */
async function bundleAt(ctx: Db, pkg: Workspace, target: Doc<"recipeMarkdownRevisions">): Promise<Bundle> {
  if (target.bundle) return target.bundle;
  const later = ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", pkg.orgId).eq("recipeId", pkg.recipeId).gt("revision", target.revision));
  for await (const row of later) {
    if (!row.upstream) continue;
    throw new ConvexError(
      `Revision ${target.revision} doesn't record the TypeScript bundle it ran on (it was saved before Canon kept each revision's bundle), and upstream v${row.upstream.version} was merged after it in revision ${row.revision}, so that code is gone. ` +
      `Revert to revision ${row.revision} or later, or customize ${pkg.source.forkedFrom.id} again.`,
    );
  }
  return { hash: pkg.bundleHash, storageId: pkg.bundleStorageId };
}

/** The markdown in force for a workspace recipe, and for a revert the markdown of the revision it goes back to. */
export const editBase = internalQuery({
  args: { recipeId: v.string(), revertTo: v.optional(v.number()) },
  handler: async (ctx, args): Promise<EditBase> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const orgId = caller.user.orgId;
    const pkg = await requireWorkspace(ctx, orgId, args.recipeId);
    const current = await currentMarkdown(ctx, orgId, args.recipeId);
    const target = args.revertTo === undefined ? null : await revisionAt(ctx, orgId, args.recipeId, args.revertTo);
    if (args.revertTo !== undefined && !target) throw new ConvexError(`No revision ${args.revertTo}`);
    return {
      canDecide: mayDecide(caller), revision: current.revision, markdown: current.markdown, markdownHash: current.markdownHash,
      bundle: pkg.source.bundle, bundleHash: pkg.bundleHash, storageId: pkg.bundleStorageId, target: target?.markdown ?? null,
      overrides: (await currentRevision(ctx, orgId, args.recipeId))?.settings ?? {}, forkedFrom: pkg.source.forkedFrom,
      restore: target && pkg.source.bundle === "kept" ? await bundleAt(ctx, pkg, target) : null,
    };
  },
});

type EvalView = { name: string; ok: boolean; detail: string | null };
type Saved = { revision: number; changed: boolean; ignoredSettings: string[]; evals: EvalView[]; evalsNotRun: string | null; blocked: boolean };

/** The upstream a merge takes: its recipe.md as copied (`markdown`), and the raw text's hash and bundle a save records. */
type Upstream = { version: string; markdown: string; rawHash: string; kept: { code: string; hash: string } | null };

/**
 * Check `markdown` against the recipe in force, run its evals, and make it the current revision on top of
 * `baseRevision`. Failing evals stop the save, with their results, unless `acceptFailingEvals`. A save that merges
 * `upstream` checks a kept bundle's prompts and logic against the upstream's, takes its bundle, and records it. A
 * revert of a kept copy puts back `base.restore`, the bundle its revision ran on, and checks the prompts and logic
 * against that bundle's: those of the revision's own markdown, which was checked against it when saved.
 */
async function saveMarkdown(ctx: ActionCtx, base: EditBase, args: { recipeId: string; markdown: string; note?: string; baseRevision: number; acceptFailingEvals?: boolean }, upstream: Upstream | null = null): Promise<Saved> {
  if (!base.canDecide) throw new ConvexError(REFUSED);
  if (base.revision !== args.baseRevision) throw new ConvexError("Someone saved this package since you opened it. Reload to see their change.");
  const restore = base.restore;
  const frozenFrom = upstream?.markdown ?? (restore ? args.markdown : base.markdown);
  const { recipe, manifest, manifestText } = checked(args.markdown, { id: args.recipeId, frozen: frozenOf(base.bundle, frozenFrom) });
  const markdownHash = await bundleHash(args.markdown);
  if (markdownHash === base.markdownHash && !upstream && (!restore || restore.hash === base.bundleHash)) return { revision: base.revision, changed: false, ignoredSettings: [], evals: [], evalsNotRun: null, blocked: false };
  // A kept bundle's evals would run its own TypeScript, which only a package's install runs; a builtins copy's run in the runtime.
  const def = fromManifest(manifest);
  const { evals, notRun } = base.bundle === "kept" ? { evals: [], notRun: "this copy runs the TypeScript bundle it copied, so its evals run where that package's do" }
    : await proposalEvals(recipe, args.markdown, runEvals, { ...def.settings, ...parseOverrides(def, base.overrides).overrides });
  const failing = evals.filter((e) => !e.ok).length;
  if (failing && !args.acceptFailingEvals) return { revision: base.revision, changed: false, ignoredSettings: [], evals, evalsNotRun: notRun, blocked: true };
  // A kept copy stores a bundle only when a merge brings one it doesn't have; a revert reuses the revision's.
  const kept: Bundle = restore ?? { hash: base.bundleHash, storageId: base.storageId };
  const code = base.bundle === "builtins" ? markdownBundle(BUILTINS_BUNDLE, recipe, markdownHash) : upstream?.kept && upstream.kept.hash !== kept.hash ? upstream.kept.code : null;
  const storageId = code === null ? kept.storageId : await ctx.storage.store(new Blob([code], { type: "text/javascript" }));
  try {
    const out = await ctx.runMutation(internal.workspaceRecipes.storeRevision, {
      recipeId: args.recipeId, markdown: args.markdown, markdownHash, manifest: manifestText, version: recipe.meta.version, baseRevision: args.baseRevision,
      note: args.note ?? (upstream ? `Merged upstream v${upstream.version}` : undefined),
      bundleHash: code === null ? kept.hash : upstream?.kept?.hash ?? await bundleHash(code), storageId,
      upstream: upstream ? { version: upstream.version, markdown: upstream.markdown, markdownHash: upstream.rawHash } : undefined,
    });
    return { ...out, evals, evalsNotRun: notRun, blocked: false };
  } catch (e) {
    if (code !== null) await ctx.storage.delete(storageId);
    throw e;
  }
}

/** The recipe a copy came from, as it is now: its recipe.md, raw and as this copy, and the bundle a kept copy takes. */
async function upstreamNow(ctx: ActionCtx, recipeId: string, forkedFrom: WorkspaceSource["forkedFrom"]): Promise<Upstream> {
  const from: CustomizeBase = await ctx.runQuery(internal.workspaceRecipes.customizeBase, { recipeId: forkedFrom.id });
  const source = await sourceOf(ctx, forkedFrom.id, from.from);
  const markdown = forkMarkdown(source.markdown, { id: recipeId, title: copyTitle(from.org.name, from.title), org: orgSlug(from.org.slug) });
  return { version: from.version, markdown, rawHash: await bundleHash(source.markdown), kept: source.kept };
}

/**
 * Save a new recipe.md for a workspace recipe. Refused on top of a revision that is no longer current, or with any
 * error. `upstreamVersion` says the draft merges that upstream version, which must still be the upstream's.
 */
export const save = action({
  args: { recipeId: v.string(), markdown: v.string(), note: v.optional(v.string()), baseRevision: v.number(), acceptFailingEvals: v.optional(v.boolean()), upstreamVersion: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Saved> => {
    const base: EditBase = await ctx.runQuery(internal.workspaceRecipes.editBase, { recipeId: args.recipeId });
    if (!base.canDecide) throw new ConvexError(REFUSED);
    let upstream: Upstream | null = null;
    if (args.upstreamVersion !== undefined) {
      upstream = await upstreamNow(ctx, args.recipeId, base.forkedFrom);
      if (upstream.version !== args.upstreamVersion) throw new ConvexError(`${base.forkedFrom.id} is at v${upstream.version} now, not v${args.upstreamVersion}. Merge it again.`);
      if (Boolean(upstream.kept) !== (base.bundle === "kept")) throw new ConvexError(`${base.forkedFrom.id} v${upstream.version} ${upstream.kept ? "has" : "no longer has"} TypeScript, so this copy can't merge it. Customize it again.`);
    }
    return saveMarkdown(ctx, base, args, upstream);
  },
});

/**
 * Put an earlier revision's recipe.md back in force, as a new revision, and on a kept copy the bundle it ran on. It
 * went in force once, so its evals don't gate it.
 */
export const revert = action({
  args: { recipeId: v.string(), revision: v.number() },
  handler: async (ctx, args): Promise<Saved> => {
    const base: EditBase = await ctx.runQuery(internal.workspaceRecipes.editBase, { recipeId: args.recipeId, revertTo: args.revision });
    return saveMarkdown(ctx, base, { recipeId: args.recipeId, markdown: base.target!, note: `Reverted to revision ${args.revision}`, baseRevision: base.revision, acceptFailingEvals: true });
  },
});

/** The base of a merge: the upstream recipe.md, as copied, of the last merge, else the copy's first revision. */
async function mergeBase(ctx: Db, orgId: Id<"organizations">, recipeId: string): Promise<string> {
  let first: string | null = null;
  for await (const row of ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).order("desc")) {
    if (row.upstream) return row.upstream.markdown;
    first = row.markdown;
  }
  if (first === null) throw new ConvexError(`${recipeId} has no revisions.`);
  return first;
}

export const upstreamBase = internalQuery({
  args: { recipeId: v.string() },
  handler: async (ctx, args): Promise<{ base: string; forkedFrom: WorkspaceSource["forkedFrom"] }> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const pkg = await requireWorkspace(ctx, caller.user.orgId, args.recipeId);
    return { base: await mergeBase(ctx, caller.user.orgId, args.recipeId), forkedFrom: pkg.source.forkedFrom };
  },
});

/**
 * What a three-way merge with the upstream reads (recipes/merge.ts): the base, the upstream's text now, both as this
 * copy, and the upstream's version. The editor merges them into the draft, and the save records the merge. A read,
 * for agents too (canon_customization get_upstream).
 */
export const upstream = action({
  args: { recipeId: v.string() },
  handler: async (ctx, args): Promise<{ version: string; base: string; theirs: string }> => {
    const u: { base: string; forkedFrom: WorkspaceSource["forkedFrom"] } = await ctx.runQuery(internal.workspaceRecipes.upstreamBase, { recipeId: args.recipeId });
    const now = await upstreamNow(ctx, args.recipeId, u.forkedFrom);
    return { version: now.version, base: u.base, theirs: now.markdown };
  },
});

export const storeRevision = internalMutation({
  args: {
    recipeId: v.string(), markdown: v.string(), markdownHash: v.string(), manifest: v.string(), version: v.string(), note: v.optional(v.string()), baseRevision: v.number(),
    bundleHash: v.string(), storageId: v.id("_storage"), upstream: v.optional(v.object({ version: v.string(), markdown: v.string(), markdownHash: v.string() })),
  },
  handler: async (ctx, args): Promise<Omit<Saved, "evals" | "evalsNotRun" | "blocked">> => {
    const user = await requireDecider(ctx);
    const pkg = await requireWorkspace(ctx, user.orgId, args.recipeId);
    const current = await currentMarkdown(ctx, user.orgId, args.recipeId);
    if (current.revision !== args.baseRevision) throw new ConvexError("Someone saved this package since you opened it. Reload to see their change.");
    const now = fromManifest(JSON.parse(args.manifest) as Manifest);
    // The fit model in force before this save, read before the package changes: a save can take the point away from it.
    const fitBefore = JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit"));
    const latest = await ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", user.orgId).eq("recipeId", args.recipeId)).order("desc").first();
    const revision = (latest?.revision ?? 0) + 1;
    const keptBundle = pkg.source.bundle === "kept";
    // A kept copy's revision from before #499 records its bundle when superseded: the one in force until now.
    await ctx.db.patch(current._id, { status: "superseded", ...(keptBundle && !current.bundle ? { bundle: { hash: pkg.bundleHash, storageId: pkg.bundleStorageId } } : {}) });
    const note = args.note?.trim().slice(0, NOTE_MAX);
    await ctx.db.insert("recipeMarkdownRevisions", {
      orgId: user.orgId, recipeId: args.recipeId, revision, markdown: args.markdown, markdownHash: args.markdownHash, parent: current.revision,
      author: { kind: "user", id: user._id }, ...(note ? { note } : {}), diff: lineDiff(current.markdown, args.markdown),
      ...(args.upstream ? { upstream: { version: args.upstream.version, markdown: args.upstream.markdown } } : {}),
      ...(keptBundle ? { bundle: { hash: args.bundleHash, storageId: args.storageId } } : {}), status: "current", createdAt: Date.now(),
    });
    const old = pkg.bundleStorageId;
    const forkedFrom = args.upstream ? { ...pkg.source.forkedFrom, version: args.upstream.version, markdownHash: args.upstream.markdownHash } : pkg.source.forkedFrom;
    await ctx.db.patch(pkg._id, { manifest: args.manifest, version: args.version, bundleHash: args.bundleHash, bundleStorageId: args.storageId, source: { ...pkg.source, markdownHash: args.markdownHash, forkedFrom } });
    // A built-ins bundle is rebuilt from its markdown, so the one replaced goes. A kept bundle stays while any revision
    // records it, which is every one: it changes only on a merge, so a copy holds one per merge that brought new code.
    if (!keptBundle && old !== args.storageId) await ctx.storage.delete(old);
    // The workspace's settings revision stays as saved; an override the new markdown no longer accepts is ignored until it does again.
    const settings = await currentRevision(ctx, user.orgId, args.recipeId);
    const kept = Object.keys(storedOverrides(now, settings));
    const ignoredSettings = Object.keys(settings?.settings ?? {}).filter((k) => !kept.includes(k));
    // A saved recipe.md can move the ICP fit in force, which rescores the workspace as a settings save does.
    if (JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit")) !== fitBefore) await invalidateFit(ctx, user.orgId);
    return { revision, changed: true, ignoredSettings };
  },
});

// ───────────────────────────── Reads ─────────────────────────────

async function revisionViews(ctx: QueryCtx, rows: Doc<"recipeMarkdownRevisions">[]) {
  const names = new Map<string, string>();
  return Promise.all(rows.map(async (row) => {
    if (!names.has(row.author.id)) names.set(row.author.id, (await ctx.db.get(row.author.id))?.name || "Someone");
    return { revision: row.revision, parent: row.parent, status: row.status, note: row.note ?? null, createdAt: row.createdAt, author: names.get(row.author.id)!, diff: row.diff };
  }));
}

const latestRevisions = (ctx: QueryCtx, orgId: Id<"organizations">, recipeId: string) =>
  ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).order("desc").take(REVISIONS_SHOWN);

/** What the editor opens: the recipe.md in force, where it was copied from, its latest revisions, and who may save. */
export const editor = query({
  args: { recipeId: v.string() },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const orgId = caller.user.orgId;
    const pkg = await packageRow(ctx, orgId, args.recipeId);
    if (!isWorkspace(pkg) || pkg.status !== "installed") return { found: false as const };
    const current = await currentMarkdown(ctx, orgId, args.recipeId);
    const { recipe } = (await recipeIn(ctx, orgId, args.recipeId))!;
    return {
      found: true as const, recipeId: args.recipeId, title: recipe.title, version: recipe.version, forkedFrom: pkg.source.forkedFrom, bundle: pkg.source.bundle,
      markdown: current.markdown, revision: current.revision, revisions: await revisionViews(ctx, await latestRevisions(ctx, orgId, args.recipeId)), canEdit: mayDecide(caller),
      agentStandIn: recipeAgentStandIn(), upstream: await upstreamChange(ctx, orgId, pkg.source.forkedFrom),
    };
  },
});

/** A recipe's recipe.md: a workspace recipe's at its current revision or `revision`, or a first-party recipe's as Canon ships it. */
export const markdown = query({
  args: { recipeId: v.string(), revision: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    if (isFirstParty(args.recipeId)) return { recipeId: args.recipeId, revision: null, markdown: FIRST_PARTY_MARKDOWN[args.recipeId] };
    const orgId = caller.user.orgId;
    await requireWorkspace(ctx, orgId, args.recipeId);
    const row = args.revision === undefined ? await currentMarkdown(ctx, orgId, args.recipeId) : await revisionAt(ctx, orgId, args.recipeId, args.revision);
    if (!row) throw new ConvexError(`No revision ${args.revision}`);
    return { recipeId: args.recipeId, revision: row.revision, markdown: row.markdown };
  },
});

/** A workspace recipe's latest revisions, newest first, each with its author, note and diff against its parent. */
export const revisions = query({
  args: { recipeId: v.string() },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    await requireWorkspace(ctx, caller.user.orgId, args.recipeId);
    return { recipeId: args.recipeId, revisions: await revisionViews(ctx, await latestRevisions(ctx, caller.user.orgId, args.recipeId)) };
  },
});
