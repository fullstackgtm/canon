/**
 * The model points' equivalence lever (docs/recipes.md, "Model points"). tests/fixtures/model-equivalence.json froze
 * what the forecast, customer health, lead scoring, signal heat, hygiene audit and ICP fit code returned for a set of
 * cases, before their constants became canon-base settings, and tests/fixtures/calls-equivalence.json froze the
 * call facts prompt and the call insights the same way. This runs the same cases through the code in force
 * and reports every one whose output differs. Every surface now reads its numbers from canon-base's settings: the
 * Convex cases through modelSettings on a workspace with no choices made, the pure ones through defaultModel. The
 * forecast's `model` field is new, so it is left out of the comparison; the category rows weigh by it instead.
 *
 *   node --experimental-strip-types scripts/model-check.ts            compare
 *   node --experimental-strip-types scripts/model-check.ts --capture  rewrite the fixture from the code in force
 *
 * --capture blesses whatever the code returns now, so run it only for a change meant to alter behaviour. Exits 1 when
 * any case differs.
 */
import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConvex, memoryDb } from "../tests/convexHandlers.ts";
import { heatScore, signalPoints } from "../convex/lib/signals/heat.ts";
import { growthKinds } from "../convex/lib/signals/growth.ts";
import { heatAsOf } from "../convex/lib/scoreHistory.ts";
import { auditSnapshot } from "../engine/src/audit.ts";
import { hygienePolicy, hygieneRules } from "../convex/lib/hygienePolicy.ts";
import { forecastRows } from "../src/lib/revenue.ts";
import { defaultModel } from "../recipes/index.ts";
import { generateDemoSnapshot } from "../engine/src/demo.ts";
import { sampleSnapshot } from "../engine/src/sampleData.ts";
import type { CanonicalGtmSnapshot } from "../engine/src/types.ts";
import { emptySpec, specBuyer, specGate, type IcpSpec } from "../convex/lib/icps.ts";
import { gatedFit } from "../convex/lib/icpGates.ts";
import { heuristicIcp, icpToWeights } from "../convex/lib/researchPipeline.ts";
import { specToIcp } from "../convex/lib/addRecords.ts";
import { conversationFactsPrompt, type ConversationFactsContext } from "../convex/lib/conversations/facts.ts";
import { extractCallInsights, normalizeTranscript } from "../engine/src/calls.ts";

export const FIXTURE_FILE = fileURLToPath(new URL("../tests/fixtures/model-equivalence.json", import.meta.url));
/** The calls cases, kept apart so the two fixtures change on their own. */
export const CALLS_FIXTURE_FILE = fileURLToPath(new URL("../tests/fixtures/calls-equivalence.json", import.meta.url));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const TODAY = "2026-10-14";
const ORG = "organizations:org";
const USER = { _id: "users:me", orgId: ORG, role: "admin", name: "Me" };

/** A seeded PRNG (mulberry32): the same seed gives the same cases. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class FrozenDate extends Date {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [number]));
    else super(NOW);
  }
  static now() { return NOW; }
}

const signedIn = async () => USER;
let loaded: ReturnType<typeof loadConvex> | null = null;
const modules = () => (loaded ??= loadConvex(["forecasting.ts", "customerHealth.ts", "leadScoring.ts", "callIntelligence.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: signedIn, requireUser: signedIn, requireCap: signedIn }),
  "permissions.ts": (real) => ({ ...real, unrestrictedUser: signedIn, requireUnrestricted: async () => undefined }),
}, { Date: FrozenDate }));

type Tables = Record<string, Array<Record<string, unknown>>>;
type Case = { surface: string; name: string; input: unknown; output: unknown };
const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ _creationTime, ...r }) => r);

// ───────────────────────────── Forecast ─────────────────────────────

const PERIOD = { periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const deal = (id: string, d: Record<string, unknown>) => ({ _id: `deals:${id}`, orgId: ORG, name: id, closeDate: "2026-11-15", isWon: false, isClosed: false, dealType: "new_business", ...d });
const FORECAST_DEALS = {
  won: [deal("won", { amount: 900, isWon: true, isClosed: true, forecastCategory: "closed_won", primaryRepId: "users:a" })],
  mixed: [
    deal("won", { amount: 900, isWon: true, isClosed: true, forecastCategory: "closed_won", primaryRepId: "users:a" }),
    deal("commit", { amount: 500, probability: 0.7, forecastCategory: "commit", primaryRepId: "users:a" }),
    deal("best", { amount: 400, forecastCategory: "best_case", primaryRepId: "users:b" }),
    deal("pipe", { amount: 3000, probability: 0.1, forecastCategory: "pipeline", primaryRepId: "users:b" }),
    deal("uncategorized", { amount: 250 }),
    deal("omitted", { amount: 100, probability: 0.9, forecastCategory: "omit", primaryRepId: "users:a" }),
    deal("lost", { amount: 700, isClosed: true, forecastCategory: "closed_lost", primaryRepId: "users:b" }),
    deal("later", { amount: 999, probability: 0.5, forecastCategory: "pipeline", closeDate: "2027-02-01" }),
    deal("unassigned", { amount: 300, probability: 0.9, forecastCategory: "commit" }),
    deal("openClosedWon", { amount: 200, probability: 0.2, forecastCategory: "closed_won", primaryRepId: "users:a" }),
    deal("noAmount", { probability: 0.4, forecastCategory: "best_case", primaryRepId: "users:a" }),
  ],
  pipelineHeavy: [
    deal("commit", { amount: 100, probability: 0.8, forecastCategory: "commit" }),
    deal("pipe", { amount: 201, forecastCategory: "pipeline" }),
  ],
};
const FORECAST_TARGETS = [0, 900, 899, 1000, 1125, 1500, 1501, 10_000];

function forecastTables(deals: Array<Record<string, unknown>>, target: number, period = "Q4 2026"): Tables {
  return {
    users: [{ _id: "users:a", orgId: ORG, name: "Ada" }, { _id: "users:b", orgId: ORG, name: "Bo" }],
    deals,
    quotaPlans: [{ _id: "quotaPlans:on", orgId: ORG, status: "active" }, { _id: "quotaPlans:off", orgId: ORG, status: "draft" }],
    quotaPlanTargets: [
      ...(target ? [{ _id: "quotaPlanTargets:org", orgId: ORG, quotaPlanId: "quotaPlans:on", targetAmount: target, period }] : []),
      { _id: "quotaPlanTargets:a", orgId: ORG, quotaPlanId: "quotaPlans:on", userId: "users:a", targetAmount: 0, period: "Q3 2026" },
      { _id: "quotaPlanTargets:off", orgId: ORG, quotaPlanId: "quotaPlans:off", targetAmount: 5000, period },
    ],
  };
}

const withoutModel = ({ model: _, ...current }: Record<string, unknown>) => current;

async function forecastCases(): Promise<Case[]> {
  const out: Case[] = [];
  for (const [scenario, deals] of Object.entries(FORECAST_DEALS)) {
    for (const target of FORECAST_TARGETS) {
      const tables = forecastTables(deals, target);
      const M = modules();
      const ctx = { db: memoryDb(structuredClone(tables)) };
      const current = await M["forecasting.ts"].getCurrentForecast.handler(ctx, PERIOD);
      const byRep = await M["forecasting.ts"].getForecastByRep.handler(ctx, PERIOD);
      out.push({ surface: "forecast", name: `${scenario} target ${target}`, input: { tables, args: PERIOD }, output: { current: withoutModel(current), byRep } });
    }
    const { model } = await modules()["forecasting.ts"].getCurrentForecast.handler({ db: memoryDb(structuredClone(forecastTables(deals, 0))) }, PERIOD);
    out.push({ surface: "forecast.rows", name: scenario, input: { deals }, output: forecastRows(deals as never, model.weights) });
  }
  const offPeriod = forecastTables(FORECAST_DEALS.mixed, 1200, "Q1 2027");
  const M = modules();
  const ctx = { db: memoryDb(structuredClone(offPeriod)) };
  out.push({ surface: "forecast", name: "mixed target outside the period", input: { tables: offPeriod, args: PERIOD }, output: { current: withoutModel(await M["forecasting.ts"].getCurrentForecast.handler(ctx, PERIOD)), byRep: await M["forecasting.ts"].getForecastByRep.handler(ctx, PERIOD) } });
  return out;
}

// ───────────────────────────── Customer health ─────────────────────────────

const account = (id: string, a: Record<string, unknown> = {}) => ({ _id: `crmAccounts:${id}`, orgId: ORG, name: id, ...a });
const contactsFor = (id: string, n: number) => Array.from({ length: n }, (_, i) => ({ _id: `crmContacts:${id}-${i}`, orgId: ORG, accountId: `crmAccounts:${id}` }));
const accountDeal = (accountId: string, id: string, d: Record<string, unknown>) => deal(`${accountId}-${id}`, { accountId: `crmAccounts:${accountId}`, ...d });
const synced = (days: number) => NOW - days * DAY;

function healthMixed(): Tables {
  const r = rng(11);
  const accounts = [
    account("arr10m", { ownerId: "users:a", lastSyncAt: synced(7) }),
    account("arr5m", { lastSyncAt: synced(8) }),
    account("arrUnder5m", { ownerId: "users:a", lastSyncAt: synced(30) }),
    account("arrUnder10m", { lastSyncAt: synced(31), annualRevenue: 50_000_000 }),
    account("expansion", { ownerId: "users:b" }),
    account("renewal", { lastSyncAt: synced(0) }),
    account("prospect", { annualRevenue: 90_000_000_000, lastSyncAt: synced(1) }),
  ];
  const contacts = [...contactsFor("arr10m", 3), ...contactsFor("arr5m", 2), ...contactsFor("arrUnder5m", 1), ...contactsFor("expansion", 4), ...contactsFor("prospect", 6)];
  const deals = [
    accountDeal("arr10m", "won", { isWon: true, isClosed: true, arr: 10_000_000, amount: 1 }),
    accountDeal("arr5m", "won", { isWon: true, isClosed: true, arr: 5_000_000 }),
    accountDeal("arrUnder5m", "won", { isWon: true, isClosed: true, arr: 4_999_999 }),
    accountDeal("arrUnder10m", "won", { isWon: true, isClosed: true, amount: 9_999_999 }),
    accountDeal("expansion", "open", { dealType: "expansion", amount: 300_000 }),
    accountDeal("expansion", "renewal", { dealType: "renewal", isClosed: true, amount: 50, closeDate: "2027-01-02" }),
    accountDeal("renewal", "won", { isWon: true, isClosed: true, amount: 2_000_000 }),
    accountDeal("renewal", "next", { dealType: "renewal", amount: 1_000_000, closeDate: "2026-12-20" }),
    accountDeal("renewal", "later", { dealType: "renewal", amount: 10, closeDate: "2027-03-01" }),
    accountDeal("prospect", "open", { amount: 40_000 }),
  ];
  for (let i = 0; i < 53; i++) {
    const id = `customer${i}`;
    accounts.push(account(id, { ...(r() < 0.5 ? { ownerId: "users:a" } : {}), ...(r() < 0.8 ? { lastSyncAt: synced(Math.floor(r() * 60)) } : {}), ...(r() < 0.3 ? { annualRevenue: Math.floor(r() * 3e7) } : {}) }));
    contacts.push(...contactsFor(id, Math.floor(r() * 5)));
    deals.push(accountDeal(id, "won", { isWon: true, isClosed: true, amount: Math.floor(r() * 12_000_000) }));
    if (r() < 0.3) deals.push(accountDeal(id, "open", { amount: Math.floor(r() * 500_000) }));
  }
  return {
    crmAccounts: accounts, crmContacts: contacts, deals, customerHealthConfigs: [],
    customerHealthScores: [{ _id: "customerHealthScores:old", orgId: ORG, accountId: "crmAccounts:arr10m", overallScore: 1, health: "churning" }],
  };
}

function healthNoCustomers(): Tables {
  return {
    crmAccounts: [
      account("big", { annualRevenue: 20_000_000, ownerId: "users:a", lastSyncAt: synced(2) }),
      account("mid", { annualRevenue: 5_000_000, lastSyncAt: synced(29) }),
      account("bare"),
      account("pipeline", { lastSyncAt: synced(400) }),
    ],
    crmContacts: [...contactsFor("big", 2), ...contactsFor("mid", 3), ...contactsFor("pipeline", 9)],
    deals: [accountDeal("pipeline", "open", { amount: 12_000_000 })],
    customerHealthConfigs: [{ _id: "customerHealthConfigs:mine", orgId: ORG, name: "Mine", signals: [], isActive: true, createdAt: 1, updatedAt: 1 }],
    customerHealthScores: [],
  };
}

async function healthCases(): Promise<Case[]> {
  const out: Case[] = [];
  for (const [name, tables] of Object.entries({ mixed: healthMixed(), noCustomerSignal: healthNoCustomers() })) {
    const M = modules();
    const db = memoryDb(structuredClone(tables));
    const result = await M["customerHealth.ts"].generateFromCrm.handler({ db }, {});
    const scores = strip(db.rows("customerHealthScores")).sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
    out.push({ surface: "health", name, input: { tables }, output: { result, scores, configs: strip(db.rows("customerHealthConfigs")) } });
  }
  return out;
}

// ───────────────────────────── Lead scoring ─────────────────────────────

const leadContact = (id: string, c: Record<string, unknown> = {}) => ({ _id: `crmContacts:${id}`, orgId: ORG, ...c });
const LEAD_ACCOUNTS = [
  account("enterprise", { employeeCount: 200, annualRevenue: 2_000_000_000, ownerId: "users:a", industry: "SaaS" }),
  account("justUnder", { employeeCount: 199, annualRevenue: 1_999_999_999 }),
  account("small", { employeeCount: 12, annualRevenue: 1_000, industry: "saas" }),
  account("unknown", {}),
];
const LEAD_CONTACTS = [
  leadContact("chief", { title: "Chief Revenue Officer", accountId: "crmAccounts:enterprise" }),
  leadContact("vp", { title: "VP Sales", accountId: "crmAccounts:justUnder" }),
  leadContact("svp", { title: "SVP, Chief of Staff", accountId: "crmAccounts:enterprise", ownerId: "users:b" }),
  leadContact("developer", { title: "Developer", accountId: "crmAccounts:small" }),
  leadContact("noTitle", { accountId: "crmAccounts:unknown" }),
  leadContact("loner", { title: "vp", ownerId: "users:a" }),
  leadContact("a44", { title: "a44" }), leadContact("a45", { title: "a45" }), leadContact("a69", { title: "a69" }), leadContact("a70", { title: "a70" }),
  leadContact("a40owned", { title: "a40", ownerId: "users:a" }), leadContact("a65owned", { title: "a65", ownerId: "users:a" }),
  leadContact("over", { title: "a70 a45", accountId: "crmAccounts:enterprise" }), leadContact("under", { title: "minus" }),
];
const COUNTS = [{ accountId: "crmAccounts:enterprise", count: 3 }, { accountId: "crmAccounts:justUnder", count: 1 }, { accountId: "crmAccounts:small", count: 0 }];
const customModel = (id: string, rules: Array<{ field: string; operator: string; value: unknown; points: number }>) =>
  ({ _id: `leadScoringModels:${id}`, orgId: ORG, name: id, isActive: true, createdAt: 1, updatedAt: 1, thresholds: { hot: 70, warm: 45, cold: 0 }, rules });
const BOUNDARIES = customModel("boundaries", [
  ...[40, 44, 45, 65, 69, 70].map((n) => ({ field: "title", operator: "contains", value: `a${n}`, points: n })),
  { field: "title", operator: "contains", value: "minus", points: -200 },
]);
const OPERATORS = customModel("operators", [
  { field: "revenue", operator: "greater_than", value: "$2,000,000,000", points: 1 },
  { field: "annualRevenue", operator: "gt", value: "1,000", points: 2 },
  { field: "employee_count", operator: "gte", value: 199, points: 4 },
  { field: "employeeCount", operator: "lt", value: 13, points: 8 },
  { field: "employee_count", operator: "lte", value: "12", points: 16 },
  { field: "revenue", operator: "less_than", value: 1001, points: 32 },
  { field: "industry", operator: "equals", value: "saas", points: 64 },
  { field: "Industry", operator: "eq", value: "SaaS", points: 128 },
  { field: "revenue", operator: "between", value: 1, points: 256 },
  { field: "foo", operator: "equals", value: "", points: 512 },
  { field: "revenue", operator: "greater_than", value: "lots", points: 1024 },
]);

async function leadCases(): Promise<Case[]> {
  const out: Case[] = [];
  for (const [name, models] of Object.entries({ template: [], boundaries: [BOUNDARIES], operators: [OPERATORS] })) {
    const tables: Tables = { leadScoringModels: models, crmAccounts: LEAD_ACCOUNTS, crmContacts: LEAD_CONTACTS, leadScores: [] };
    const M = modules();
    const db = memoryDb(structuredClone(tables));
    const model = await M["leadScoring.ts"].ensureActiveModelInternal.handler({ db }, { orgId: ORG });
    const result = await M["leadScoring.ts"].scoreContactsBatchInternal.handler({ db }, { orgId: ORG, modelId: model._id, contactIds: LEAD_CONTACTS.map((c) => c._id), accountContactCounts: COUNTS, calculatedAt: NOW });
    out.push({ surface: "lead", name, input: { tables }, output: { model: strip([model])[0], result, scores: strip(db.rows("leadScores")) } });
  }
  return out;
}

// ───────────────────────────── Signal heat ─────────────────────────────

type Bucket = "job" | "site" | "blog" | "social";
const BUCKETS: Bucket[] = ["job", "site", "blog", "social"];
const sig = (bucket: Bucket, ageDays: number, reposted?: boolean) => ({ bucket, observedAt: NOW - ageDays * DAY, ...(reposted === undefined ? {} : { reposted }) });

function heatInputs() {
  const r = rng(7);
  const named: Record<string, ReturnType<typeof sig>[]> = {
    none: [], oneFresh: [sig("job", 0)], threeFresh: [sig("job", 0), sig("job", 0), sig("job", 0)], fifteen: [sig("job", 15)], one: [sig("job", 1)],
    windowEdge: [sig("job", 30), sig("job", 90)], reposted: [sig("job", 1, true)], fifty: Array.from({ length: 50 }, () => sig("job", 0)),
    mixed: [sig("site", 2), sig("blog", 3), sig("social", 0), sig("job", 29.5, false)], future: [sig("job", -2)], sixRoles: Array.from({ length: 6 }, () => sig("job", 0)),
  };
  for (let i = 0; i < 40; i++) named[`sweep${i}`] = Array.from({ length: Math.floor(r() * 12) }, () => sig(BUCKETS[Math.floor(r() * 4)], Math.floor(r() * 45) - 2, r() < 0.3));
  return named;
}

function growthInputs() {
  const r = rng(9);
  const row = (bucket: Bucket, ageDays: number) => ({ bucket, observedAt: NOW - ageDays * DAY });
  const named: Record<string, Array<{ bucket: Bucket; observedAt: number }>> = {
    hiringOnly: [row("job", 5), row("site", 40), row("blog", 3), row("social", 90)],
    several: [row("site", 1), row("blog", 3), row("blog", 29), row("social", 90), row("social", 1)],
    edges: [row("job", 30), row("site", 31), row("blog", 30), row("blog", 0.5), row("job", -1), row("site", -1.5)],
    empty: [],
  };
  for (let i = 0; i < 20; i++) named[`sweep${i}`] = Array.from({ length: Math.floor(r() * 10) }, () => row(BUCKETS[Math.floor(r() * 4)], Math.floor(r() * 50) - 2));
  return named;
}

function heatLog() {
  const seen = (seq: number, key: string, bucket: Bucket, at: number, reposted = false) =>
    ({ seq, observedAt: at, occurredAt: at, body: { type: "signal_seen", key, signal: { trigger: `${bucket}_trigger`, bucket, reposted } } });
  const gone = (seq: number, key: string, at: number) => ({ seq, observedAt: at, body: { type: "signal_gone", key } });
  return [seen(1, "a", "job", NOW - 40 * DAY), seen(2, "b", "site", NOW - 10 * DAY), gone(3, "a", NOW - 5 * DAY), seen(4, "c", "job", NOW - 2 * DAY, true), seen(5, "d", "blog", NOW - DAY)];
}

function heatCases(): Case[] {
  const out: Case[] = [];
  const heat = defaultModel("signals.heat");
  for (const [name, signals] of Object.entries(heatInputs())) {
    out.push({ surface: "heat", name, input: { signals, now: NOW }, output: { heat: heatScore(signals, NOW, heat), points: signals.map((s) => signalPoints(s, NOW, heat)) } });
  }
  for (const [name, rows] of Object.entries(growthInputs())) out.push({ surface: "growth", name, input: { rows, now: NOW }, output: growthKinds(rows, NOW, heat) });
  const log = heatLog();
  for (const days of [0, 3, 6, 12, 41]) out.push({ surface: "heatAsOf", name: `log at -${days}d`, input: { log, t: NOW - days * DAY }, output: heatAsOf(log as never, NOW - days * DAY, heat) });
  return out;
}

// ───────────────────────────── Hygiene audit ─────────────────────────────

const ago = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function staleSnapshot(): CanonicalGtmSnapshot {
  const base = { provider: "mock" as const, ownerId: "u1", accountId: "a1", amount: 1000, stage: "Discovery", isClosed: false, isWon: false };
  const deals = [30, 31, 44, 45, 89, 90, 120].map((days) => ({ ...base, id: `stale${days}`, crmId: `stale${days}`, name: `Stale ${days}`, closeDate: ahead(60), lastActivityAt: ago(days) }));
  deals.push(...[[14, 8], [14, 7], [15, 8], [0, 8]].map(([close, idle]) => ({ ...base, id: `soon${close}-${idle}`, crmId: `soon${close}-${idle}`, name: `Soon ${close}/${idle}`, closeDate: ahead(close), lastActivityAt: ago(idle) })));
  deals.push({ ...base, id: "noAmount", crmId: "noAmount", name: "No amount", amount: 0, closeDate: ahead(40), lastActivityAt: ago(1) });
  return {
    generatedAt: `${TODAY}T12:00:00.000Z`, provider: "mock",
    users: [{ id: "u1", provider: "mock", crmId: "u1", name: "Ada", email: "ada@x.io", active: true }],
    accounts: [30, 31].map((days) => ({ id: `acct${days}`, provider: "mock" as const, crmId: `acct${days}`, name: `Acct ${days}`, domain: `acct${days}.io`, ownerId: "u1", lastSyncAt: ago(days) })).concat([{ id: "a1", provider: "mock", crmId: "a1", name: "Main", domain: "main.io", ownerId: "u1", lastSyncAt: ago(3) }]),
    contacts: [{ id: "k1", provider: "mock", crmId: "k1", firstName: "Kim", lastName: "Lee", email: "kim@main.io", accountId: "a1", ownerId: "u1" }],
    deals, activities: [],
  } as CanonicalGtmSnapshot;
}

function auditCases(): Case[] {
  process.env.SOURCE_DATE_EPOCH = String(Math.floor(NOW / 1000));
  const snapshots: Record<string, { snapshot: CanonicalGtmSnapshot; today: string }> = {
    demo: { snapshot: generateDemoSnapshot(), today: "2026-06-09" },
    sample: { snapshot: sampleSnapshot, today: "2026-05-03" },
    stale: { snapshot: staleSnapshot(), today: TODAY },
  };
  const model = defaultModel("hygiene.policy");
  return Object.entries(snapshots).map(([name, { snapshot, today }]) => ({
    surface: "audit", name, input: { snapshot, today }, output: JSON.stringify(auditSnapshot(snapshot, hygienePolicy(model, today), hygieneRules(model))),
  }));
}

// ───────────────────────────── ICP fit ─────────────────────────────

const market = (industries: string[], employeeBands: string[], countries: string[], persona: Partial<IcpSpec["persona"]> = {}): IcpSpec =>
  ({ ...emptySpec(), market: { industries, employeeBands, countries }, persona: { ...emptySpec().persona, ...persona } });
const FIT_SPECS: Record<string, IcpSpec> = {
  oneIndustry: market(["software development"], ["51-200"], ["us"]),
  twoIndustries: market(["software development", "banking"], ["51-200", "201-500"], ["us", "gb"]),
  threeIndustries: market(["software development", "banking", "it services and it consulting"], ["11-50", "51-200", "201-500"], ["us", "gb", "de"]),
  fourIndustries: market(["software development", "banking", "it services and it consulting", "insurance"], ["11-50", "51-200", "201-500", "501-1000"], []),
  gappedBands: market(["banking"], ["1-10", "201-500", "10001+"], ["gb"], { levels: ["vp"], departments: ["Sales"] }),
  oddBandsEdge: market([], ["1-10", "11-50", "51-200", "201-500", "501-1000"], ["us"], { titles: ["Head of Sales"] }),
  unknownBand: market(["insurance"], ["50-60", "1001-5000"], [], { titles: ["revenue operations"] }),
  bandsOnly: market([], ["5001-10000", "10001+"], []),
  excluded: { ...market(["software development"], ["51-200"], ["us"]), exclude: { industries: ["staffing and recruiting"], countries: ["ca"], titles: ["intern"] } },
};
const FIT_ROWS: Record<string, Parameters<typeof gatedFit>[0]> = {
  saasUs: { industry: "Software Development", country: "United States", employees: 120, titles: ["VP Sales"] },
  saasUsBig: { industry: "software development", country: "united states", employees: 350, titles: ["Chief Revenue Officer"] },
  bankGb: { industry: "Banking", country: "United Kingdom", employees: 300, titles: ["VP of Sales"] },
  bankGbTiny: { industry: "banking", country: "united kingdom", employees: 4, titles: ["Head of Sales"] },
  itDe: { industry: "IT Services and IT Consulting", country: "Germany", employees: 30, titles: ["Director of Engineering"] },
  insurer: { industry: "Insurance", employees: 700, titles: ["Head of Revenue Operations"] },
  noBuyer: { industry: "software development", country: "united states", employees: 120, titles: ["Software Engineer"] },
  noTitles: { industry: "software development", country: "united states", employees: 120 },
  huge: { employees: 20_000, titles: ["CEO"] },
  unknownSize: { industry: "banking", country: "united kingdom" },
};

function fitCases(): Case[] {
  const out: Case[] = [];
  const fit = defaultModel("scoring.fit");
  const gates = Object.entries(FIT_SPECS).map(([id, spec]) => specGate(id, spec, fit));
  for (const [name, spec] of Object.entries(FIT_SPECS)) {
    out.push({ surface: "fit", name, input: { spec }, output: { weights: icpToWeights(specToIcp(spec.market, spec.persona), fit), gate: specGate(name, spec, fit), buyer: specBuyer(spec, fit.buyerLevels) } });
  }
  for (const [name, row] of Object.entries(FIT_ROWS)) {
    out.push({ surface: "fit.gated", name, input: { row }, output: { each: gates.map((g) => gatedFit(row, [g])), all: gatedFit(row, gates), history: gatedFit(row, gates, false) } });
  }
  out.push({ surface: "fit", name: "heuristic", input: { domain: "x.io" }, output: icpToWeights(heuristicIcp("x.io"), fit) });
  return out;
}

// ───────────────────────────── Calls ─────────────────────────────

const CALL_CONTEXT: ConversationFactsContext = {
  source: { kind: "call", id: "callRecordings:c" },
  title: "Acme sync",
  day: "2026-10-11",
  summary: "Legal review starts next week.",
  text: "Riley: Where are you on budget?\nSam Lee: Budget is approved.  We want to sign by November 20th.\nSam Lee: I just moved into the CFO role last month.\nRiley: I'll send the order form by Thursday.",
  deal: { name: "Acme expansion", stage: "Proposal", nextStep: "Book the demo", closeDate: "2026-12-31" },
  people: [{ email: "sam@acme.example", name: "Sam Lee", title: "VP Finance" }],
};

function promptContexts(): Record<string, ConversationFactsContext> {
  const out: Record<string, ConversationFactsContext> = { test: CALL_CONTEXT, "test without a deal": { ...CALL_CONTEXT, deal: null } };
  for (const deal of [true, false]) for (const mentions of [true, false]) for (const opportunity of [true, false]) for (const domains of [true, false]) for (const newPeople of [true, false]) {
    out[`deal ${deal} mentions ${mentions} opportunity ${opportunity} domains ${domains} new ${newPeople}`] = {
      ...CALL_CONTEXT,
      deal: deal ? { name: "Globex", stage: null, nextStep: null, closeDate: null } : null,
      people: newPeople ? [] : [{ email: "kim@globex.example", name: null, title: null }],
      ...(newPeople ? { newPeople: [{ email: "lee@globex.example", name: "Lee" }, { email: "x@globex.example", name: null }] } : {}),
      ...(domains ? { newDomains: ["globex.example", "initech.example"] } : {}),
      askMentions: mentions, askOpportunity: opportunity,
    };
  }
  out["no summary"] = { ...CALL_CONTEXT, summary: null };
  return out;
}

const INSIGHT_TRANSCRIPTS: Record<string, string> = {
  callInsightExtraction: "Rep: What is making this urgent?\nCustomer: We are struggling with manual updates and the forecast is messy. Pricing is a concern because we have no budget. We evaluated Gong and Clari. The next step is to schedule a security review next Tuesday.",
  speakers: "Rep: Thanks for the time today. What's the hardest part of your current process?\nCustomer: Honestly we're struggling with manual CRM updates, it takes too much time.\nCustomer: And pricing matters — our budget review is next month.\nRep: Got it. Next step, I'll send over the proposal by Friday and we can schedule the security review.",
  granola: normalizeTranscript(JSON.stringify([
    { text: "What's blocking the rollout?", source: "microphone" },
    { text: "We're worried about the security review and the timing.", source: "system" },
    { text: "I'll follow up with the compliance doc tomorrow.", source: "microphone" },
  ])),
};

/** Words from every keyword category and around them, so a sweep reaches each category and its edges. */
const CALL_WORDS = ["struggling", "frustrated", "frustrating", "manual", "hard to", "too much time", "concern", "not sure", "too expensive", "security review", "need to think", "another vendor",
  "competitor", "evaluating", "looked at", "using", "salesforce", "HubSpot", "gong", "6sense", "clay", "workato", "acme", "next step", "follow up", "send over", "circle back", "by friday", "by Monday",
  "I'll send", "we'll send", "action item", "wish", "would love", "does it support", "can it", "custom field", "export", "price", "PO", "po", "$500", "$", "ARR", "invoice", "annual",
  "criteria", "success looks like", "must have", "committee", "approval", "delay", "blocked", "slip", "ghost", "champion left", "reorg", "let me tell you", "obviously", "trust me",
  "to be honest", "just checking in", "does that make sense?", "the", "team", "today", "pains", "pricey", "budgeted", "scheduled", "rep", "and", "we", "it"];

function insightTranscripts(): Record<string, string> {
  const out = { ...INSIGHT_TRANSCRIPTS };
  const r = rng(5);
  const pick = () => CALL_WORDS[Math.floor(r() * CALL_WORDS.length)];
  for (let i = 0; i < 30; i++) {
    out[`sweep${i}`] = Array.from({ length: 2 + Math.floor(r() * 6) }, (_, n) =>
      `${n % 2 ? "Customer" : "Rep"}: ${Array.from({ length: 2 + Math.floor(r() * 8) }, pick).join(" ")}${r() < 0.5 ? "." : ""}`).join("\n");
  }
  out.everyWord = CALL_WORDS.map((w) => `Customer: we talked about ${w} at length.`).join("\n");
  return out;
}

async function callCases(): Promise<Case[]> {
  const out: Case[] = [];
  const { define, phrases } = defaultModel("calls.model");
  for (const [name, context] of Object.entries(promptContexts())) out.push({ surface: "calls.prompt", name, input: { context }, output: conversationFactsPrompt(context, define) });
  const transcripts = insightTranscripts();
  for (const [name, transcript] of Object.entries(transcripts)) out.push({ surface: "calls.insights", name, input: { transcript }, output: extractCallInsights(transcript, undefined, phrases) });
  for (const name of ["callInsightExtraction", "speakers", "everyWord"]) {
    const tables: Tables = { callRecordings: [{ _id: "callRecordings:c", orgId: ORG, title: name, transcriptText: transcripts[name], createdAt: 1, updatedAt: 1 }], callTranscriptSegments: [], callInsights: [] };
    const db = memoryDb(structuredClone(tables));
    const result = await modules()["callIntelligence.ts"].analyzeImportedCall.handler({ db, scheduler: { runAfter: async () => null } }, { orgId: ORG, callId: "callRecordings:c" });
    out.push({ surface: "calls.analyze", name, input: { tables }, output: { result, insights: strip(db.rows("callInsights")).map(({ _id, segmentId, ...i }) => i) } });
  }
  return out;
}

// ───────────────────────────── Run ─────────────────────────────

export type Fixture = { captured: string; cases: Case[] };

export async function currentCases(): Promise<Case[]> {
  return [...await forecastCases(), ...await healthCases(), ...await leadCases(), ...heatCases(), ...auditCases(), ...fitCases(), ...await callCases()];
}

/** Each fixture case whose output the code in force no longer returns, with both outputs. */
export async function differences(fixture: Fixture): Promise<Array<{ surface: string; name: string; want: unknown; got: unknown }>> {
  const now = new Map((await currentCases()).map((c) => [`${c.surface}\u0000${c.name}`, c]));
  return fixture.cases.flatMap((c) => {
    const got = now.get(`${c.surface}\u0000${c.name}`)?.output;
    return isDeepStrictEqual(JSON.parse(JSON.stringify(got ?? null)), c.output) ? [] : [{ surface: c.surface, name: c.name, want: c.output, got }];
  });
}

const FILES = [FIXTURE_FILE, CALLS_FIXTURE_FILE];
const fileOf = (c: Case) => (c.surface.startsWith("calls.") ? CALLS_FIXTURE_FILE : FIXTURE_FILE);

async function main(argv: string[]) {
  if (argv.includes("--capture")) {
    const all = JSON.parse(JSON.stringify(await currentCases())) as Case[];
    for (const file of FILES) {
      const cases = all.filter((c) => fileOf(c) === file);
      writeFileSync(file, `${JSON.stringify({ captured: argv[argv.indexOf("--capture") + 1] ?? "the code in force", cases }, null, 1)}\n`);
      console.log(`Captured ${cases.length} cases to ${file}.`);
    }
    return;
  }
  let failed = false;
  for (const file of FILES) {
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    const diffs = await differences(fixture);
    const by = new Map<string, { total: number; same: number }>();
    for (const c of fixture.cases) {
      const s = by.get(c.surface) ?? { total: 0, same: 0 };
      s.total++;
      if (!diffs.some((d) => d.surface === c.surface && d.name === c.name)) s.same++;
      by.set(c.surface, s);
    }
    console.log(`Fixture: ${fixture.captured}.`);
    for (const [surface, s] of by) console.log(`${surface.padEnd(14)} ${s.same}/${s.total} equal`);
    for (const d of diffs.slice(0, 5)) console.log(`\n${d.surface} ${d.name}\n  want ${JSON.stringify(d.want).slice(0, 600)}\n  got  ${JSON.stringify(d.got).slice(0, 600)}`);
    failed ||= diffs.length > 0;
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
