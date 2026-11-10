import { compareValues, ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { moduleActivityDataOf, type ModuleActivityData } from "../../../modules/kernel/activities.ts";
import { coreOf } from "../../../modules/kernel/schema.ts";
import type { ActivityDecl, ModuleManifest } from "../../../modules/kernel/manifest.ts";
import { holdsWrites } from "../../../modules/kernel/upgrade.ts";
import { isEnabled, manifestOf } from "./packages";

export const ACTIVITY_PART_BYTES = 65_536;
type Pkg = Doc<"modulePackages">;
type Row = Doc<"moduleDocs">;
type Pub = Doc<"moduleActivityPublications">;
export async function retainedSourcePublication(ctx: Pick<QueryCtx, "db">, pkg: Pkg): Promise<Pub | null> {
  if (!pkg.activityPublication) return null;
  const publication = await ctx.db.get(pkg.activityPublication);
  if (!publication || publication.packageId !== pkg._id || publication.orgId !== pkg.orgId || publication.moduleId !== pkg.moduleId || !publication.retainsPackage || publication.state === "complete") {
    throw new ConvexError("The retained module activity source is inconsistent.");
  }
  return publication;
}
export type Descriptor = {
  packageId: Id<"modulePackages">; moduleId: string; slug: string; version: string; epoch: number; manifestHash: string; bundleHash: string | null; installed: boolean; enabled: boolean;
  collections: Record<string, { activity: ActivityDecl | null; parent: string | null; arrays: string[] }>;
};
export type RootHeader = { incarnation: Id<"moduleDocs">; gen: number; gens: Record<string, number> };
export type ActivityRoot = { incarnation: Id<"moduleDocs">; generation: number };
export type ActivityImage = ModuleActivityData & {
  sourceIdentity: { moduleId: string; collection: string; key: string };
  incarnation: Id<"moduleDocs">; parentKey: string | null; gen: number;
  provenance: { packageId: Id<"modulePackages">; epoch: number; manifestHash: string; bundleHash: string | null; version: number; createdAt: number; root: ActivityRoot | null; representation: { slug: string; path: string; key: string } };
  available: string[]; scalarTargets: Record<string, string | null>;
};
export type ModuleSourceState = { readonly pkg: Pkg; readonly enabled: boolean | null } & (
  | { readonly continuation: false; readonly reason?: "ordinary-member-backfill" }
  | { readonly continuation: true; readonly reason?: never }
);
type Saved = { row: Row; initial: "present" | "absent" };
type Source = {
  source: ModuleSourceState; publication: Pub; descriptor: Descriptor;
  rows: Map<string, Saved>; roots: Map<string, Saved>;
};
class ModuleWriteFailure extends Error {
  constructor(cause: unknown) { super("The module write could not commit. Retry the original operation.", { cause }); }
}
type Session = { owner: MutationCtx; depth: number; sources: Map<string, Source>; reads: Map<string, Row>; roots: Map<string, Row>; emptyPins: Map<string, boolean>; generation: number; failure: ModuleWriteFailure | null };
const sessions = new WeakMap<object, Session>();
const scopeSources = new WeakMap<object, ModuleSourceState>();
export const moduleSource = (pkg: Pkg, enabled: boolean | null = null): ModuleSourceState => ({ pkg: structuredClone(pkg), continuation: false, enabled });
export const ordinaryBackfillSource = (pkg: Pkg, enabled: boolean | null): ModuleSourceState => ({ pkg: structuredClone(pkg), continuation: false, enabled, reason: "ordinary-member-backfill" });
export function associateModuleSource(scope: object, source: ModuleSourceState) { scopeSources.set(scope, source); }
export function scopeModuleSource(scope: object): ModuleSourceState {
  const source = scopeSources.get(scope);
  if (!source) throw new ConvexError("The module source was not admitted.");
  return source;
}
function session(ctx: Pick<MutationCtx, "db">): Session {
  const s = sessions.get(ctx.db);
  if (!s || !s.depth || s.owner !== ctx) throw new ConvexError("A module state write requires a publication session.");
  if (s.failure) throw s.failure;
  return s;
}
export function markModuleSemanticWriteAttempt(ctx: MutationCtx): void { session(ctx).generation++; }
export function rememberModuleRow(ctx: Pick<QueryCtx, "db">, row: Row | null) {
  const s = sessions.get(ctx.db);
  if (!s || !row || s.owner !== ctx) return row;
  s.reads.set(row._id, structuredClone(row));
  const key = canonicalJson([row.orgId, row.moduleId, row.collection, row.key]);
  if (!s.roots.has(key)) s.roots.set(key, structuredClone(row));
  return row;
}
export async function moduleRowBefore(ctx: MutationCtx, id: Id<"moduleDocs">) {
  return session(ctx).reads.get(id) ?? rememberModuleRow(ctx, await ctx.db.get(id));
}
export async function activityDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const activityBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
export function descriptorOf(pkg: Pkg, enabled: boolean): Descriptor {
  const manifest = manifestOf(pkg);
  return { packageId: pkg._id, moduleId: pkg.moduleId, slug: pkg.slug, version: pkg.version, epoch: pkg.epoch ?? 1, manifestHash: pkg.manifestHash, bundleHash: pkg.bundleHash ?? null, installed: pkg.status === "installed", enabled,
    collections: Object.fromEntries(Object.entries(manifest.collections).map(([name, c]) => [name, {
      activity: c.activity ?? null, parent: c.setOf?.parent ?? null,
      arrays: c.activity ? Object.values(c.activity.targets).filter((field): field is string => !!field && coreOf(c.schema.value[field].fieldType).type === "array") : [],
    }])) };
}
export function imageOf(d: Descriptor, collection: string, row: Row, root: ActivityRoot | null): ActivityImage | null {
  const c = d.collections[collection];
  if (!c?.activity) return null;
  const a = c.activity;
  const fields = [a.subject, a.at, a.owner, a.status, a.dueDate, ...Object.values(a.targets)].filter((f): f is string => f !== undefined);
  const data = Object.fromEntries(fields.map((f) => [f, row.data[f] ?? null]));
  const canonical = moduleActivityDataOf(d.moduleId, collection, a, { key: row.key, version: row.version, data, owner: row.ownerUserId ?? null, parentKey: row.parentKey ?? null, createdAt: row.sourceCreatedAt ?? row._creationTime, updatedAt: row.updatedAt });
  return { ...canonical, sourceIdentity: { moduleId: d.moduleId, collection, key: row.key }, incarnation: row._id, parentKey: row.parentKey ?? null, gen: row.gen ?? 0,
    provenance: { packageId: d.packageId, epoch: d.epoch, manifestHash: d.manifestHash, bundleHash: d.bundleHash, version: row.version, createdAt: row.sourceCreatedAt ?? row._creationTime, root, representation: { slug: d.slug, path: a.path, key: row.key } },
    available: ["kind", "subject", "at", "activityKind", ...(canonical.activity.date !== undefined ? ["date"] : []), ...(a.owner ? ["ownerId"] : []), ...(a.status ? ["status"] : []), ...(a.dueDate ? ["dueDate"] : []), ...Object.keys(a.targets).map((target) => target === "companies" ? "companyId" : target === "people" ? "personId" : "dealId")].sort(),
    scalarTargets: Object.fromEntries(Object.entries(a.targets).map(([target, field]) => [target, !c.arrays.includes(field) && typeof row.data[field] === "string" ? row.data[field] : null])),
  };
}
export const semanticImage = (image: ActivityImage) => ({ activity: image.activity, sourceIdentity: image.sourceIdentity, representation: image.provenance.representation, refs: [...image.refs].sort((a, b) => compareValues([a.object, a.id], [b.object, b.id])), available: image.available, scalarTargets: image.scalarTargets });
export const headerOf = (d: Descriptor, row: Row): RootHeader => ({ incarnation: row._id, gen: row.gen ?? 0, gens: Object.fromEntries(Object.entries(row.gens ?? {}).filter(([name]) => d.collections[name]?.parent === row.collection && d.collections[name].activity !== null)) });
export async function storeActivityParts(ctx: MutationCtx, ownerKind: Doc<"moduleActivityChunks">["ownerKind"], ownerId: Doc<"moduleActivityChunks">["ownerId"], orgId: Id<"organizations">, side: Doc<"moduleActivityChunks">["side"], bytes: Uint8Array) {
  for (let offset = 0, part = 0; offset < bytes.length; offset += ACTIVITY_PART_BYTES, part++) {
    await ctx.db.insert("moduleActivityChunks", { orgId, ownerKind, ownerId, side, part, offset, bytes: bytes.slice(offset, offset + ACTIVITY_PART_BYTES).buffer });
  }
}
export async function retainDescriptor(ctx: MutationCtx, pkg: Pkg, enabled: boolean) {
  const bytes = activityBytes(descriptorOf(pkg, enabled)), digest = await activityDigest(bytes);
  const have = await ctx.db.query("moduleActivityDescriptors").withIndex("by_packageId_digest", (q) => q.eq("packageId", pkg._id).eq("digest", digest)).unique();
  if (have) return have._id;
  const id = await ctx.db.insert("moduleActivityDescriptors", { orgId: pkg.orgId, packageId: pkg._id, digest, codec: 1, epoch: pkg.epoch ?? 1, manifestHash: pkg.manifestHash, bundleHash: pkg.bundleHash ?? null, bytes: bytes.length, parts: Math.ceil(bytes.length / ACTIVITY_PART_BYTES) });
  await storeActivityParts(ctx, "descriptor", id, pkg.orgId, "descriptor", bytes);
  return id;
}
export const activityHead = (db: QueryCtx["db"], orgId: Id<"organizations">) => db.query("moduleActivityHeads").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();

/** Only the original lifecycle's checked continuation may join its retained source. */
export async function continuationSource(ctx: MutationCtx, pkg: Pkg): Promise<ModuleSourceState> {
  const fresh = await ctx.db.get(pkg._id), p = pkg.pending;
  if (!fresh || !p || fresh.pending?.epoch !== p.epoch || fresh.pending.step !== p.step || fresh.pending.cursor !== p.cursor || fresh.pending.error !== p.error) throw new ConvexError("The module lifecycle moved before capture.");
  return { pkg: structuredClone(fresh), continuation: true, enabled: null };
}
async function memberBackfill(ctx: MutationCtx, source: ModuleSourceState): Promise<{ pkg: Pkg; publication: Pub }> {
  const expected = source.pkg;
  const pkg = await ctx.db.get(expected._id);
  if (!pkg || pkg.orgId !== expected.orgId || pkg.moduleId !== expected.moduleId || pkg.status !== "installed"
    || (pkg.epoch ?? 1) !== (expected.epoch ?? 1) || pkg.manifestHash !== expected.manifestHash || pkg.bundleHash !== expected.bundleHash
    || !expected.activityPublication || pkg.activityPublication !== expected.activityPublication
    || !pkg.pending || pkg.pending.epoch !== expected.pending?.epoch || pkg.pending.error !== undefined || pkg.pending.phase === "cutover" || holdsWrites(pkg.pending.work)) {
    throw new ConvexError("The member write no longer matches its non-migrating module backfill.");
  }
  const publication = await ctx.db.get(pkg.activityPublication);
  if (!publication || publication._id !== expected.activityPublication || publication.packageId !== pkg._id || publication.orgId !== pkg.orgId
    || publication.moduleId !== pkg.moduleId || publication.state !== "lifecycle" || !publication.retainsPackage || publication.lifecycleEpoch !== pkg.pending.epoch) {
    throw new ConvexError("The member write cannot join this activity publication.");
  }
  return { pkg, publication };
}
async function openSource(ctx: MutationCtx, source: ModuleSourceState, member?: { pkg: Pkg; publication: Pub }): Promise<Source> {
  const s = session(ctx), pkg = source.pkg;
  const existing = s.sources.get(pkg._id);
  if (existing) return existing;
  const fresh = member?.pkg ?? pkg;
  const enabled = source.enabled ?? await isEnabled(ctx, pkg.orgId, pkg.moduleId);
  let publication = member?.publication ?? await retainedSourcePublication(ctx, fresh);
  if (publication) {
    if (!member && (publication.state !== "lifecycle" || !source.continuation || publication.lifecycleEpoch !== fresh.pending?.epoch || fresh.pending?.error)) throw new ConvexError("Module activity publication is retaining this source. Retry after publication finishes.");
  } else {
    markModuleSemanticWriteAttempt(ctx);
    const descriptor = await retainDescriptor(ctx, pkg, enabled);
    const head = await activityHead(ctx.db, pkg.orgId);
    const ordinal = (head?.committedOrdinal ?? 0) + 1;
    if (!Number.isSafeInteger(ordinal)) throw new ConvexError("The activity publication ordinal is outside its supported range.");
    if (head) await ctx.db.patch(head._id, { committedOrdinal: ordinal, pending: true });
    else await ctx.db.insert("moduleActivityHeads", { orgId: pkg.orgId, version: 1, committedOrdinal: ordinal, publishedOrdinal: 0, appendedSeq: 0, readableSeq: 0, pending: true });
    const id = await ctx.db.insert("moduleActivityPublications", { orgId: pkg.orgId, packageId: pkg._id, moduleId: pkg.moduleId, ordinal,
      beforeDescriptor: descriptor, afterDescriptor: descriptor, state: "ready", lifecycleEpoch: null, retainsPackage: true, revision: 0, attempt: 0, retryAt: null, error: null,
      work: { phase: "old", collection: null, physicalCursor: null, evidenceCursor: null, side: null, frame: 0, part: 0 }, startSeq: null, endSeq: null });
    await ctx.db.patch(pkg._id, { activityPublication: id });
    publication = (await ctx.db.get(id))!;
  }
  const out: Source = { source, publication: structuredClone(publication), descriptor: descriptorOf(pkg, enabled), rows: new Map(), roots: new Map() };
  s.sources.set(pkg._id, out);
  return out;
}
export async function capturePackageState<T>(ctx: MutationCtx, source: ModuleSourceState, write: () => Promise<T>): Promise<T> {
  return writeModuleState(ctx, source, { kind: "metadata" }, write);
}
async function rootBefore(ctx: MutationCtx, source: Source, collection: string, key: string) {
  const s = session(ctx), pkg = source.source.pkg;
  const cached = s.roots.get(canonicalJson([pkg.orgId, pkg.moduleId, collection, key]));
  const row = cached ?? await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", key)).unique();
  if (row && !source.roots.has(row._id)) source.roots.set(row._id, { row: structuredClone(row), initial: "present" });
}
const objectValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
async function declarationFreePin(ctx: MutationCtx, source: ModuleSourceState, publication: Pub): Promise<boolean> {
  const fresh = await ctx.db.get(source.pkg._id), expected = source.pkg;
  if (!fresh || fresh.status !== "installed" || fresh.orgId !== expected.orgId || fresh.moduleId !== expected.moduleId || fresh.slug !== expected.slug || fresh.version !== expected.version
    || (fresh.epoch ?? 1) !== (expected.epoch ?? 1) || fresh.manifestHash !== expected.manifestHash || fresh.bundleHash !== expected.bundleHash
    || fresh.activityPublication !== publication._id) throw new ConvexError("The module source changed before its activity-free write.");
  if (fresh.pending || publication.state === "lifecycle" || Object.values(descriptorOf(fresh, false).collections).some((c) => c.activity !== null)) return false;
  const before = await ctx.db.get(publication.beforeDescriptor);
  const after = publication.afterDescriptor === publication.beforeDescriptor ? before : await ctx.db.get(publication.afterDescriptor);
  if (!before || !after) throw new ConvexError("The retained activity descriptor is missing.");
  const key = canonicalJson([fresh._id, fresh.epoch ?? 1, fresh.manifestHash, fresh.bundleHash ?? null, publication._id, before._id, before.digest, after._id, after.digest]);
  const cached = session(ctx).emptyPins.get(key);
  if (cached !== undefined) return cached;
  for (const header of before._id === after._id ? [before] : [before, after]) {
    if (header.orgId !== fresh.orgId || header.packageId !== fresh._id || header.codec !== 1 || !Number.isSafeInteger(header.bytes) || header.bytes < 1
      || !Number.isSafeInteger(header.parts) || header.parts !== Math.ceil(header.bytes / ACTIVITY_PART_BYTES)) throw new ConvexError("The retained activity descriptor header is invalid.");
    const chunks = await ctx.db.query("moduleActivityChunks").withIndex("by_ownerKind_ownerId_side_part", (q) => q.eq("ownerKind", "descriptor").eq("ownerId", header._id).eq("side", "descriptor")).take(header.parts + 1);
    if (chunks.length !== header.parts || chunks.some((part, i) => part.orgId !== fresh.orgId || part.part !== i || part.offset !== i * ACTIVITY_PART_BYTES
      || part.bytes.byteLength !== Math.min(ACTIVITY_PART_BYTES, header.bytes - i * ACTIVITY_PART_BYTES))) throw new ConvexError("The retained activity descriptor fragments are invalid.");
    const bytes = new Uint8Array(header.bytes);
    for (const chunk of chunks) bytes.set(new Uint8Array(chunk.bytes), chunk.offset);
    if (await activityDigest(bytes) !== header.digest) throw new ConvexError("The retained activity descriptor failed its digest.");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!objectValue(value) || value.packageId !== fresh._id || value.moduleId !== fresh.moduleId || value.epoch !== header.epoch || value.manifestHash !== header.manifestHash || value.bundleHash !== header.bundleHash
      || typeof value.slug !== "string" || typeof value.version !== "string" || typeof value.installed !== "boolean" || typeof value.enabled !== "boolean" || !objectValue(value.collections)) throw new ConvexError("The retained activity descriptor binding is invalid.");
    for (const collection of Object.values(value.collections)) {
      if (!objectValue(collection) || !(collection.parent === null || typeof collection.parent === "string") || !Array.isArray(collection.arrays) || collection.arrays.some((field) => typeof field !== "string")
        || !(collection.activity === null || objectValue(collection.activity))) throw new ConvexError("The retained activity declaration is invalid.");
      if (collection.activity !== null) { session(ctx).emptyPins.set(key, false); return false; }
    }
  }
  session(ctx).emptyPins.set(key, true);
  return true;
}
export async function writeModuleState<T>(ctx: MutationCtx, source: ModuleSourceState | null, change: { kind: "install" } | { kind: "metadata" } | { kind: "doc"; before: Row | null; value: Omit<Row, "_id" | "_creationTime"> | null }, write: () => Promise<T>): Promise<T> {
  const s = session(ctx);
  if (change.kind === "install") {
    if (source !== null) throw new ConvexError("A first install has no previous package.");
    markModuleSemanticWriteAttempt(ctx);
    const result = await write();
    const id = ctx.db.normalizeId("modulePackages", String(result));
    const pkg = id ? await ctx.db.get(id) : null;
    if (!pkg) throw new ConvexError("The newly installed package is missing.");
    await openSource(ctx, moduleSource({ ...pkg, status: "uninstalled" }));
    return result;
  }
  if (source === null) throw new ConvexError("An existing module write requires its source.");
  if (source.reason && change.kind !== "doc") throw new ConvexError("A member backfill join grants no package metadata write.");
  const member = source.reason ? await memberBackfill(ctx, source) : undefined;
  if (change.kind === "doc") {
    for (const row of [change.before, change.value]) if (row && (row.orgId !== source.pkg.orgId || row.moduleId !== source.pkg.moduleId)) throw new ConvexError("The capture source does not own the physical write.");
  }
  if (change.kind === "doc" && !source.continuation && !member && !s.sources.has(source.pkg._id)) {
    const d = descriptorOf(source.pkg, false), row = change.before ?? change.value;
    const c = row && d.collections[row.collection];
    const children = row && Object.values(d.collections).some((child) => child.parent === row.collection && child.activity !== null);
    let inactive = !c?.activity && !children;
    if (c?.parent && row?.parentKey && (!change.before || !change.value || (change.before.parentKey === change.value.parentKey && change.before.gen === change.value.gen))) {
      const key = canonicalJson([row.orgId, row.moduleId, c.parent, row.parentKey]);
      const root = s.roots.get(key) ?? await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", row.orgId).eq("moduleId", row.moduleId).eq("collection", c.parent!).eq("key", row.parentKey!)).unique();
      inactive = !root || (root.gens?.[row.collection] ?? root.gen ?? 0) !== (row.gen ?? 0);
    }
    if (inactive) {
      const publication = await retainedSourcePublication(ctx, source.pkg);
      if (publication && !await declarationFreePin(ctx, source, publication)) throw new ConvexError("Module activity publication is retaining this source. Retry after publication finishes.");
      markModuleSemanticWriteAttempt(ctx);
      const result = await write();
      if (change.before) s.reads.delete(change.before._id);
      return result;
    }
  }
  const state = await openSource(ctx, source, member);
  if (change.kind === "metadata") { markModuleSemanticWriteAttempt(ctx); return write(); }
  const before = change.before;
  const row = before ?? change.value;
  if (!row || row.orgId !== source.pkg.orgId || row.moduleId !== source.pkg.moduleId) throw new ConvexError("The capture source does not own the physical write.");
  const c = state.descriptor.collections[row.collection];
  if (before) {
    if (!state.rows.has(before._id)) state.rows.set(before._id, { row: structuredClone(before), initial: "present" });
    if (!c?.parent && !state.roots.has(before._id)) state.roots.set(before._id, { row: structuredClone(before), initial: "present" });
  }
  if (c?.parent && row.parentKey) await rootBefore(ctx, state, c.parent, row.parentKey);
  markModuleSemanticWriteAttempt(ctx);
  const result = await write();
  if (before) {
    s.reads.delete(before._id);
  } else {
    const id = ctx.db.normalizeId("moduleDocs", String(result));
    const inserted = id ? await ctx.db.get(id) : null;
    if (!inserted) throw new ConvexError("The inserted module incarnation is missing.");
    state.rows.set(inserted._id, { row: structuredClone(inserted), initial: "absent" });
    if (!c?.parent) state.roots.set(inserted._id, { row: structuredClone(inserted), initial: "absent" });
  }
  return result;
}
async function retainEvidence(ctx: MutationCtx, source: Source, kind: "row" | "root", saved: Saved, root: { evidence: Id<"moduleActivityEvidence">; header: RootHeader } | null = null) {
  const { row, initial } = saved, publication = source.publication;
  const have = await ctx.db.query("moduleActivityEvidence").withIndex("by_publicationId_kind_incarnation", (q) => q.eq("publicationId", publication._id).eq("kind", kind).eq("incarnation", row._id)).unique();
  if (have) {
    let header: RootHeader | null = null;
    if (kind === "root" && have.initial === "present") {
      const chunks = await ctx.db.query("moduleActivityChunks").withIndex("by_ownerKind_ownerId_side_part", (q) => q.eq("ownerKind", "evidence").eq("ownerId", have._id).eq("side", "header")).take(have.parts);
      if (chunks.length !== have.parts || chunks.some((c, i) => c.part !== i || c.offset !== i * ACTIVITY_PART_BYTES)) throw new ConvexError("The retained initial root header is incomplete.");
      const bytes = new Uint8Array(have.bytes);
      for (const chunk of chunks) bytes.set(new Uint8Array(chunk.bytes), chunk.offset);
      if (await activityDigest(bytes) !== have.digest) throw new ConvexError("The retained initial root header failed its digest.");
      header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as RootHeader;
    }
    return { id: have._id, initial: have.initial, header };
  }
  const image = kind === "row" && initial === "present" ? imageOf(source.descriptor, row.collection, row, root ? { incarnation: root.header.incarnation, generation: root.header.gens[row.collection] ?? root.header.gen } : null) : null;
  const value = initial === "absent" ? null : kind === "root" ? headerOf(source.descriptor, row) : image;
  if (kind === "row" && value === null && initial === "present") return;
  const bytes = activityBytes(value), digest = await activityDigest(bytes);
  const id = await ctx.db.insert("moduleActivityEvidence", { orgId: row.orgId, publicationId: publication._id, kind, collection: row.collection, key: row.key, incarnation: row._id, initial, descriptorId: publication.beforeDescriptor, digest, bytes: bytes.length, parts: Math.ceil(bytes.length / ACTIVITY_PART_BYTES) });
  await storeActivityParts(ctx, "evidence", id, row.orgId, kind === "root" ? "header" : "before", bytes);
  if (kind === "row") await storeActivityParts(ctx, "evidence", id, row.orgId, "header", activityBytes({ root: root?.evidence ?? null, gen: row.gen ?? 0, semantic: image === null ? null : await activityDigest(activityBytes(semanticImage(image))) }));
  return { id, initial, header: kind === "root" && initial === "present" ? headerOf(source.descriptor, row) : null };
}
async function flush(ctx: MutationCtx, s: Session) {
  for (const state of s.sources.values()) {
    markModuleSemanticWriteAttempt(ctx);
    const roots = new Map<string, { evidence: Id<"moduleActivityEvidence">; header: RootHeader } | null>();
    for (const saved of state.roots.values()) {
      const retained = await retainEvidence(ctx, state, "root", saved);
      const key = canonicalJson([saved.row.collection, saved.row.key]);
      if (retained?.initial === "present" && retained.header) roots.set(key, { evidence: retained.id, header: retained.header });
      else if (!roots.has(key)) roots.set(key, null);
    }
    for (const saved of state.rows.values()) {
      const parent = state.descriptor.collections[saved.row.collection]?.parent;
      await retainEvidence(ctx, state, "row", saved, parent ? roots.get(canonicalJson([parent, saved.row.parentKey])) ?? null : null);
    }
    const pkg = await ctx.db.get(state.source.pkg._id);
    if (!pkg) throw new ConvexError("A retained module package cannot be removed.");
    const afterDescriptor = await retainDescriptor(ctx, pkg, await isEnabled(ctx, pkg.orgId, pkg.moduleId));
    const lifecycle = pkg.pending && !pkg.pending.error;
    const update = { afterDescriptor, state: lifecycle ? "lifecycle" as const : "ready" as const, lifecycleEpoch: lifecycle ? pkg.pending!.epoch : null, revision: state.publication.revision + 1 };
    await ctx.db.patch(state.publication._id, update);
    state.publication = { ...state.publication, ...update };
    if (!lifecycle) await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.run, { orgId: pkg.orgId });
  }
}
export async function withModulePublication<T>(ctx: MutationCtx, body: () => Promise<T>): Promise<T> {
  let s = sessions.get(ctx.db);
  if (!s || (!s.depth && s.owner !== ctx)) { s = { owner: ctx, depth: 0, sources: new Map(), reads: new Map(), roots: new Map(), emptyPins: new Map(), generation: 0, failure: null }; sessions.set(ctx.db, s); }
  if (s.owner !== ctx) throw new ConvexError("A module publication belongs to its original mutation context.");
  if (s.failure) throw s.failure;
  const entered = s.generation;
  s.depth++;
  try {
    const result = await body();
    if (s.failure) throw s.failure;
    if (s.depth === 1) await flush(ctx, s);
    return result;
  } catch (error) {
    if (s.failure) throw s.failure;
    if (s.generation !== entered) { s.failure = new ModuleWriteFailure(error); throw s.failure; }
    throw error;
  }
  finally { s.depth--; }
}

export function activityWatchHash(m: ModuleManifest, watch: NonNullable<ModuleManifest["watches"]>[number], epoch: number) {
  return activityDigest(activityBytes({ watch, epoch, reads: m.reads?.activities ?? null }));
}

export async function capturePendingActivityDescriptor<T>(ctx: MutationCtx, pkg: Pick<Pkg, "_id">, write: () => Promise<T>): Promise<T> {
  const s = session(ctx), state = s.sources.get(pkg._id);
  if (!state) throw new ConvexError("Pending manifest cleanup requires captured package state.");
  const current = await ctx.db.get(pkg._id);
  if (!current) throw new ConvexError("The retained package is missing.");
  markModuleSemanticWriteAttempt(ctx);
  await retainDescriptor(ctx, current, await isEnabled(ctx, current.orgId, current.moduleId));
  return capturePackageState(ctx, state.source, write);
}

export function captureInstalledPackage<T>(ctx: MutationCtx, write: () => Promise<T>) {
  return writeModuleState(ctx, null, { kind: "install" }, write);
}
