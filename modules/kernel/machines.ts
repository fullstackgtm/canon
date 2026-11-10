/**
 * A module's state machines, evaluated (docs/modules.md, "State machines"): guard predicates, the values a
 * transition's `set` and effects compute, and the agent mode a transition needs once its effects count. Pure: the
 * database reads a guard's `count` needs come in as a function, so Convex mutations and tests both run it.
 */
import type { AgentMode, MachineDecl, MachineExpr, ModuleManifest, Predicate, Role, TransitionDecl } from "./manifest.ts";
import type { Scalar } from "./schema.ts";
import type { VisitorIdentity } from "./visit.ts";

/** A doc a predicate tests: the doc a transition moves, or one a count or a ref reads. */
export type Subject = { key: string; data: Record<string, unknown>; owner: string | null; parentKey?: string | null; collection?: string };
/** Who runs it: a member (their id, role and the owners `team` admits), or Canon itself as "system", which is no one. */
export type Caller = { userId: string | null; role: Role | "system"; teamOwners: readonly string[] };
export type Env = {
  visitor?: VisitorIdentity;
  shared?: { root: Subject; parent?: Subject };
  /** The doc the transition moves, before it moves: what `{ doc }` reads. */
  doc: Subject;
  args: Record<string, unknown>;
  caller: Caller | { userId: null; role: "visitor"; teamOwners: readonly string[] };
  now: number;
  /** The keys of the docs earlier effects created, by their `as`. */
  created?: Record<string, string>;
  /** How many docs `view` returns for `args` that `where` admits. */
  count(view: string, args: Record<string, Scalar>, where: Predicate | undefined): Promise<number>;
  /** The first doc `view` returns for `args`, or null. */
  first(view: string, args: Record<string, Scalar>): Promise<Subject | null>;
  /** The doc of `collection` with `key`, or null. */
  get(collection: string, key: string): Promise<Subject | null>;
  /** Whether no key of `job` under `prefix` waits or runs, and the deal feed has read the ledger to its end. */
  fresh(job: string, prefix: string[]): Promise<boolean>;
  /** Whether the doc is sealed and its collection's integrity hash, recomputed, still matches. */
  intact(subject: Subject): Promise<boolean>;
  /** The month (1 to 12) the workspace's fiscal year starts. */
  fiscalYearStartMonth(): Promise<number>;
  /** Where the person ran the transition, as Canon's web server signed it (docs/modules.md, "Evidence"). */
  evidence?: { ip?: string; userAgent?: string };
};

const scalarOf = (x: unknown): Scalar => (x === undefined ? null : typeof x === "object" && x !== null ? JSON.stringify(x) : (x as Scalar));
const DAY = 86_400_000;
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** A date (`YYYY-MM-DD`, read as UTC) as ms: its first ms, or its last with `endOfDay`; a number stays. Else null. */
export function dateToMs(v: unknown, endOfDay = false): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !DATE.test(v)) return null;
  const ms = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms + (endOfDay ? DAY - 1 : 0) : null;
}
/** A time in ms as its UTC date, `YYYY-MM-DD`; a date stays (its first ten characters). Else null. */
export function msToDate(v: unknown): string | null {
  if (typeof v === "string") return DATE.test(v) ? v.slice(0, 10) : null;
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 8.64e15 ? dateOf(v) : null;
}

/**
 * The day the fiscal year holding a date or a time (ms) starts, for a year that starts in `startMonth` (1 to 12): a
 * date, or ms with `as`. Null when the value is neither.
 */
export function fiscalYearStart(v: unknown, startMonth: number, as: "ms" | "date" = "date", years = 0): string | number | null {
  const date = msToDate(v);
  if (date === null) return null;
  const month = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
  const [y, m] = date.split("-").map(Number);
  // `years` on: the start of a later (or earlier) fiscal year, so a range reads one year as [start, start of the next).
  const start = `${(m >= month ? y : y - 1) + (Number.isInteger(years) ? years : 0)}-${String(month).padStart(2, "0")}-01`;
  return as === "ms" ? dateToMs(start) : start;
}

/**
 * A time (ms) or a date plus `days`: the base's kind unless `as` names one. Null when either isn't one, so a `set`
 * leaves its field out rather than write a wrong deadline.
 */
export function addDays(base: unknown, days: unknown, as?: "ms" | "date"): number | string | null {
  const ms = dateToMs(base);
  if (ms === null || typeof days !== "number" || !Number.isFinite(days)) return null;
  const at = ms + days * DAY;
  return (as ?? (typeof base === "string" ? "date" : "ms")) === "date" ? dateOf(at) : at;
}

/**
 * A field of a doc, `key` and `parentKey` included, as stored; a missing field reads as null. A dotted path reads into
 * nested objects (`config.rate`).
 */
function rawField(s: Subject, field: string): unknown {
  if (field === "key") return s.key;
  if (field === "parentKey") return s.parentKey ?? null;
  let at: unknown = s.data;
  for (const part of field.split(".")) at = typeof at === "object" && at !== null && !Array.isArray(at) ? (at as Record<string, unknown>)[part] : undefined;
  return at ?? null;
}
/** The rows of a list field, each as a doc a predicate tests (a list of plain values: each as `{ value }`). */
function itemsOf(s: Subject, list: string): Subject[] {
  const raw = rawField(s, list);
  if (!Array.isArray(raw)) return [];
  return raw.map((x, i) => ({ key: String(i), data: typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : { value: x }, owner: null }));
}
/** A field of a doc as one value (a list or an object as its JSON). */
export function fieldOf(s: Subject, field: string): Scalar {
  return scalarOf(rawField(s, field));
}

/**
 * The value an expression computes. Every form is a scalar but `copy`, which keeps a list or an object as stored, so
 * a `set` copies it whole.
 */
export async function valueOf(x: MachineExpr, env: Env): Promise<unknown> {
  if (x === null || typeof x !== "object") return x;
  // An argument that is a list or an object (a per-row choice) stays one, so a `set` stores it as given; a predicate
  // compares its JSON, as before.
  if ("shared" in x) {
    if (env.caller.role !== "visitor" || !env.visitor || !env.shared) throw new Error("Shared values require a declared visitor context.");
    const subject = env.shared[x.shared.from];
    if (!subject || !Object.hasOwn(subject.data, x.shared.field.split(".")[0])) return null;
    return rawField(subject, x.shared.field);
  }
  if ("visitor" in x) {
    if (env.caller.role !== "visitor" || !env.visitor) throw new Error("Visitor values require a visitor caller.");
    return env.visitor[x.visitor] ?? null;
  }
  if ("arg" in x) { const v = env.args[x.arg]; return typeof v === "object" && v !== null ? v : scalarOf(v); }
  if ("doc" in x) return fieldOf(env.doc, x.doc);
  if ("caller" in x) return x.caller === "role" ? env.caller.role : env.caller.userId;
  if ("now" in x) return x.now === "ms" ? env.now : dateOf(env.now);
  if ("increment" in x) { const n = env.doc.data[x.increment]; return (typeof n === "number" ? n : 0) + (x.by ?? 1); }
  if ("nowPlusDays" in x) { const at = env.now + x.nowPlusDays * DAY; return x.as === "date" ? dateOf(at) : at; }
  if ("copy" in x) return rawField(env.doc, x.copy);
  if ("created" in x) return env.created?.[x.created] ?? null;
  if ("toMs" in x) return dateToMs(await valueOf(x.toMs, env), x.endOfDay === true);
  if ("toDate" in x) return msToDate(await valueOf(x.toDate, env));
  if ("addDays" in x) return addDays(await valueOf(x.addDays, env), await valueOf(x.days, env), x.as);
  if ("count" in x) {
    const args = Object.fromEntries(await Promise.all(Object.entries(x.count.args ?? {}).map(async ([k, a]) => [k, scalarOf(await valueOf(a, env))])));
    return env.count(x.count.view, args, undefined);
  }
  if ("subtract" in x) {
    const [a, b] = [scalarOf(await valueOf(x.subtract[0], env)), scalarOf(await valueOf(x.subtract[1], env))];
    return typeof a === "number" && typeof b === "number" && Number.isFinite(a - b) ? a - b : null;
  }
  if ("workspace" in x) return env.fiscalYearStartMonth();
  if ("fiscalYearStart" in x) return fiscalYearStart(await valueOf(x.fiscalYearStart, env), await env.fiscalYearStartMonth(), x.as, x.years);
  if ("evidence" in x) return env.evidence?.[x.evidence] ?? null;
  const args = Object.fromEntries(await Promise.all(Object.entries(x.lookup.args ?? {}).map(async ([k, a]) => [k, scalarOf(await valueOf(a, env))])));
  const doc = await env.first(x.lookup.view, args);
  return doc ? rawField(doc, x.field) : null;
}

const ordered = (a: Scalar, b: Scalar, test: (a: number | string, b: number | string) => boolean) =>
  (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string") ? test(a, b) : false;

/** Whether `p` holds for `subject`. */
export async function holds(p: Predicate, subject: Subject, env: Env): Promise<boolean> {
  const value = async (x: MachineExpr) => scalarOf(await valueOf(x, env));
  if ("shared" in p) {
    if (env.caller.role !== "visitor" || !env.visitor || !env.shared) throw new Error("Shared predicates require a declared visitor context.");
    const projected = env.shared[p.shared.from];
    return !!projected && holds(p.where, projected, env);
  }
  if ("field" in p) {
    const v = fieldOf(subject, p.field);
    if ("in" in p) return p.in.includes(v);
    if ("eq" in p) return v === (await value(p.eq));
    if ("ne" in p) return v !== (await value(p.ne));
    if ("gte" in p) return ordered(v, await value(p.gte), (a, b) => a >= b);
    return ordered(v, await value(p.lte), (a, b) => a <= b);
  }
  if ("truthy" in p) return Boolean(await value(p.truthy));
  if ("caller" in p) {
    const owner = subject.owner, me = env.caller.userId;
    if (p.caller === "isOwner") return owner !== null && owner === me;
    if (p.caller === "isNotOwner") return owner !== me;
    return owner !== null && owner !== me && env.caller.teamOwners.includes(owner);
  }
  if ("role" in p) return (p.role as readonly string[]).includes(env.caller.role);
  if ("not" in p) return !(await holds(p.not, subject, env));
  if ("all" in p) { for (const q of p.all) if (!(await holds(q, subject, env))) return false; return true; }
  if ("any" in p) { for (const q of p.any) if (await holds(q, subject, env)) return true; return false; }
  if ("ref" in p) {
    const key = await value(p.ref.key);
    const doc = typeof key === "string" ? await env.get(p.ref.collection, key) : null;
    return doc !== null && (await holds(p.where, doc, env));
  }
  if ("every" in p) {
    for (const item of itemsOf(subject, p.every.list)) if (!(await holds(p.every.where, item, env))) return false;
    return true;
  }
  if ("items" in p) {
    let n = 0;
    for (const item of itemsOf(subject, p.items.list)) if (!p.items.where || (await holds(p.items.where, item, env))) n++;
    return (p.atLeast === undefined || n >= p.atLeast) && (p.atMost === undefined || n <= p.atMost);
  }
  if ("sum" in p) {
    // A missing or non-number value counts as 0. Sums compare to a millionth, so 33.3 + 33.3 + 33.4 is 100.
    const total = itemsOf(subject, p.sum.list).reduce((n, item) => { const x = item.data[p.sum.field ?? "value"]; return n + (typeof x === "number" && Number.isFinite(x) ? x : 0); }, 0);
    const near = (b: Scalar) => typeof b === "number" && Math.abs(total - b) < 1e-6;
    if ("eq" in p) return near(await value(p.eq));
    if ("ne" in p) return !near(await value(p.ne));
    if ("gte" in p) { const b = await value(p.gte); return typeof b === "number" && (total >= b || near(b)); }
    const b = await value(p.lte);
    return typeof b === "number" && (total <= b || near(b));
  }
  if ("length" in p) {
    const v = rawField(subject, p.length);
    const n = typeof v === "string" ? v.length : 0;
    return (p.atLeast === undefined || n >= p.atLeast) && (p.atMost === undefined || n <= p.atMost);
  }
  if ("ordered" in p) {
    const vs = itemsOf(subject, p.ordered.list).map((r) => fieldOf(r, p.ordered.field));
    return vs.every((v, i) => v !== null && (i === 0 || ordered(vs[i - 1], v, (a, b) => (p.ordered.strict ? a < b : a <= b))));
  }
  if ("disjoint" in p) {
    // Each row a range, from its `from` to its `to` (none: it runs on); sorted by `from`, each ends where the next begins.
    const rs = itemsOf(subject, p.disjoint.list).map((r) => [fieldOf(r, p.disjoint.from), fieldOf(r, p.disjoint.to)] as const);
    if (rs.some(([a]) => a === null)) return false;
    const sorted = [...rs].sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
    return sorted.every(([, to], i) => i === sorted.length - 1 || (to !== null && ordered(to, sorted[i + 1][0], (a, b) => a <= b)));
  }
  if ("unique" in p) {
    const vs = itemsOf(subject, p.unique.list).map((r) => fieldOf(r, p.unique.field)).filter((v) => v !== null);
    return new Set(vs).size === vs.length;
  }
  if ("intact" in p) return env.intact(subject);
  if ("fresh" in p) {
    const parts = await Promise.all(p.fresh.keyPrefix.map(value));
    // A prefix part that computes nothing names no key: nothing under it can be current.
    if (parts.some((x) => x === null)) return false;
    return env.fresh(p.fresh.job, parts.map(String));
  }
  const args = Object.fromEntries(await Promise.all(Object.entries(p.count.args ?? {}).map(async ([k, x]) => [k, await value(x)])));
  const n = await env.count(p.count.view, args, p.count.where);
  return (p.atLeast === undefined || n >= p.atLeast) && (p.atMost === undefined || n <= p.atMost);
}

/** A dirty spec's key on a doc: its parts computed and joined by "|", or null when a part computes nothing. */
export async function dirtyKey(key: readonly MachineExpr[], env: Env): Promise<string | null> {
  const parts: string[] = [];
  for (const x of key) {
    const v = scalarOf(await valueOf(x, env));
    if (v === null || v === "") return null;
    parts.push(String(v));
  }
  return parts.join("|");
}

/** Whether `p` names a transition argument anywhere: such a guard can't be judged before the caller fills them in. */
export function namesArgs(p: Predicate): boolean {
  return JSON.stringify(p).includes('{"arg":');
}

/** Whether a predicate reads an argument other than `given`: one a dialog asks for, which only its submit judges. */
export function namesArgsBeyond(p: Predicate, given: readonly string[]): boolean {
  for (const [, name] of JSON.stringify(p).matchAll(/\{"arg":"([^"]*)"/g)) if (!given.includes(name)) return true;
  return false;
}

/**
 * Whether a predicate reads one of `fields`, fields a form asks for: a value of the doc's (`{ "doc": f }`), a field it
 * tests, a text's length or a list's rows. Over-approximate on purpose: a related doc's field of the same name counts
 * too. A form-opening action is judged without such a guard, which the server checks on submit with the values given.
 */
export function namesFields(p: Predicate, fields: readonly string[]): boolean {
  if (!fields.length) return false;
  const asked = new Set(fields);
  const walk = (x: unknown): boolean => {
    if (Array.isArray(x)) return x.some(walk);
    if (!x || typeof x !== "object") return false;
    for (const [k, v] of Object.entries(x)) {
      if ((k === "doc" || k === "field" || k === "length" || k === "list") && typeof v === "string" && asked.has(v.split(".")[0])) return true;
      if (walk(v)) return true;
    }
    return false;
  };
  return walk(p);
}

/**
 * The state a transition moves a doc to: its `to`; the state a field saved, else the fallback; the first case whose
 * `when` holds on the doc; or, without a `to`, the state it is in.
 */
export async function targetState(m: MachineDecl, t: TransitionDecl, subject: Subject, env: Env): Promise<string> {
  const to = t.to;
  if (to === undefined) return String(subject.data[m.field] ?? m.initial);
  if (typeof to === "string") return to;
  if ("restore" in to) {
    const saved = subject.data[to.restore];
    return typeof saved === "string" && m.states.includes(saved) ? saved : to.fallback;
  }
  for (const c of to.cases) if (await holds(c.when, subject, env)) return c.to;
  return to.else;
}

const STRICTNESS: Record<AgentMode, number> = { allowed: 0, propose: 1, human: 2 };

/**
 * The agent mode a transition needs, its effects' transitions included: an agent can't reach through an effect what
 * it couldn't run itself. With the reason of the `human` transition that decides it.
 */
export function agentModeOf(m: ModuleManifest, machine: string, name: string): { mode: AgentMode; reason?: string; label: string } {
  let out: { mode: AgentMode; reason?: string; label: string } = { mode: "allowed", label: "" };
  const seen = new Set<string>();
  const walk = (mn: string, tn: string) => {
    const id = `${mn}.${tn}`;
    const t = m.machines?.[mn]?.transitions[tn];
    if (!t || seen.has(id)) return;
    seen.add(id);
    if (STRICTNESS[t.agent] > STRICTNESS[out.mode]) out = { mode: t.agent, reason: t.reason, label: t.label };
    for (const fx of t.effects ?? []) if ("machine" in fx) walk(fx.machine, fx.transition);
  };
  walk(machine, name);
  return out;
}
