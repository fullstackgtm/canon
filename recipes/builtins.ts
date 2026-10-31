/**
 * Canon's built-in play logic (docs/recipes.md, "Writing a recipe"), for a recipe written in markdown alone. A recipe
 * names one in a ```logic block (`keeper: rule canon.keeper`) and configures it with its settings, and for draft
 * checks and the fan-out order with a markdown table. Each reads fixed setting keys, which the recipe must declare.
 * Pure, like any recipe code: a built-in runs in the recipe runtime's isolate, or in-process for a first-party recipe.
 */
import { DEAL_ROLES, type DealRole } from "../convex/lib/objects/registry.ts";
import { ROLE_LABEL } from "../convex/lib/committee.ts";
import type { DraftCheck, IcpPov, PointOfView } from "../convex/lib/plays/drafts.ts";
import {
  CHANNEL_LABEL, PLAY_CHANNELS, daysUntil, type Channel, type DealStage, type Flag, type KeeperInput, type KeeperReport, type Prep, type PrepCheck,
  type PrepInput, type Prospect, type Severity, type Stall,
} from "../convex/lib/plays/model.ts";
import type { AnyDescriptor, StageInput } from "./kernel.ts";
import type { Draft, Kind } from "./sdk.ts";

const DAY = 86_400_000;
const ago = (now: number, at: number) => {
  const d = Math.floor((now - at) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const otherChannel = (c: Channel | null): Channel => (c === "linkedin" ? "email" : c === "email" ? "call" : "linkedin");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** No champion inside the window is urgent; quiet threads propose the other channel; stale research asks again. */
export function keeperReport(input: KeeperInput, s: { coreRoles: readonly DealRole[]; windowUrgentDays: number; staleResearchDays: number }): KeeperReport {
  const { now, members } = input;
  const flags: Flag[] = [];
  const windowDays = input.windowClosesOn ? daysUntil(input.windowClosesOn, now) : null;
  const windowName = input.windowLabel || "The decision window";
  const holder = (role: DealRole) => members.find((m) => m.role === role);
  const planned = input.steps.filter((step) => step.state === "planned" && !step.doneByTouch);

  if (!input.hasCompany) flags.push({ key: "company", severity: "high", text: "Link this deal to a company so Canon can map its people." });
  if (windowDays !== null && !Number.isNaN(windowDays) && windowDays < 0) {
    flags.push({ key: "window", severity: "high", text: `${windowName} closed ${-windowDays} days ago. Move the window or close the deal.` });
  }
  for (const role of s.coreRoles) {
    if (holder(role)) continue;
    const urgent = role === "champion" && windowDays !== null && windowDays >= 0 && windowDays <= s.windowUrgentDays;
    const text = role === "champion"
      ? urgent ? `No champion, and ${windowName.toLowerCase()} closes in ${windowDays} days.` : "No champion yet. Whoever replies first is the candidate."
      : `No ${ROLE_LABEL[role]} on the deal. Map one before reaching out.`;
    flags.push({ key: `role:${role}`, severity: urgent ? "high" : "medium", text });
  }
  for (const m of members) {
    const { thread } = m;
    const role = m.role === "involved" ? "" : ` (${ROLE_LABEL[m.role]})`;
    if (thread.state === "replied" && thread.lastIn !== null) {
      flags.push({ key: `replied:${m.contactId}`, severity: "high", contactId: m.contactId, text: `${m.name}${role} replied ${ago(now, thread.lastIn)}. The next move is yours.`,
        propose: { title: `Follow up with ${m.name}`, channel: thread.lastChannel ?? "email", contactId: m.contactId } });
    } else if (thread.state === "untouched" && s.coreRoles.includes(m.role)) {
      flags.push({ key: `untouched:${m.contactId}`, severity: "medium", contactId: m.contactId, text: `${m.name}${role} hasn't been contacted.`,
        propose: { title: `First touch: ${m.name}`, channel: "linkedin", contactId: m.contactId } });
    } else if (thread.state === "quiet") {
      const last = Math.max(thread.lastOut ?? 0, thread.lastIn ?? 0);
      flags.push({ key: `quiet:${m.contactId}`, severity: s.coreRoles.includes(m.role) ? "medium" : "low", contactId: m.contactId,
        text: `${m.name}${role} has gone quiet: last touch ${ago(now, last)}.`,
        propose: { title: `Try ${CHANNEL_LABEL[otherChannel(thread.lastChannel)].toLowerCase()} with ${m.name}`, channel: otherChannel(thread.lastChannel), contactId: m.contactId } });
    }
  }
  const live = members.filter((m) => m.thread.state === "engaged" || m.thread.state === "replied").length;
  if (members.length >= 2 && live <= 1 && members.some((m) => m.thread.touches > 0)) {
    flags.push({ key: "threads", severity: "medium", text: live === 0 ? "No one on the committee is engaged yet." : "Single-threaded: one person is engaged. Open a second thread." });
  }
  const d = today(now);
  for (const step of planned) {
    if (step.dueOn && step.dueOn < d) flags.push({ key: `overdue:${step.id}`, severity: "medium", stepId: step.id, text: `"${step.title}" was due ${step.dueOn}.` });
  }
  if (input.steps.length === 0) flags.push({ key: "plan", severity: "medium", text: "No outreach plan yet. Add steps, or run research to draft one." });
  else if (planned.length === 0 && windowDays !== null && windowDays >= 0) flags.push({ key: "plan-empty", severity: "medium", text: "Every step is done. Plan the next touches." });
  if (!input.hasBrief && input.researchedAt === null) flags.push({ key: "research", severity: "low", text: "No research yet. Run Research, or have your agent write the brief over /mcp." });
  else if (input.researchedAt !== null && now - input.researchedAt > s.staleResearchDays * DAY) {
    flags.push({ key: "research-stale", severity: "low", text: `Research is ${Math.floor((now - input.researchedAt) / DAY)} days old. Run it again.` });
  }
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  const highs = flags.filter((f) => f.severity === "high").length;
  const mediums = flags.filter((f) => f.severity === "medium").length;
  return { health: highs ? "at_risk" : mediums > 1 ? "needs_attention" : "on_track", flags, windowDays: windowDays !== null && !Number.isNaN(windowDays) ? windowDays : null };
}

/** Four checks before a deal moves, the reason it's slow, and the questions those gaps raise. */
export function prepReport(input: PrepInput, s: { nextCallDays: number; politeDays: number; maxPrepQuestions: number }): Prep {
  const { now, members } = input;
  const first = (n: string) => n.split(" ")[0];
  const touched = (m: PrepInput["members"][number]) => m.thread.touches > 0;
  const exec = members.find((m) => m.role === "executive") ?? null;
  const signer = members.find((m) => m.role === "signer") ?? null;
  const live = members.filter((m) => m.thread.state === "engaged" || m.thread.state === "replied");
  const d = today(now);
  const horizon = new Date(now + s.nextCallDays * DAY).toISOString().slice(0, 10);
  const nextCall = input.steps.find((step) => step.state === "planned" && !step.doneByTouch && (step.channel === "call" || step.channel === "meeting") && step.dueOn !== null && step.dueOn >= d && step.dueOn <= horizon);
  const checks: PrepCheck[] = [
    { key: "exec", label: "The executive has heard from us", ok: Boolean(exec && touched(exec)),
      evidence: !exec ? "No executive is on the deal." : touched(exec) ? `${exec.name} has been contacted.` : `${exec.name} has never been contacted.` },
    { key: "second", label: "More than one person is engaged", ok: live.length >= 2,
      evidence: live.length >= 2 ? `${live.map((m) => first(m.name)).join(", ")} are engaged.` : live.length === 1 ? `Only ${live[0].name} is engaged.` : "Nobody has engaged yet." },
    { key: "next", label: "The next call is booked", ok: Boolean(nextCall),
      evidence: nextCall ? `A ${nextCall.channel} is planned for ${nextCall.dueOn}.` : `No call or meeting is planned in the next ${s.nextCallDays} days.` },
    { key: "signer", label: "We know who signs", ok: Boolean(signer), evidence: signer ? `${signer.name} signs.` : "Nobody is named as the signer." },
  ];
  const lastReply = Math.max(0, ...members.map((m) => m.thread.lastIn ?? 0));
  const worked = members.filter(touched);
  const lead = worked.find((m) => m.role === "champion") ?? worked.find((m) => m.role !== "executive") ?? null;
  let stall: Stall | null = null;
  if (lead && !(exec && touched(exec))) {
    stall = { kind: "selling_up", text: `${lead.name} is carrying this alone, and ${exec ? `${exec.name} hasn't heard from us` : "no executive is on the deal"}.` };
  } else if (worked.length && !nextCall && (lastReply === 0 || now - lastReply > s.politeDays * DAY)) {
    stall = { kind: "polite", text: lastReply ? `Nobody has replied in ${Math.floor((now - lastReply) / DAY)} days, and no call is booked.` : "Nobody has replied yet, and no call is booked." };
  } else if (!input.hasWhyNow && input.windowDays === null) {
    stall = { kind: "unframed", text: "Nothing on the deal says why they should act now: no why-now and no decision date." };
  }
  const window = input.windowDays !== null && input.windowDays >= 0 ? ` ${input.windowLabel || "The decision window"} closes in ${input.windowDays} days.` : "";
  const missing = checks.filter((c) => !c.ok).length;
  const verdict = stall ? `${stall.text}${window}`
    : missing ? `${missing} of ${checks.length} things this deal needs to move are missing.${window}`
    : `On track: the executive is in, more than one person is engaged, the next call is booked and the signer is known.${window}`;
  const company = input.company ?? "the account";
  const questions: string[] = [];
  if (!checks[0].ok) questions.push(exec ? `What has ${exec.name} said publicly about their priorities this year?` : `Who at ${company} owns the budget for this, and what have they said publicly about it?`);
  questions.push(`Is the problem behind "${input.dealName}" measured or managed at ${company} today, and how have they tried to solve it: a hire, a tool, or nothing yet?`);
  if (!checks[3].ok) questions.push(`Who signs a purchase of this size at ${company}, and what does their buying process require?`);
  if (stall && stall.kind !== "selling_up") questions.push(`What changed at ${company} recently that makes this urgent?`);
  return { verdict, checks, stall, questions: questions.slice(0, s.maxPrepQuestions) };
}

/** `in` until someone at the account replies, whatever the probability; then `close` from closeProbability, else `case`. */
export function stageOf(input: StageInput, s: { closeProbability: number }): DealStage {
  if (!input.members.some((m) => m.thread.lastIn !== null)) return "in";
  return (input.probability ?? 0) >= s.closeProbability ? "close" : "case";
}

/** Of the ICPs the account is in, the default one, else the oldest. One ICP, never a blend. */
export function pickPointOfView(icpIds: readonly string[], icps: readonly IcpPov[]): PointOfView | null {
  const inside = icps.filter((i) => icpIds.includes(i.id)).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
  const icp = inside[0];
  return icp ? { icpId: icp.id, icpName: icp.name, text: icp.pointOfView?.trim() || null, offer: icp.offer?.trim() || null } : null;
}

/** The seller's product for the capability prompt: the deal's context, the point of view and its offer. */
export function productContext(brief: { context: string | null }, pointOfView: Pick<PointOfView, "icpName" | "text" | "offer"> | null): string | null {
  const parts = [
    brief.context,
    pointOfView?.text ? `Point of view for ${pointOfView.icpName}: ${pointOfView.text}` : null,
    pointOfView?.offer ? `What a first touch may offer: ${pointOfView.offer}` : null,
  ].filter((x): x is string => Boolean(x && x.trim()));
  return parts.length ? parts.join("\n") : null;
}

const CAPABILITY_MAX = 400;

/** The model's capability for each person asked about, one line of at most 400 characters, or null. */
export function cleanCapabilities(raw: unknown, contactIds: readonly string[]): Map<string, string | null> {
  const asked = new Set(contactIds);
  const out = new Map<string, string | null>();
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { people?: unknown }).people) ? (raw as { people: unknown[] }).people : [];
  for (const row of rows) {
    const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    if (typeof r.contactId !== "string" || !asked.has(r.contactId)) continue;
    const text = typeof r.capability === "string" ? r.capability.replace(/\s+/g, " ").trim() : "";
    out.set(r.contactId, text ? (text.length > CAPABILITY_MAX ? `${text.slice(0, CAPABILITY_MAX - 1).trimEnd()}…` : text) : null);
  }
  return out;
}

// ───────────────────────────── Fan-out by a weights table ─────────────────────────────

/** One row of the weights table: who it scores, by how much, and whether they're suggested only when nobody else can be. */
export type Weight = { who: string; weight: number; last: boolean };
export const WHO = ["buyer", "researched", "from research", "from the deal", "from the company", ...DEAL_ROLES] as const;
const matches = (who: string, p: Omit<Prospect, "suggested">) =>
  who === "buyer" ? p.buyer : who === "researched" ? p.researched : who.startsWith("from ") ? p.source === { "from research": "research", "from the deal": "deal", "from the company": "company" }[who] : p.role === who;

/** Everyone ranked by their summed weights, then by name; the first untouched people in Canon are suggested. */
export const fanOutBy = (weights: readonly Weight[]) => (rows: ReadonlyArray<Omit<Prospect, "suggested">>, s: { suggestedFirstTouches: number }): Prospect[] => {
  const score = (p: Omit<Prospect, "suggested">) => weights.reduce((n, w) => n + (matches(w.who, p) ? w.weight : 0), 0);
  const ranked = [...rows].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  const pickable = ranked.filter((p) => p.contactId && !p.reached);
  const others = pickable.filter((p) => !weights.some((w) => w.last && matches(w.who, p)));
  const picks = new Set((others.length ? others : pickable).slice(0, s.suggestedFirstTouches).map((p) => p.key));
  return ranked.map((p) => ({ ...p, suggested: picks.has(p.key) }));
};

// ───────────────────────────── Draft checks by a table ─────────────────────────────

type Arg = { setting: string } | number | "body";
/** One row of the draft checks table: a check line, the channels it runs on and its rule with that rule's arguments. */
export type CheckRow = { key: string; label: string; channels: readonly Channel[]; rule: keyof typeof RULES; args: readonly Arg[] };
type Line = { ok: boolean; note?: string } | null;
type Rule = { args: ReadonlyArray<"int" | "phrases" | "body?">; run(d: Draft, args: ReadonlyArray<number | RegExp | boolean>): Line };

/** An email's body without its greeting line and sign-off, the part a reader has to get through. */
function emailCore(body: string, greeting: RegExp): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && (greeting.test(lines[0]) || (/,$/.test(lines[0]) && words(lines[0]) <= 4))) lines.shift();
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last && words(last) <= 4 && !/[?.]$/.test(last)) lines.pop();
  return lines.join(" ");
}
const sentencesOf = (body: string) => body.split(/(?<=[.?!])\s+|\n+/);
const quoted = (m: RegExpExecArray | null) => (m ? `“${m[0]}”` : undefined);

/** The rules a check row can name, each with the arguments it takes: a setting or a number, a phrases setting, `body`. */
export const RULES = {
  /** Over `sentences` sentences or `words` words between the greeting (`greeting`) and the sign-off. */
  length: { args: ["int", "int", "phrases"], run: (d, [maxS, maxW, greeting]) => {
    const core = emailCore(d.body, greeting as RegExp);
    const sentences = core.split(/(?<=[.?!])\s+/).filter((x) => words(x) > 1).length;
    const n = words(core);
    return { ok: sentences <= (maxS as number) && n <= (maxW as number), note: `${sentences} sentence${sentences === 1 ? "" : "s"}, ${n} words` };
  } },
  /** No subject, or one over `words` words. */
  subject: { args: ["int"], run: (d, [max]) => {
    const sw = words(d.subject ?? "");
    return { ok: sw > 0 && sw <= (max as number), note: sw ? `${sw} words` : "missing" };
  } },
  /** Over `max` characters. */
  characters: { args: ["int"], run: (d, [max]) => ({ ok: d.body.length <= (max as number), note: `${d.body.length} of ${max} characters` }) },
  /** More than `max` question marks. */
  questions: { args: ["int"], run: (d, [max]) => {
    const n = (d.body.match(/\?/g) ?? []).length;
    return { ok: n <= (max as number), note: n > (max as number) ? `${n} questions` : undefined };
  } },
  /** A phrase in the subject or the body, or with `body` in the body alone. */
  avoid: { args: ["phrases", "body?"], run: (d, [re, bodyOnly]) => {
    const m = (re as RegExp).exec(bodyOnly ? d.body : `${d.subject ?? ""} ${d.body}`);
    return { ok: !m, note: quoted(m) };
  } },
  /** A phrase in the body, or a sentence over `words` words. */
  plain: { args: ["phrases", "int"], run: (d, [re, max]) => {
    const longest = Math.max(0, ...sentencesOf(d.body).map(words));
    const stiff = (re as RegExp).exec(d.body);
    return { ok: !stiff && longest <= (max as number), note: stiff ? quoted(stiff) : longest > (max as number) ? `a ${longest}-word sentence` : undefined };
  } },
  /** The last question runs over `words` words. No line when there is no question. */
  lastQuestion: { args: ["int"], run: (d, [max]) => {
    const ask = sentencesOf(d.body).filter((x) => x.trim().endsWith("?")).pop();
    return ask ? { ok: words(ask) <= (max as number), note: words(ask) > (max as number) ? `${words(ask)} words` : undefined } : null;
  } },
  /** No phrase in the body. The line has no note. */
  include: { args: ["phrases"], run: (d, [re]) => ({ ok: (re as RegExp).test(d.body) }) },
} satisfies Record<string, Rule>;

const patterns = new Map<string, RegExp>();
const pattern = (source: string) => {
  let re = patterns.get(source);
  if (!re) { re = new RegExp(source, "i"); patterns.set(source, re); if (patterns.size > 200) patterns.delete(patterns.keys().next().value!); }
  return re;
};

/** The check lines for a draft, row by row on the rows' channels. */
export const draftChecksBy = (rows: readonly CheckRow[]) => (d: Draft, s: Readonly<Record<string, unknown>>): DraftCheck[] => rows.flatMap((row) => {
  if (!row.channels.includes(d.channel)) return [];
  const rule = RULES[row.rule] as Rule;
  const args = row.args.map((a, i) => a === "body" ? true : typeof a === "number" ? a : rule.args[i] === "phrases" ? pattern(String(s[a.setting])) : Number(s[a.setting]));
  const line = rule.run(d, args);
  if (!line) return [];
  return [row.rule === "include" ? { key: row.key, label: row.label, ok: line.ok } : { key: row.key, label: row.label, ok: line.ok, note: line.note }];
});

// ───────────────────────────── The registry ─────────────────────────────

export type SettingKind = AnyDescriptor["kind"];
type Problem = (message: string, line?: number) => void;
/** A markdown table's rows by column, each with its line. */
export type TableRows = ReadonlyArray<{ line: number; cells: Readonly<Record<string, string>> }>;

export type Builtin = {
  kind: Kind;
  /** The one play it runs. */
  play: string;
  /** The settings it reads, by key, and the kinds each may be. */
  settings: Readonly<Record<string, readonly SettingKind[]>>;
  /** The columns of the table that configures it, when one does. */
  table?: readonly string[];
  /** Its configuration from that table, checked against the recipe's settings; problems go to `problem`. */
  configure?(rows: TableRows, schema: ReadonlyMap<string, AnyDescriptor>, problem: Problem): unknown;
  /** One line for the install screen and the docs. */
  about: string;
  make(config: unknown): (...args: never[]) => unknown;
};

const CHANNELS: readonly Channel[] = PLAY_CHANNELS;

/** `all`, `all except call`, or a list like `email, linkedin`. */
function channelsOf(text: string, problem: Problem, line: number): Channel[] {
  const t = text.trim().toLowerCase();
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const names = t === "all" ? [...CHANNELS] : t.startsWith("all except ") ? list(t.slice(11)) : list(t);
  const bad = names.filter((c) => !(CHANNELS as readonly string[]).includes(c));
  if (bad.length || !names.length) { problem(`channels "${text}" must be all, all except <channels>, or a list of ${CHANNELS.join(", ")}`, line); return []; }
  return t.startsWith("all except ") ? CHANNELS.filter((c) => !names.includes(c)) : (names as Channel[]);
}

const CHECK_KEY = /^[a-z][a-z0-9-]{0,39}$/;

function configureChecks(rows: TableRows, schema: ReadonlyMap<string, AnyDescriptor>, problem: Problem): CheckRow[] {
  return rows.flatMap(({ line, cells }): CheckRow[] => {
    const m = /^`?\s*([a-zA-Z]+)\(([^)]*)\)\s*`?$/.exec(cells.rule ?? "");
    const at = (message: string) => { problem(message, line); return []; };
    if (!CHECK_KEY.test(cells.key ?? "")) return at(`key "${cells.key ?? ""}" must be a-z, 0-9 and -`);
    if (!cells.check) return at(`check ${cells.key} needs a label`);
    if (!m || !Object.hasOwn(RULES, m[1])) return at(`rule "${cells.rule ?? ""}" must be one of ${Object.keys(RULES).map((r) => `${r}(…)`).join(", ")}`);
    const rule = RULES[m[1] as keyof typeof RULES] as Rule;
    const given = m[2].split(",").map((x) => x.trim()).filter(Boolean);
    const required = rule.args.filter((a) => a !== "body?").length;
    if (given.length < required || given.length > rule.args.length) return at(`${m[1]} takes ${required === rule.args.length ? required : `${required} or ${rule.args.length}`} argument${rule.args.length === 1 ? "" : "s"}, not ${given.length}`);
    const args: Arg[] = [];
    for (const [i, g] of given.entries()) {
      const want = rule.args[i];
      if (want === "body?") { if (g !== "body") return at(`${m[1]}'s last argument is body, not ${g}`); args.push("body"); continue; }
      if (want === "int" && /^\d+$/.test(g)) { args.push(Number(g)); continue; }
      const d = schema.get(g);
      if (!d) return at(`${m[1]}(${given.join(", ")}): ${g} is not a setting`);
      const kinds: readonly SettingKind[] = want === "int" ? ["int"] : ["phrases"];
      if (!kinds.includes(d.kind)) return at(`${m[1]}(${given.join(", ")}): ${g} must be a ${kinds.join(" or ")} setting, and it is ${d.kind}`);
      args.push({ setting: g });
    }
    const channels = channelsOf(cells.channels ?? "", problem, line);
    return channels.length ? [{ key: cells.key, label: cells.check, channels, rule: m[1] as keyof typeof RULES, args }] : [];
  });
}

function configureWeights(rows: TableRows, _schema: ReadonlyMap<string, AnyDescriptor>, problem: Problem): Weight[] {
  return rows.flatMap(({ line, cells }): Weight[] => {
    const who = (cells.who ?? "").trim().toLowerCase();
    const weight = Number(cells.weight);
    const suggest = (cells.suggest ?? "").trim().toLowerCase();
    if (!(WHO as readonly string[]).includes(who)) { problem(`who "${cells.who ?? ""}" must be one of ${WHO.join(", ")}`, line); return []; }
    if (!/^-?\d+(\.\d+)?$/.test((cells.weight ?? "").trim())) { problem(`weight "${cells.weight ?? ""}" must be a number`, line); return []; }
    if (suggest && suggest !== "last") { problem(`suggest "${cells.suggest}" is empty or last`, line); return []; }
    if (suggest === "last" && !(DEAL_ROLES as readonly string[]).includes(who) && who !== "buyer") { problem("only a role or buyer can be suggested last", line); return []; }
    return [{ who, weight, last: suggest === "last" }];
  });
}

/** Every built-in, by the name a ```logic block gives it. */
export const BUILTINS: Readonly<Record<string, Builtin>> = {
  "canon.stage": {
    kind: "viewModel", play: "stage", settings: { closeProbability: ["number"] },
    about: "Find the way in until someone replies, then build the case, then close from closeProbability.",
    make: () => stageOf as never,
  },
  "canon.keeper": {
    kind: "rule", play: "keeper", settings: { coreRoles: ["roles"], windowUrgentDays: ["int"], staleResearchDays: ["int"] },
    about: "Flags missing core roles, replies owed, untouched and quiet threads, overdue steps, the window and stale research.",
    make: () => keeperReport as never,
  },
  "canon.prep": {
    kind: "viewModel", play: "prep", settings: { nextCallDays: ["int"], politeDays: ["int"], maxPrepQuestions: ["int"] },
    about: "Four checks before a deal moves (executive, a second person, the next call, the signer), why it's slow, and research questions.",
    make: () => prepReport as never,
  },
  "canon.fanOut": {
    kind: "viewModel", play: "fanOut", settings: { suggestedFirstTouches: ["int"] }, table: ["who", "weight", "suggest"],
    about: "Ranks who to reach first by a weights table and suggests the first untouched people.",
    configure: configureWeights,
    make: (weights) => fanOutBy(weights as Weight[]) as never,
  },
  "canon.draftChecks": {
    kind: "check", play: "drafts.check", settings: {}, table: ["check", "key", "channels", "rule"],
    about: "Checks a draft by a table of rules: length, subject, characters, questions, phrases to avoid or include.",
    configure: configureChecks,
    make: (rows) => draftChecksBy(rows as CheckRow[]) as never,
  },
  "canon.pointOfView": {
    kind: "viewModel", play: "pointOfView", settings: {},
    about: "The point of view of the account's default ICP, else its oldest.",
    make: () => pickPointOfView as never,
  },
  "canon.productContext": {
    kind: "viewModel", play: "people.productContext", settings: {},
    about: "The deal's context, the ICP's point of view and its offer, for the capability prompt.",
    make: () => productContext as never,
  },
  "canon.capabilities": {
    kind: "parse", play: "people.capability.clean", settings: {},
    about: "Keeps one capability line per person asked about, at most 400 characters.",
    make: () => cleanCapabilities as never,
  },
};

