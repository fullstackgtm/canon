/**
 * A module's server code, as Canon sees it (docs/modules.md, "Server code"): what a call receives, the writes it
 * returns, and the checks on their shape before Convex applies them. The code itself runs only in the recipe
 * runtime (services/recipe-runtime, POST /module). Pure, with no Node-only imports: the action, the runtime's tests
 * and module authors (for the types) all import it.
 */
import type { Predicate, Role } from "./manifest.ts";
import type { FactsForRecordsRow } from "./facts.ts";
import type { ProposalOutcome } from "./proposals.ts";

/**
 * A module doc as a read plan returns it: what a view returns. `version` is what an intent's `expect` names;
 * `createdAt` and `updatedAt` are Canon's times for the doc, in ms.
 */
export type ReadDoc = { key: string; version: number; data: Record<string, unknown>; owner: string | null; parentKey: string | null; createdAt: number; updatedAt: number };
/**
 * A read: a list view's docs, a one view's doc or null, a Canon read's records (each with its `id`), `facts.forRecords`'s
 * rows or `proposals.byIds`'s outcomes.
 */
export type ReadValue = MarketReadValue | ReadDoc[] | ReadDoc | null | Array<Record<string, unknown>> | FactsForRecordsRow[] | ProposalOutcome[] | ReportReadValue | AggregateReadValue | MissingRead | TreeReadValue | IcpTreeReadValue;
export type IcpTreeReadValue = {
  nodes: Array<{ key: string; accounts: number; people: number; market?: number | null }>;
  overlaps: Array<{ a: string; b: string; accounts: number }>;
};
export type MarketReadValue = { total: number; groups: Array<{ key: string; count: number }>; truncated: boolean };
/**
 * Another module's interface that can't be read (docs/modules.md, "Reading another module"): its module isn't
 * installed, isn't on, or doesn't provide it. Never an empty list, so a module can say which.
 */
export type MissingRead = { missing: "not_installed" | "off" | "not_provided" };
/**
 * A territory tree's value (docs/modules.md, "Territories"): per node (its doc's key) the companies under it, those in
 * an ICP, their owners and the deals' pipeline and last year's bookings when asked; sibling overlaps by rules, companies
 * in no top-level node, one node's cells, and the nodes whose query line didn't read.
 */
export type TreeReadValue = {
  nodes: Array<{ key: string; accounts: number; icp: number; market?: number | null; owners?: Array<{ ownerId: string | null; accounts: number }>; pipeline?: number; bookings12m?: number }>;
  overlaps: Array<{ a: string; b: string; accounts: number }>;
  uncovered: number;
  cells?: Array<{ key: Record<string, string>; accounts: number; owners: Array<{ ownerId: string | null; accounts: number }> }>;
  /** With cells: companies named to that node itself, which stay there (no cell holds them). */
  pinnedToCellNode?: number;
  /** With place: the territory the company lands in (null: none), and whether it is named there. */
  placed?: { company: string; node: string | null; named: boolean };
  errors: Array<{ key: string; message: string }>;
};
/**
 * A team aggregate (docs/modules.md, "Team aggregates"): the docs it counted, how many owners they belong to, and each
 * declared value in order (an average over the docs counted); or withheld, when fewer than `minOwners` own them.
 */
export type AggregateReadValue = { withheld: false; owners: number; count: number; values: Array<number | null> } | { withheld: true; minOwners: number };
/**
 * A report read's value: each group's keys (its dimensions' values: a member's or a doc's id, a date bucket's first
 * day) and values (its measures, in order), the total over every doc, how many docs it counted, and whether some
 * changes hadn't reached the record service yet.
 */
export type ReportReadValue = { groups: Array<{ keys: Array<string | number | boolean | null>; values: Array<number | null> }>; total: Array<number | null>; rows: number; behind: boolean };

/**
 * What a call function receives besides its reads. `now` is its only clock: Date and Math.random are frozen. A system
 * call (a job's) runs as Canon: `userId` and `role` are both "system".
 */
export type CallContext = {
  now: number; caller: { userId: string; role: Role | "system" }; args: Record<string, unknown>;
  /** The workspace's settings a module reads: the month (1 to 12) its fiscal year starts, and its currency. */
  workspace?: Workspace;
};
export type Workspace = { fiscalYearStartMonth: number; currency: string };

/** A doc a write was derived from, and the version it read; null means the doc must not exist. */
export type Expect = { collection: string; key: string; version: number | null };
type Guarded = { expect?: Expect[]; expectCount?: Array<{ collection: string; count: number }>; require?: Predicate };

/**
 * One write a call returns. Each checks its `expect` versions (all of them, before any write) and its `require`
 * predicate on the doc it writes (a replaceSet: on the parent). A call's writes apply all or none.
 */
export type Intent = Guarded & (
  /** Create the doc, or replace its fields (not the machine-owned ones) when `key` names one. */
  | { op: "put"; collection: string; key?: string; parentKey?: string; data: Record<string, unknown>; ifAbsent?: true }
  | { op: "patch"; collection: string; key: string; data: Record<string, unknown>; unset?: string[] }
  | { op: "delete"; collection: string; key: string; ifPresent?: true }
  /** Replace every doc of a set under `parentKey` with `docs`, at once: readers see the old set or the new one. */
  | { op: "replaceSet"; collection: string; parentKey: string; docs: Array<Record<string, unknown>> }
  /** Move a doc through a machine, as the caller: its roles, guards and agent mode all apply. */
  | { op: "transition"; machine: string; name: string; key: string; args?: Record<string, unknown>; reason?: string }
  /** Run a declared op, as the caller: its roles, guards and agent mode all apply, as if they ran it themselves. */
  | { op: "op"; name: string; key?: string; parentKey?: string; data?: Record<string, unknown>; unset?: string[] }
  /** A line on the doc's history, as "Summarized 4 visits". */
  | { op: "event"; collection: string; key: string; note: string }
  /**
   * Mark a job's key stale, so Canon runs it again (a system call only): a statement that changed dirties the same
   * rep's next period. `key` is its parts joined by "|", "*" for every value of the last ones.
   */
  | { op: "dirty"; job: string; key: string }
  /**
   * An in-app notification to members (a system call only): `to` their ids, a `message`, and a `link` to a page of the
   * module (`visits/<key>`). Members who left the workspace are skipped.
   */
  | { op: "notify"; to: string[]; message: string; link?: string; subject?: string; badge?: string; email?: boolean }
  /**
   * A message through the outbox (docs/modules.md, "Outbound"): a declared template to a Slack channel name, a webhook
   * event or members by id, its `{$vars...}` from `vars`. `key` names the send: a rerun with the same key and recipient
   * finds the row it queued and sends nothing again. People email instead names an explicit sender and a saved source
   * version; Canon reads and renders it under the causal person and mailbox owner.
   */
  | { op: "send"; template: string; key: string } & (
      | { to: { slack: string } | { webhook: string } | { members: string[] }; kind?: "notice" | "personal" | "automated"; vars?: Record<string, unknown>; from?: never; source?: never }
      | { to: { people: string[] }; from: { sender: string }; source: { collection: string; key: string; version: number }; kind?: "personal" | "automated"; vars?: never }
    )
  /**
   * Propose a write to Canon's own records (docs/modules.md, "Writes to Canon records"), one of the manifest's
   * `proposes`: Canon lists the records it would change, as the caller reads them, and holds them as a patch plan a
   * person approves. `stamp` writes the plan's id into a field of a module doc this call writes; `outcome` names a job
   * key Canon dirties when the plan is applied, rejected or fails, whose call reads it back (`proposals.byIds`).
   */
  | { op: "propose"; operation: string; args: Record<string, unknown>; reason: string; stamp?: { collection: string; key: string; field: string }; outcome?: { job: string; key: string };
    /** When nothing would change: no plan, `stamp` written as "none", and the outcome job dirtied anyway. Else such a proposal refuses the call. */
    optional?: boolean }
);
/**
 * What a call returns. A job's call returns its writes by key, `byKey`: each key's apply on its own, all or none, so
 * one key that fails leaves the others written. A key it leaves out is done with no writes.
 */
export type CallOutput = { intents?: Intent[]; byKey?: Record<string, Intent[]>; value?: unknown };
/** A deal as a watch sees it: its id, the change's time, and the watched fields before and after (null: not there). */
export type DealChange = { id: string; at: number; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
/**
 * A change a watch hands its call: a deal's, a company's (`acc_…`), a person's (`con_…`) or an activity's (its id as
 * `activities.*` read it). An activity's carries `targets`, the deals, companies and people it is about after the change,
 * so a watch can dirty by deal.
 */
export type RecordChange = DealChange & { targets?: { deals: string[]; companies: string[]; people: string[] } };
export type FeedItem = { seq: number | null; id: string; link: { userId: string | null }; at: number; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
/** What a module's server bundle exports: `export const calls = { <name>(ctx, reads) { ... } }`. */
export type CallFunctions = Record<string, (ctx: CallContext, reads: Record<string, ReadValue>) => CallOutput | Promise<CallOutput>>;

/** The most writes one call returns, and the most docs one replaceSet holds. */
export const MAX_INTENTS = 2000;
export const MAX_SET_DOCS = 20_000;
/** The most docs one write says it was derived from. */
export const MAX_EXPECTS = 5000;
const KEY = /^[A-Za-z0-9_.:|@~-]{1,200}$/;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Why `raw` isn't a call's output, as `<path> ...` lines; empty when it is one. */
export function outputProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return ["the call must return an object: { intents?, value? }"];
  const e: string[] = [];
  for (const k of Object.keys(raw)) if (k !== "intents" && k !== "value" && k !== "byKey") e.push(`${k} is not a known key`);
  if (raw.byKey !== undefined) {
    if (!isRecord(raw.byKey)) return [...e, "byKey must be an object of a job key's writes"];
    let n = 0;
    for (const [key, list] of Object.entries(raw.byKey)) {
      if (!Array.isArray(list)) { e.push(`byKey.${key} must be a list of writes`); continue; }
      n += list.length;
      list.forEach((x, i) => e.push(...intentProblems(x, `byKey.${key}[${i}]`)));
    }
    if (n > MAX_INTENTS * 10) e.push(`byKey holds ${n} writes; a job's call returns at most ${MAX_INTENTS * 10}`);
  }
  if (raw.intents === undefined) return e;
  if (!Array.isArray(raw.intents) || raw.intents.length > MAX_INTENTS) return [...e, `intents must be a list of at most ${MAX_INTENTS} writes`];
  raw.intents.forEach((x, i) => e.push(...intentProblems(x, `intents[${i}]`)));
  return e;
}

/** A job key's parts: each a value of letters, digits and _.:@~- , or "*" for every value of the last parts. */
const PART = /^(?:\*|[A-Za-z0-9_.:@~-]{1,100})$/;
/** Why `key` isn't a key of a job whose key has `parts` parts, or null. */
export function jobKeyProblem(key: string, parts: number): string | null {
  const values = key.split("|");
  if (values.length !== parts) return `${key} has ${values.length} parts, not ${parts}`;
  if (!values.every((v) => PART.test(v))) return `${key} has a part that isn't a value or "*"`;
  const first = values.indexOf("*");
  if (first >= 0 && values.slice(first).some((v) => v !== "*")) return `${key} has a value after a "*"`;
  return null;
}

function intentProblems(x: unknown, at: string): string[] {
  if (!isRecord(x)) return [`${at} must be an object`];
  const e: string[] = [];
  const text = (k: string, re?: RegExp) => { if (typeof x[k] !== "string" || !(re ?? /^[\s\S]{1,200}$/).test(x[k] as string)) e.push(`${at}.${k} must be ${re === KEY ? "a key" : "text"}`); };
  const object = (k: string) => { if (!isRecord(x[k])) e.push(`${at}.${k} must be an object`); };
  const allowed = (...keys: string[]) => { for (const k of Object.keys(x)) if (!["op", "expect", "expectCount", "require", ...keys].includes(k)) e.push(`${at}.${k} is not a key of a ${String(x.op)}`); };
  if (x.expectCount !== undefined && (!Array.isArray(x.expectCount) || x.expectCount.length > 20 || x.expectCount.some((v) => !isRecord(v) || typeof v.collection !== "string" || !Number.isInteger(v.count) || Number(v.count) < 0))) e.push(`${at}.expectCount must name capped collections and their nonnegative snapshot counts`);
  if (x.expect !== undefined) {
    if (!Array.isArray(x.expect) || x.expect.length > MAX_EXPECTS) e.push(`${at}.expect must be a list of at most ${MAX_EXPECTS} { collection, key, version }`);
    else x.expect.forEach((y, i) => {
      if (!isRecord(y) || typeof y.collection !== "string" || typeof y.key !== "string" || !(y.version === null || (typeof y.version === "number" && Number.isInteger(y.version))))
        e.push(`${at}.expect[${i}] must be { collection, key, version (a number, or null for a doc that must not exist) }`);
    });
  }
  if (x.require !== undefined && !isRecord(x.require)) e.push(`${at}.require must be a predicate`);
  switch (x.op) {
    case "put":
      allowed("collection", "key", "parentKey", "data", "ifAbsent"); text("collection"); object("data");
      if (x.ifAbsent !== undefined && x.ifAbsent !== true) e.push(`${at}.ifAbsent must be true`);
      if (x.key !== undefined) text("key", KEY);
      if (x.parentKey !== undefined) text("parentKey", KEY);
      break;
    case "patch":
      allowed("collection", "key", "data", "unset"); text("collection"); text("key", KEY); object("data");
      if (x.unset !== undefined && (!Array.isArray(x.unset) || !x.unset.every((f) => typeof f === "string"))) e.push(`${at}.unset must be a list of field names`);
      break;
    case "delete":
      allowed("collection", "key", "ifPresent"); text("collection"); text("key", KEY);
      if (x.ifPresent !== undefined && x.ifPresent !== true) e.push(`${at}.ifPresent must be true`);
      break;
    case "replaceSet":
      allowed("collection", "parentKey", "docs"); text("collection"); text("parentKey", KEY);
      if (!Array.isArray(x.docs) || x.docs.length > MAX_SET_DOCS || !x.docs.every(isRecord)) e.push(`${at}.docs must be a list of at most ${MAX_SET_DOCS} objects`);
      break;
    case "transition":
      allowed("machine", "name", "key", "args", "reason"); text("machine"); text("name"); text("key", KEY);
      if (x.args !== undefined) object("args");
      if (x.reason !== undefined) text("reason");
      break;
    case "op":
      allowed("name", "key", "parentKey", "data", "unset"); text("name");
      if (x.key !== undefined) text("key", KEY);
      if (x.parentKey !== undefined) text("parentKey", KEY);
      if (x.data !== undefined) object("data");
      if (x.unset !== undefined && (!Array.isArray(x.unset) || !x.unset.every((f) => typeof f === "string"))) e.push(`${at}.unset must be a list of field names`);
      break;
    case "event":
      allowed("collection", "key", "note"); text("collection"); text("key", KEY); text("note");
      break;
    case "dirty":
      allowed("job", "key"); text("job"); text("key", /^[A-Za-z0-9_.:@~*|-]{1,420}$/);
      break;
    case "notify":
      allowed("to", "message", "link", "subject", "badge", "email"); text("message", /^[\s\S]{1,300}$/);
      if (x.email !== undefined && typeof x.email !== "boolean") e.push(`${at}.email must be true or false`);
      if (x.subject !== undefined) text("subject", /^[\s\S]{1,120}$/);
      if (x.badge !== undefined) text("badge", /^[\s\S]{1,30}$/);
      if (!Array.isArray(x.to) || !x.to.length || x.to.length > 50 || !x.to.every((t) => typeof t === "string")) e.push(`${at}.to must be a list of 1 to 50 member ids`);
      if (x.link !== undefined) text("link", /^[a-z0-9:][a-zA-Z0-9/?=&.%_~:-]{0,199}$/);
      break;
    case "send": {
      allowed("template", "to", "kind", "vars", "key", "from", "source"); text("template"); text("key", KEY);
      const to = x.to as Record<string, unknown> | undefined;
      const name = (v: unknown) => typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,59}$/.test(v);
      const ok = isRecord(to) && Object.keys(to).length === 1 && (name(to.slack) || name(to.webhook) || (Array.isArray(to.members) && to.members.length > 0 && to.members.length <= 20 && to.members.every((m) => typeof m === "string")) || (Array.isArray(to.people) && to.people.length > 0 && to.people.length <= 20 && to.people.every((id) => typeof id === "string" && /^con_[A-Za-z0-9_-]{1,200}$/.test(id))));
      if (!ok) e.push(`${at}.to must be { slack: name }, { webhook: event }, { members: [1 to 20 member ids] } or { people: [1 to 20 canonical contact ids] }`);
      if (x.kind !== undefined && !["notice", "personal", "automated"].includes(x.kind as string)) e.push(`${at}.kind must be notice, personal or automated`);
      if (isRecord(to) && "people" in to) {
        if (!isRecord(x.from) || Object.keys(x.from).length !== 1 || typeof x.from.sender !== "string" || !x.from.sender || x.from.sender.length > 250) e.push(`${at}.from must name one explicit sender reference`);
        if (!isRecord(x.source) || Object.keys(x.source).length !== 3 || typeof x.source.collection !== "string" || !KEY.test(x.source.collection)
          || typeof x.source.key !== "string" || !KEY.test(x.source.key) || !Number.isSafeInteger(x.source.version) || (x.source.version as number) < 1) e.push(`${at}.source must name a canonical module document and positive version`);
        if (x.kind === "notice" || x.vars !== undefined) e.push(`${at}: people email accepts personal or automated kind and no vars`);
      } else if (x.from !== undefined || x.source !== undefined) e.push(`${at}: only people email accepts from and source`);
      if (x.vars !== undefined) object("vars");
      break;
    }
    case "propose":
      allowed("operation", "args", "reason", "stamp", "outcome", "optional"); text("operation"); object("args"); text("reason", /^[\s\S]{1,300}$/);
      if (x.optional !== undefined && typeof x.optional !== "boolean") e.push(`${at}.optional must be true or false`);
      if (x.stamp !== undefined && (!isRecord(x.stamp) || typeof x.stamp.collection !== "string" || typeof x.stamp.key !== "string" || !KEY.test(x.stamp.key) || typeof x.stamp.field !== "string"))
        e.push(`${at}.stamp must be { collection, key, field }`);
      if (x.outcome !== undefined && (!isRecord(x.outcome) || typeof x.outcome.job !== "string" || typeof x.outcome.key !== "string"))
        e.push(`${at}.outcome must be { job, key }`);
      break;
    default:
      e.push(`${at}.op must be one of put, patch, delete, replaceSet, transition, op, event, dirty, notify, send, propose`);
  }
  return e;
}

/**
 * `items` in chunks that each fit a Convex mutation's arguments: at most `count` items (Convex arrays hold 8,192)
 * and about `bytes` of JSON. An item bigger than `bytes` alone goes in a chunk of its own.
 */
export function chunked<T>(items: readonly T[], count: number, bytes: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], size = 0;
  for (const item of items) {
    const n = JSON.stringify(item).length;
    if (cur.length && (cur.length >= count || size + n > bytes)) { out.push(cur); cur = []; size = 0; }
    cur.push(item); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── Migrations: an upgrade's per-doc rewrite (docs/modules.md, "Upgrades and migrations") ──

/** A stored doc as its migration receives it: in the installed version's shape. */
export type MigrationDoc = { key: string; parentKey: string | null; data: Record<string, unknown> };
/** What the migration runs under: the collection, the version installed and the one installing, and the upgrade's time. */
export type MigrationContext = { collection: string; from: string; to: string; now: number };
/**
 * A change a migration makes to another doc of the module, in the new version's shape: `set` fields, `append` items
 * to list fields, or `unset` fields. It is how a collection the new version removes folds into another.
 */
export type MigrationPatch = { collection: string; key: string; set?: Record<string, unknown>; append?: Record<string, unknown[]>; unset?: string[] };
/** One doc's migration: its new data, or `drop` to delete it, and any patches to other docs. */
export type MigrationOutcome = ({ data: Record<string, unknown> } | { drop: true }) & { patches?: MigrationPatch[] };
/** A pure function from one stored doc to its outcome. It may throw: the upgrade stops on that doc, with the message. */
export type MigrationFn = (doc: MigrationDoc, ctx: MigrationContext) => MigrationOutcome;
/** One doc's result as the runtime returns it: its outcome, or why its migration threw. */
export type MigrationResult = { key: string } & (MigrationOutcome | { error: string });

/** The most patches one batch of a migration returns. */
export const MAX_MIGRATION_PATCHES = 2000;

/**
 * A migration as a call the bundle exports: Canon hands it a batch of docs (`reads.docs`) and gets one result per
 * doc back, in order. A doc whose function throws comes back with its error, so the upgrade names that doc.
 *
 *   export const calls = { migrateVisits: migration((doc) => ({ data: { ...doc.data, followUpOn: ... } })) };
 */
export function migration(fn: MigrationFn) {
  return (ctx: CallContext, reads: Record<string, ReadValue>): CallOutput => {
    const docs = (reads.docs ?? []) as unknown as MigrationDoc[];
    const at = { ...(ctx.args as Omit<MigrationContext, "now">), now: ctx.now };
    const results: MigrationResult[] = docs.map((doc) => {
      try { return { key: doc.key, ...fn(doc, at) }; } catch (e) { return { key: doc.key, error: e instanceof Error ? e.message : String(e) }; }
    });
    return { value: { results } };
  };
}

/** Why `raw` isn't a migration batch's results for `keys`, in order; empty when it is. */
export function migrationProblems(raw: unknown, keys: readonly string[]): string[] {
  const results = isRecord(raw) && isRecord(raw.value) ? raw.value.results : undefined;
  if (!Array.isArray(results)) return ["it must return { value: { results: [...] } }, one result per doc (wrap it in migration())"];
  if (results.length !== keys.length) return [`it returned ${results.length} results for ${keys.length} docs`];
  const e: string[] = [];
  let patches = 0;
  results.forEach((r, i) => {
    const at = `results[${i}]`;
    if (!isRecord(r) || r.key !== keys[i]) return void e.push(`${at} must be the result for ${keys[i]}`);
    if (typeof r.error === "string") return;
    if ((r.drop === true) === isRecord(r.data) || (r.drop !== undefined && r.drop !== true)) e.push(`${at} must have data or drop: true`);
    for (const k of Object.keys(r)) if (!["key", "data", "drop", "patches"].includes(k)) e.push(`${at}.${k} is not a known key`);
    if (r.patches === undefined) return;
    if (!Array.isArray(r.patches)) return void e.push(`${at}.patches must be a list`);
    patches += r.patches.length;
    r.patches.forEach((p, j) => {
      const pt = `${at}.patches[${j}]`;
      if (!isRecord(p) || typeof p.collection !== "string" || typeof p.key !== "string" || !KEY.test(p.key)) return void e.push(`${pt} must be { collection, key, set?, append?, unset? }`);
      for (const k of Object.keys(p)) if (!["collection", "key", "set", "append", "unset"].includes(k)) e.push(`${pt}.${k} is not a known key`);
      if (p.set !== undefined && !isRecord(p.set)) e.push(`${pt}.set must be an object`);
      if (p.append !== undefined && (!isRecord(p.append) || !Object.values(p.append).every(Array.isArray))) e.push(`${pt}.append must be an object of lists`);
      if (p.unset !== undefined && (!Array.isArray(p.unset) || !p.unset.every((f) => typeof f === "string"))) e.push(`${pt}.unset must be a list of field names`);
    });
  });
  if (patches > MAX_MIGRATION_PATCHES) e.push(`it returned ${patches} patches; a batch returns at most ${MAX_MIGRATION_PATCHES}`);
  return e;
}

/** `data` with a migration patch laid over it: `unset`, then `set`, then `append` to lists (a missing list starts empty). */
export function patched(data: Record<string, unknown>, p: MigrationPatch): Record<string, unknown> {
  const out = { ...data };
  for (const f of p.unset ?? []) delete out[f];
  Object.assign(out, p.set ?? {});
  for (const [f, items] of Object.entries(p.append ?? {})) out[f] = [...(Array.isArray(out[f]) ? (out[f] as unknown[]) : []), ...items];
  return out;
}
