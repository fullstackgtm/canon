/**
 * Upgrading an installed module in place (docs/modules.md, "Upgrades"): which of moduleDocs' 8 index slots each
 * collection's indexes use, and what moving from one version's manifest to the next needs before the new version can
 * serve reads. Pure: convex/modules.ts plans with it, and the install screen shows its answer.
 */
import { MAX_INDEXES, type ModuleManifest } from "./manifest.ts";
import { roomRecordCollections } from "./room.ts";

/** Per collection, the slot (0 to 7) each named index fills. Recorded per installed version. */
export type SlotMap = Record<string, Record<string, number>>;

/**
 * What a work item does to every doc of its collection: refill its new slots and check it against the new schema,
 * delete it, or run the module's migration `call` on it (docs/modules.md, "Upgrades and migrations").
 */
export type UpgradeWork = { collection: string; mode: "rewrite"; owner?: boolean } | { collection: string; mode: "drop" } | { collection: string; mode: "migrate"; call: string };

export type UpgradePlan = {
  slots: SlotMap;
  /** The collections whose docs must be rewritten or deleted, in batches, before the new version serves. */
  work: UpgradeWork[];
  /** Collections whose index moved to a new slot, and those whose schema changed. */
  reindexed: string[];
  rechecked: string[];
  /** Collections the new version leaves out and doesn't migrate: their docs are deleted, once the person confirms it. */
  dropped: string[];
  /** Collections whose docs the module's migrations rewrite, fold into others or drop. */
  migrated: string[];
  /** Canon fields the new version reads that the installed one didn't, as "deals.amount": a person approves them. */
  newReads: string[];
  /** Why the upgrade can't run at all. */
  problems: string[];
};

/** The slots a manifest's indexes fill when nothing came before: each collection's in the order declared. */
export function defaultSlots(m: Pick<ModuleManifest, "collections">): SlotMap {
  return Object.fromEntries(Object.entries(m.collections).map(([name, c]) => [name, Object.fromEntries(Object.keys(c.indexes).map((ix, i) => [ix, i]))]));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * How to move a module's docs from `from` (laid out by `fromSlots`) to `to`. An index that keeps its name and fields
 * keeps its slot; a new or changed one takes a slot the installed version doesn't use, so the installed version keeps
 * reading its own while the new slots fill. A changed schema rechecks every doc of the collection. A collection with a
 * migration whose range holds `installed` (the version installed) migrates instead.
 */
export function planUpgrade(from: ModuleManifest, fromSlots: SlotMap, to: ModuleManifest, installed = from.version): UpgradePlan {
  const slots: SlotMap = {};
  const work: UpgradeWork[] = [];
  const reindexed: string[] = [], rechecked: string[] = [], problems: string[] = [];
  const beforeRecords = roomRecordCollections(from), afterRecords = roomRecordCollections(to);
  for (const name of afterRecords) if (from.collections[name] && !beforeRecords.has(name)) problems.push(`${name} already holds module-owned data; Canon visitor records need a new collection`);
  for (const name of beforeRecords) if (to.collections[name] && !afterRecords.has(name)) problems.push(`${name} must remain Canon-owned until the collection is removed`);
  // Each collection's migration from the installed version: the first entry whose range holds it.
  const calls = new Map<string, string>();
  for (const [name, list] of Object.entries(to.migrations ?? {})) {
    const hit = list.find((x) => inRange(installed, x.from));
    if (!hit) continue;
    if (!from.collections[name]) problems.push(`it migrates ${name}, which v${installed} doesn't have`);
    else calls.set(name, hit.call);
  }
  for (const [name, c] of Object.entries(to.collections)) {
    const old = from.collections[name];
    if (!old) { slots[name] = defaultSlots({ collections: { [name]: c } })[name]; continue; }
    if (!same(old.key, c.key)) problems.push(`${name}'s key changes, and a stored doc's key can't`);
    if (old.setOf?.parent !== c.setOf?.parent) problems.push(`${name} changes the collection it is a set of`);
    // Adding an owner only narrows who sees a doc (docs without one read as nobody's own); changing or removing one doesn't.
    const ownerAdded = old.owner === undefined && c.owner !== undefined;
    if (old.owner !== c.owner && !ownerAdded) problems.push(`${name} changes its owner field`);
    const before = fromSlots[name] ?? {};
    const used = new Set(Object.values(before));
    const mine: Record<string, number> = {};
    let moved = false;
    for (const [ix, fields] of Object.entries(c.indexes)) {
      if (Object.hasOwn(before, ix) && same(old.indexes[ix], fields)) { mine[ix] = before[ix]; continue; }
      const free = Array.from({ length: MAX_INDEXES }, (_, i) => i).find((i) => !used.has(i));
      if (free === undefined) { problems.push(`${name} has no free index slot for ${ix}: the installed version uses all ${MAX_INDEXES}. Release one in an upgrade before this one`); continue; }
      used.add(free);
      mine[ix] = free;
      moved = true;
    }
    slots[name] = mine;
    // A new owner is stored per doc as it is rewritten, so every doc is rechecked.
    const schemaChanged = !same(old.schema, c.schema) || ownerAdded;
    if (moved) reindexed.push(name);
    if (schemaChanged) rechecked.push(name);
    const call = calls.get(name);
    if (call) work.push({ collection: name, mode: "migrate", call });
    else if (moved || schemaChanged) work.push({ collection: name, mode: "rewrite", ...(ownerAdded ? { owner: true } : {}) });
  }
  // A removed collection folds into the kept ones after they are migrated, so its patches land on their new shape.
  const removed = Object.keys(from.collections).filter((name) => !to.collections[name]);
  for (const name of removed) if (calls.has(name)) work.push({ collection: name, mode: "migrate", call: calls.get(name)! });
  const dropped = removed.filter((name) => !calls.has(name));
  for (const name of dropped) work.push({ collection: name, mode: "drop" });
  // A Canon object a report reads (`reads.records`) reads as "reports on companies"; `*` already granted covers every one.
  const readNames = (reads: ModuleManifest["reads"]) => Object.entries(reads ?? {}).flatMap(([o, fs]) => (fs ?? []).map((f) => (o === "records" ? `reports on ${f === "*" ? "every record type" : f}` : `${o}.${f}`)));
  const granted = new Set(readNames(from.reads));
  if (from.reads?.records?.includes("*")) for (const f of to.reads?.records ?? []) granted.add(`reports on ${f}`);
  // A write it newly proposes to Canon's records needs approving as a new read does (docs/modules.md, "Writes to Canon records").
  const proposed = new Set((from.proposes ?? []).map((o) => `proposes ${o}`));
  const newReads = [
    ...readNames(to.reads).filter((r) => !granted.has(r)),
    ...(to.proposes ?? []).map((o) => `proposes ${o}`).filter((r) => !proposed.has(r)),
  ];
  // A published interface is frozen (docs/modules.md, "Reading another module"): other modules read it as it was.
  for (const [name, p] of Object.entries(from.provides ?? {})) {
    const next = to.provides?.[name];
    const oldView = from.views[p.view], newView = next ? to.views[next.view] : undefined;
    if (!next) problems.push(`it drops ${name}, which other modules may read: keep it, and ship a new version beside it`);
    else if (!same(p.people ?? null, next.people ?? null) || !same([...p.fields].sort(), [...next.fields].sort()) || !same(oldView?.args ?? {}, newView?.args ?? {})
      || oldView?.kind !== newView?.kind || oldView?.collection !== newView?.collection
      || p.fields.some((f) => {
        const before = from.collections[oldView.collection]?.schema.value[f];
        const after = newView && to.collections[newView.collection]?.schema.value[f];
        return !same(before?.fieldType, after?.fieldType) || before?.optional !== after?.optional;
      }))
      problems.push(`it changes ${name}'s fields, their types or presence, its arguments, shape or collection: ship it as a new version (${name.replace(/v(\d+)$/, (_, n) => `v${Number(n) + 1}`)}) beside it`);
  }
  const using = new Set(Object.entries(from.uses ?? {}).flatMap(([mod, names]) => names.map((n) => `uses ${mod} ${n}`)));
  newReads.push(...Object.entries(to.uses ?? {}).flatMap(([mod, names]) => names.map((n) => `uses ${mod} ${n}`)).filter((r) => !using.has(r)));
  return { slots, work, reindexed, rechecked, dropped, migrated: [...calls.keys()], newReads, problems };
}

/** Whether `version` meets every comparator of `range` (`<1.3.0`, `>=1.0.0 <1.3.0`, `1.2.0`). */
export function inRange(version: string, range: string): boolean {
  return range.split(" ").every((c) => {
    const [, op, v] = /^(<=|>=|<|>|=)?(.+)$/.exec(c)!;
    const d = compareVersions(version, v);
    return op === "<" ? d < 0 : op === "<=" ? d <= 0 : op === ">" ? d > 0 : op === ">=" ? d >= 0 : d === 0;
  });
}

/** -1, 0 or 1 as version `a` is older than, the same as or newer than `b` (plain semver, as manifests carry). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Whether an upgrade's work needs the migration and cutover path. */
export const migrates = (work: readonly UpgradeWork[]) => work.some((w) => w.mode === "migrate");

/** Owner backfills must hold writes too: the installed declaration cannot maintain the new owner. */
export const holdsWrites = (work: readonly UpgradeWork[]) => migrates(work) || work.some((w) => w.mode === "rewrite" && w.owner === true);
