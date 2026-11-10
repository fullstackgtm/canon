import { compareValues, ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { ACTIVITY_PART_BYTES, activityBytes, activityDigest, activityHead, imageOf, semanticImage, type Descriptor, type RootHeader, type ActivityRoot } from "./activityCapture";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { hasKeys } from "./jobs";
import { manifestOf } from "./packages";

type Pub = Doc<"moduleActivityPublications">;
type Journal = Id<"moduleActivityJournal">;
type Evidence = Id<"moduleActivityEvidence">;
type Incarnation = Id<"moduleDocs">;
type Anchor = { kind: "physical"; id: Incarnation } | { kind: "evidence"; id: Evidence };
type RangePosition = { kind: "range"; root: Evidence; oldGen: number | null; newGen: number | null; side: "before" | "after"; last: Incarnation | null };
type Place = { anchor: Anchor; evidence: Evidence | null; hasOld: boolean; resume?: RangePosition };
type Sided = Place & { side: "before" | "after"; journal: Journal | null; beforeSemantic: string | null; root: ActivityRoot | null };
type Candidate = Place & { journal: Journal; beforeSemantic: string | null; afterSemantic: string | null };
type Position =
  | { kind: "select"; last: Anchor | null }
  | { kind: "rootSelect"; last: Evidence | null }
  | { kind: "rootEvidence"; anchor: Evidence; scan: Incarnation | null; before: Evidence | null }
  | { kind: "rootBounds"; anchor: Evidence; before: Evidence | null }
  | RangePosition
  | (Place & { kind: "evidence"; scan: Incarnation | null; seen: boolean })
  | (Sided & { kind: "root"; scan: Incarnation | null; seen: boolean })
  | (Sided & { kind: "rootHeader"; rootEvidence: Evidence; gen: number })
  | (Sided & { kind: "side"; visible: boolean; part: number })
  | (Candidate & { kind: "compare" | "discard" });
type RowHeader = { root: Evidence | null; gen: number; semantic: string | null };

class Budget {
  // The publication, org head and pinned package were already read.
  left = 47;
  folds = 0;
  take(n = 1) { if (n > this.left) return false; this.left -= n; return true; }
}
function fail(message: string): never { throw new ConvexError(message); }
const parse = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
function joined(rows: Doc<"moduleActivityChunks">[]) {
  if (rows.some((r, i) => r.part !== i || r.offset !== i * ACTIVITY_PART_BYTES || r.bytes.byteLength > ACTIVITY_PART_BYTES)) fail("Module activity fragments are missing or out of order.");
  const bytes = new Uint8Array(rows.reduce((n, r) => n + r.bytes.byteLength, 0));
  let offset = 0;
  for (const row of rows) { bytes.set(new Uint8Array(row.bytes), offset); offset += row.bytes.byteLength; }
  return bytes;
}
async function parts(ctx: Pick<QueryCtx, "db">, ownerKind: Doc<"moduleActivityChunks">["ownerKind"], ownerId: Doc<"moduleActivityChunks">["ownerId"], side: Doc<"moduleActivityChunks">["side"], count: number, budget: Budget) {
  if (!budget.take(count)) fail("The retained activity header cannot fit one bounded step.");
  const rows = await ctx.db.query("moduleActivityChunks").withIndex("by_ownerKind_ownerId_side_part", (q) => q.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("side", side)).take(count);
  if (rows.length !== count) fail("A retained module activity fragment is missing.");
  return joined(rows);
}
async function rowHeader(ctx: Pick<QueryCtx, "db">, id: Evidence, budget: Budget) {
  const bytes = await parts(ctx, "evidence", id, "header", 1, budget);
  budget.folds++;
  return parse<RowHeader>(bytes);
}

async function descriptor(ctx: Pick<QueryCtx, "db">, id: Id<"moduleActivityDescriptors">, budget: Budget) {
  if (!budget.take()) fail("No bounded work remains for the activity descriptor.");
  const row = await ctx.db.get(id);
  if (!row) fail("A retained activity descriptor is missing.");
  const bytes = await parts(ctx, "descriptor", id, "descriptor", row.parts, budget);
  if (bytes.length !== row.bytes || await activityDigest(bytes) !== row.digest) fail("A retained activity descriptor failed its digest.");
  budget.folds++;
  return parse<Descriptor>(bytes);
}
async function keyOf(ctx: Pick<QueryCtx, "db">, anchor: Anchor, budget: Budget) {
  if (!budget.take()) fail("No bounded work remains for the activity identity.");
  const row = await ctx.db.get(anchor.id);
  if (!row) fail("The pinned activity identity is missing.");
  return row.key;
}
async function physical(ctx: Pick<QueryCtx, "db">, pub: Pub, collection: string, key: string, budget: Budget) {
  if (!budget.take()) fail("No bounded work remains for the physical activity row.");
  return ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pub.orgId).eq("moduleId", pub.moduleId).eq("collection", collection).eq("key", key)).unique();
}
async function evidenceNext(ctx: Pick<QueryCtx, "db">, pub: Pub, kind: "row" | "root", collection: string, key: string, scan: Incarnation | null, budget: Budget) {
  if (!budget.take()) fail("No bounded work remains for initial activity evidence.");
  return ctx.db.query("moduleActivityEvidence").withIndex("by_publicationId_kind_collection_key_incarnation", (q) => {
    const at = q.eq("publicationId", pub._id).eq("kind", kind).eq("collection", collection).eq("key", key);
    return scan === null ? at : at.gt("incarnation", scan);
  }).first();
}
const workFor = (pub: Pub, position: Position, collection: string | null = pub.work.collection) => ({ ...pub.work, phase: "diff" as const, collection, physicalCursor: null, evidenceCursor: JSON.stringify(position), side: position.kind === "side" || position.kind === "root" || position.kind === "rootHeader" ? position.side : null, part: position.kind === "side" ? position.part : 0 });
async function save(ctx: MutationCtx, pub: Pub, position: Position, collection?: string | null) {
  await ctx.db.patch(pub._id, { state: "publishing", revision: pub.revision + 1, work: workFor(pub, position, collection) });
}
const placeOf = (p: Place): Place => ({ anchor: p.anchor, evidence: p.evidence, hasOld: p.hasOld, ...(p.resume ? { resume: p.resume } : {}) });
const resume = (p: Place): Position => p.resume ?? { kind: "select", last: p.anchor };
function activityShape(d: Descriptor, collection: string) {
  const c = d.collections[collection];
  return { moduleId: d.moduleId, slug: d.slug, installed: d.installed, enabled: d.enabled, activity: c?.activity ?? null, parent: c?.parent ?? null, arrays: [...(c?.arrays ?? [])].sort() };
}
async function nextCollection(ctx: MutationCtx, pub: Pub, collections: string[], collection: string) {
  const next = collections[collections.indexOf(collection) + 1];
  if (next === undefined) await ctx.db.patch(pub._id, { state: "publishing", revision: pub.revision + 1, work: { ...pub.work, phase: "gc" } });
  else await save(ctx, pub, { kind: "select", last: null }, next);
}
const collectionsOf = (before: Descriptor, after: Descriptor) => [...new Set([...Object.keys(before.collections).filter((k) => before.collections[k].activity), ...Object.keys(after.collections).filter((k) => after.collections[k].activity)])].sort();
const sideOf = (p: Sided, visible: boolean, root: ActivityRoot | null = null): Position => ({ ...placeOf(p), kind: "side", side: p.side, journal: p.journal, beforeSemantic: p.beforeSemantic, visible, root, part: 0 });
async function candidate(ctx: MutationCtx, pub: Pub, head: Doc<"moduleActivityHeads">) {
  if (!Number.isSafeInteger(head.appendedSeq + 1)) fail("The activity journal sequence is outside its supported range.");
  return ctx.db.insert("moduleActivityJournal", { orgId: pub.orgId, seq: head.appendedSeq + 1, publicationId: pub._id, ordinal: pub.ordinal, kind: "change", frame: pub.work.frame, at: Date.now(), beforeDescriptor: pub.beforeDescriptor, afterDescriptor: pub.afterDescriptor, beforeDigest: null, afterDigest: null, beforeBytes: 0, afterBytes: 0, beforeParts: 0, afterParts: 0 });
}

/** One step commits only publication data. It never invokes a module semantic writer. */
export async function publishActivityStep(ctx: MutationCtx, id: Id<"moduleActivityPublications">, revision: number): Promise<{ more: boolean; revision: number; folds: number }> {
  const pub = await ctx.db.get(id);
  if (!pub || pub.revision !== revision || pub.state === "complete") return { more: false, revision: pub?.revision ?? revision, folds: 0 };
  const head = await activityHead(ctx.db, pub.orgId), pkg = await ctx.db.get(pub.packageId);
  if (!head || !pkg || pkg.activityPublication !== pub._id || !pub.retainsPackage) fail("The activity publication lost its source pin.");
  if (pub.ordinal !== head.publishedOrdinal + 1 || pub.state === "lifecycle" || (pub.retryAt !== null && pub.retryAt > Date.now())) return { more: false, revision, folds: 0 };
  const budget = new Budget();
  if (pub.work.phase === "gc") {
    const row = await ctx.db.query("moduleActivityEvidence").withIndex("by_publicationId_kind_incarnation", (q) => q.eq("publicationId", pub._id)).first();
    budget.take();
    if (row) {
      const chunks = await ctx.db.query("moduleActivityChunks").withIndex("by_ownerKind_ownerId_side_part", (q) => q.eq("ownerKind", "evidence").eq("ownerId", row._id)).take(budget.left);
      for (const chunk of chunks) await ctx.db.delete(chunk._id);
      if (!chunks.length) await ctx.db.delete(row._id);
      await ctx.db.patch(id, { state: "publishing", revision: revision + 1 });
    } else await ctx.db.patch(id, { state: "publishing", revision: revision + 1, work: { ...pub.work, phase: "finish" } });
    return { more: true, revision: revision + 1, folds: 0 };
  }
  if (pub.work.phase === "finish") {
    const seq = head.appendedSeq + 1;
    if (!Number.isSafeInteger(seq)) fail("The activity journal sequence is outside its supported range.");
    await ctx.db.insert("moduleActivityJournal", { orgId: pub.orgId, seq, publicationId: pub._id, ordinal: pub.ordinal, kind: "complete", frame: pub.work.frame, at: Date.now(), beforeDescriptor: pub.beforeDescriptor, afterDescriptor: pub.afterDescriptor, beforeDigest: null, afterDigest: null, beforeBytes: 0, afterBytes: 0, beforeParts: 0, afterParts: 0 });
    await ctx.db.patch(head._id, { appendedSeq: seq, readableSeq: seq, publishedOrdinal: pub.ordinal, pending: head.committedOrdinal !== pub.ordinal });
    await ctx.db.patch(pkg._id, { activityPublication: undefined });
    await ctx.db.patch(id, { state: "complete", retainsPackage: false, endSeq: seq, startSeq: pub.startSeq ?? seq, revision: revision + 1, retryAt: null, error: null });
    if (manifestOf(pkg).imports?.length) await ctx.scheduler.runAfter(0, internal.modules.resumeImports, { packageId: pkg._id, publicationId: id });
    if (await hasKeys(ctx.db, pkg.orgId, pkg.moduleId)) await ctx.scheduler.runAfter(0, internal.moduleJobs.run, { orgId: pkg.orgId, moduleId: pkg.moduleId });
    return { more: false, revision: revision + 1, folds: 0 };
  }
  let position: Position = pub.work.evidenceCursor ? JSON.parse(pub.work.evidenceCursor) as Position : { kind: "select", last: null };
  let collection = pub.work.collection;
  if (position.kind === "select") {
    const before = await descriptor(ctx, pub.beforeDescriptor, budget), after = await descriptor(ctx, pub.afterDescriptor, budget);
    const collections = collectionsOf(before, after);
    if (collection === null) collection = collections[0] ?? null;
    if (collection === null) await ctx.db.patch(id, { state: "publishing", revision: revision + 1, work: { ...pub.work, phase: "gc" } });
    else {
      const last = position.last ? await keyOf(ctx, position.last, budget) : null;
      const full = canonicalJson(activityShape(before, collection)) !== canonicalJson(activityShape(after, collection));
      if (!budget.take(full ? 2 : 1)) fail("The activity selection step exhausted its bounded work.");
      const row = full ? await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => {
        const at = q.eq("orgId", pub.orgId).eq("moduleId", pub.moduleId).eq("collection", collection!);
        return last === null ? at : at.gt("key", last);
      }).first() : null;
      const ev = await ctx.db.query("moduleActivityEvidence").withIndex("by_publicationId_kind_collection_key_incarnation", (q) => {
        const at = q.eq("publicationId", id).eq("kind", "row").eq("collection", collection!);
        return last === null ? at : at.gt("key", last);
      }).first();
      const anchor: Anchor | null = ev && (!row || compareValues(ev.key, row.key) <= 0) ? { kind: "evidence", id: ev._id } : row ? { kind: "physical", id: row._id } : null;
      if (anchor) await save(ctx, pub, { kind: "evidence", anchor, evidence: null, hasOld: anchor.kind === "physical", scan: null, seen: false }, collection);
      else if (!full && after.collections[collection]?.parent && after.installed && after.enabled) await save(ctx, pub, { kind: "rootSelect", last: null }, collection);
      else await nextCollection(ctx, pub, collections, collection);
    }
  } else if (position.kind === "rootSelect") {
    const before = await descriptor(ctx, pub.beforeDescriptor, budget), after = await descriptor(ctx, pub.afterDescriptor, budget);
    const parent = after.collections[collection!]?.parent;
    if (!parent) fail("A delta range lost its activity parent.");
    const last = position.last ? await keyOf(ctx, { kind: "evidence", id: position.last }, budget) : null;
    budget.take();
    const root = await ctx.db.query("moduleActivityEvidence").withIndex("by_publicationId_kind_collection_key_incarnation", (q) => {
      const at = q.eq("publicationId", id).eq("kind", "root").eq("collection", parent);
      return last === null ? at : at.gt("key", last);
    }).first();
    if (!root) await nextCollection(ctx, pub, collectionsOf(before, after), collection!);
    else await save(ctx, pub, { kind: "rootEvidence", anchor: root._id, scan: null, before: null });
  } else if (position.kind === "rootEvidence") {
    const after = await descriptor(ctx, pub.afterDescriptor, budget), parent = after.collections[collection!]?.parent;
    if (!parent) fail("A delta range lost its activity parent.");
    const key = await keyOf(ctx, { kind: "evidence", id: position.anchor }, budget);
    let done = false;
    while (budget.left > 1) {
      const row = await evidenceNext(ctx, pub, "root", parent, key, position.scan, budget);
      if (!row) { done = true; break; }
      if (row.initial === "present") {
        if (position.before) fail("Two original root incarnations share one activity parent key.");
        position.before = row._id;
      }
      position.scan = row.incarnation;
    }
    await save(ctx, pub, done ? { kind: "rootBounds", anchor: position.anchor, before: position.before } : position);
  } else if (position.kind === "rootBounds") {
    const after = await descriptor(ctx, pub.afterDescriptor, budget), parent = after.collections[collection!]?.parent;
    if (!parent) fail("A delta range lost its activity parent.");
    const key = await keyOf(ctx, { kind: "evidence", id: position.anchor }, budget);
    const current = await physical(ctx, pub, parent, key, budget);
    let old: RootHeader | null = null;
    if (position.before) {
      budget.take(); const ev = await ctx.db.get(position.before);
      if (!ev || ev.initial !== "present") fail("The original delta root is missing.");
      const bytes = await parts(ctx, "evidence", ev._id, "header", ev.parts, budget);
      if (bytes.length !== ev.bytes || await activityDigest(bytes) !== ev.digest) fail("The original delta root failed its digest.");
      old = parse<RootHeader>(bytes); budget.folds++;
    }
    const oldGen = old ? old.gens[collection!] ?? old.gen : null;
    const newGen = current ? current.gens?.[collection!] ?? current.gen ?? 0 : null;
    if (oldGen === newGen && (old?.incarnation ?? null) === (current?._id ?? null)) await save(ctx, pub, { kind: "rootSelect", last: position.anchor });
    else await save(ctx, pub, { kind: "range", root: position.anchor, oldGen, newGen, side: oldGen === null ? "after" : "before", last: null });
  } else if (position.kind === "range") {
    const key = await keyOf(ctx, { kind: "evidence", id: position.root }, budget);
    const last = position.last ? await keyOf(ctx, { kind: "physical", id: position.last }, budget) : null;
    const gen = position.side === "before" ? position.oldGen : position.newGen;
    budget.take();
    const row = gen === null ? null : await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => {
      const at = q.eq("orgId", pub.orgId).eq("moduleId", pub.moduleId).eq("collection", collection!).eq("parentKey", key).eq("gen", gen);
      return last === null ? at : at.gt("key", last);
    }).first();
    if (!row) {
      if (position.side === "before" && position.newGen !== null && position.newGen !== position.oldGen) await save(ctx, pub, { ...position, side: "after", last: null });
      else await save(ctx, pub, { kind: "rootSelect", last: position.root });
    } else {
      const next: RangePosition = { ...position, last: row._id };
      const captured = await evidenceNext(ctx, pub, "row", collection!, row.key, null, budget);
      if (captured) await save(ctx, pub, next);
      else await save(ctx, pub, { kind: "evidence", anchor: { kind: "physical", id: row._id }, evidence: null, hasOld: true, scan: null, seen: false, resume: next });
    }
  } else if (position.kind === "evidence") {
    const key = await keyOf(ctx, position.anchor, budget);
    while (budget.left > 1) {
      const row = await evidenceNext(ctx, pub, "row", collection!, key, position.scan, budget);
      if (!row) {
        position = { ...placeOf(position), kind: "root", hasOld: position.evidence !== null || !position.seen, side: "before", scan: null, seen: false, journal: null, beforeSemantic: null, root: null };
        break;
      }
      if (row.initial === "present") {
        if (position.evidence) fail("Two original module incarnations share a logical activity key.");
        position.evidence = row._id;
      }
      position.scan = row.incarnation; position.seen = true;
    }
    await save(ctx, pub, position);
  } else if (position.kind === "rootHeader") {
    budget.take(); const ev = await ctx.db.get(position.rootEvidence);
    if (!ev || ev.initial !== "present") fail("The initial activity root header is missing.");
    const bytes = await parts(ctx, "evidence", ev._id, "header", ev.parts, budget);
    if (bytes.length !== ev.bytes || await activityDigest(bytes) !== ev.digest) fail("The initial activity root header failed its digest.");
    budget.folds++;
    const header = parse<RootHeader>(bytes);
    await save(ctx, pub, sideOf(position, (header.gens[collection!] ?? header.gen) === position.gen, { incarnation: header.incarnation, generation: header.gens[collection!] ?? header.gen }));
  } else if (position.kind === "root") {
    const d = await descriptor(ctx, position.side === "before" ? pub.beforeDescriptor : pub.afterDescriptor, budget);
    const c = d.collections[collection!];
    if (!d.installed || !d.enabled || !c?.activity || (position.side === "before" && !position.hasOld)) await save(ctx, pub, sideOf(position, false));
    else if (!c.parent) {
      const exists = position.side === "before" || await physical(ctx, pub, collection!, await keyOf(ctx, position.anchor, budget), budget) !== null;
      await save(ctx, pub, sideOf(position, exists));
    }
    else {
      const key = await keyOf(ctx, position.anchor, budget);
      if (position.side === "before" && position.evidence) {
        const header = await rowHeader(ctx, position.evidence, budget);
        if (header.root) await save(ctx, pub, { ...placeOf(position), kind: "rootHeader", side: position.side, journal: position.journal, beforeSemantic: position.beforeSemantic, root: null, rootEvidence: header.root, gen: header.gen });
        else await save(ctx, pub, sideOf(position, false));
      } else {
        const row = await physical(ctx, pub, collection!, key, budget), parentKey = row?.parentKey, gen = row?.gen ?? 0;
        if (!parentKey) await save(ctx, pub, sideOf(position, false));
        else if (position.side === "after") {
          const root = await physical(ctx, pub, c.parent, parentKey, budget);
          await save(ctx, pub, sideOf(position, !!root && (root.gens?.[collection!] ?? root.gen ?? 0) === gen, root ? { incarnation: root._id, generation: root.gens?.[collection!] ?? root.gen ?? 0 } : null));
        } else {
          const ev = await evidenceNext(ctx, pub, "root", c.parent, parentKey, position.scan, budget);
          if (ev?.initial === "present") await save(ctx, pub, { ...placeOf(position), kind: "rootHeader", side: position.side, journal: position.journal, beforeSemantic: position.beforeSemantic, root: null, rootEvidence: ev._id, gen });
          else if (ev) await save(ctx, pub, { ...position, scan: ev.incarnation, seen: true });
          else {
            const root = position.seen ? null : await physical(ctx, pub, c.parent, parentKey, budget);
            await save(ctx, pub, sideOf(position, !!root && (root.gens?.[collection!] ?? root.gen ?? 0) === gen, root ? { incarnation: root._id, generation: root.gens?.[collection!] ?? root.gen ?? 0 } : null));
          }
        }
      }
    }
  } else if (position.kind === "side") {
    let journal = position.journal;
    if (!journal) { budget.take(); journal = await candidate(ctx, pub, head); }
    let semantic: string | null = null, digest: string | null = null;
    let bytesLength = 0, count = 0;
    let bytes: Uint8Array | null = null;
    let ev: Doc<"moduleActivityEvidence"> | null = null;
    if (position.visible) {
      if (position.side === "before" && position.evidence) {
        budget.take(); ev = await ctx.db.get(position.evidence);
        if (!ev) fail("The retained first activity image is missing.");
        semantic = (await rowHeader(ctx, ev._id, budget)).semantic;
        digest = ev.digest; bytesLength = ev.bytes; count = ev.parts;
      } else {
        const d = await descriptor(ctx, position.side === "before" ? pub.beforeDescriptor : pub.afterDescriptor, budget);
        const key = await keyOf(ctx, position.anchor, budget), row = await physical(ctx, pub, collection!, key, budget);
        const image = row && imageOf(d, collection!, row, position.root);
        if (!image) fail("A pinned activity disappeared during publication.");
        budget.folds++;
        bytes = activityBytes(image); bytesLength = bytes.length; count = Math.ceil(bytesLength / ACTIVITY_PART_BYTES);
        digest = await activityDigest(bytes); semantic = await activityDigest(activityBytes(semanticImage(image)));
      }
    }
    let part = position.part;
    while (part < count && budget.take(ev ? 2 : 1)) {
      let chunk: ArrayBuffer;
      if (ev) {
        const row = await ctx.db.query("moduleActivityChunks").withIndex("by_ownerKind_ownerId_side_part", (q) => q.eq("ownerKind", "evidence").eq("ownerId", ev!._id).eq("side", "before").eq("part", part)).unique();
        if (!row || row.offset !== part * ACTIVITY_PART_BYTES) fail("A first activity image fragment is missing.");
        chunk = row.bytes;
      } else chunk = bytes!.slice(part * ACTIVITY_PART_BYTES, (part + 1) * ACTIVITY_PART_BYTES).buffer;
      await ctx.db.insert("moduleActivityChunks", { orgId: pub.orgId, ownerKind: "journal", ownerId: journal, side: position.side, part, offset: part * ACTIVITY_PART_BYTES, bytes: chunk });
      part++;
    }
    if (part < count) await save(ctx, pub, { ...position, journal, part });
    else {
      await ctx.db.patch(journal, position.side === "before" ? { beforeDigest: digest, beforeBytes: bytesLength, beforeParts: count } : { afterDigest: digest, afterBytes: bytesLength, afterParts: count });
      if (position.side === "before") await save(ctx, pub, { ...placeOf(position), kind: "root", side: "after", scan: null, seen: false, journal, beforeSemantic: semantic, root: null });
      else await save(ctx, pub, { ...placeOf(position), kind: "compare", journal, beforeSemantic: position.beforeSemantic, afterSemantic: semantic });
    }
  } else if (position.kind === "compare") {
    if (position.beforeSemantic === position.afterSemantic) await save(ctx, pub, { ...position, kind: "discard" });
    else {
      budget.take(); const frame = await ctx.db.get(position.journal);
      if (!frame || frame.seq !== head.appendedSeq + 1) fail("The activity append sequence changed.");
      await ctx.db.patch(head._id, { appendedSeq: frame.seq });
      await ctx.db.patch(id, { state: "publishing", revision: revision + 1, startSeq: pub.startSeq ?? frame.seq, work: { ...workFor(pub, resume(position)), frame: pub.work.frame + 1 } });
    }
  } else {
    const journal = position.journal;
    const chunks = await ctx.db.query("moduleActivityChunks").withIndex("by_ownerKind_ownerId_side_part", (q) => q.eq("ownerKind", "journal").eq("ownerId", journal)).take(budget.left);
    for (const row of chunks) await ctx.db.delete(row._id);
    if (chunks.length) await save(ctx, pub, position);
    else { await ctx.db.delete(position.journal); await save(ctx, pub, resume(position)); }
  }
  return { more: true, revision: revision + 1, folds: budget.folds };
}

export async function publicationStatus(db: QueryCtx["db"], orgId: Id<"organizations">) {
  const head = await activityHead(db, orgId);
  const first = head?.pending ? await db.query("moduleActivityPublications").withIndex("by_orgId_ordinal", (q) => q.eq("orgId", orgId).eq("ordinal", head.publishedOrdinal + 1)).unique() : null;
  return { committedOrdinal: head?.committedOrdinal ?? 0, publishedOrdinal: head?.publishedOrdinal ?? 0, readableSeq: head?.readableSeq ?? 0, appendedSeq: head?.appendedSeq ?? 0, pending: head?.pending ?? false, state: first?.state ?? null, error: first?.error ? "Activity publication needs retry." : null, attempt: first?.attempt ?? 0, retryAt: first?.retryAt ?? null };
}
