/**
 * Workspace import (convex/workspaceImport.ts, cli/workspaceImport.ts): workspace A, built with the app's own writers,
 * is exported, imported into an empty workspace B in the same deployment, and B is exported again. The round trip
 * compares A and B through the import's id map. Then the safety rules: only B is written, only tables the importer
 * writes, an untrusted file can't add an admin, a dry run writes nothing, and an interrupted import resumes.
 * Ada is the admin who owns both workspaces (one email); Rex, an admin in A, has no account in B; Carl is a rep elsewhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { exportWorkspace, type Transport } from "../cli/workspaceArchive.ts";
import { importWorkspace, planImport, type ImportTransport } from "../cli/workspaceImport.ts";
import { appendHistory, save } from "../convex/lib/objects/write.ts";
import { applyEdgeCommand } from "../convex/lib/objects/associations.ts";
import { arrive, CENSUS, INERT, QUIET, SWITCH_FIELDS } from "../convex/lib/workspaceArchive/actors.ts";
import { decodeRow, DEFERRED, dependenciesOf, foreignLabel, importOrder, IMPORT_TABLES, registerIdOf, shapeOf, type Shape } from "../convex/lib/workspaceArchive/importRows.ts";
import { ARCHIVE_TABLES, entryOf, exported } from "../convex/lib/workspaceArchive/tables.ts";
import { ingestObservations } from "../convex/lib/canon/ledger.ts";
import { gtmHumanOnlyFunctions } from "../src/lib/gtm-human-only-mutations.ts";

const M = loadConvex(["schema.ts", "workspaceTransfer.ts", "workspaceImport.ts", "customObjects.ts", "dealHistory.ts", "objects.ts", "associations.ts", "observations.ts", "lib/objects/orgDefs.ts"]);
const T = M["workspaceTransfer.ts"], I = M["workspaceImport.ts"];
const objects = M["objects.ts"] as unknown as { convexObjectStore: (ctx: unknown) => any };
const edges = M["associations.ts"] as unknown as { edgeStore: (ctx: unknown) => any };
const orgDefs = M["lib/objects/orgDefs.ts"] as unknown as { loadOrgObject: (ctx: unknown, org: string, o: string) => Promise<any> };
const obs = M["observations.ts"] as unknown as { appendObservations: (...a: unknown[]) => Promise<void> };
const tables = (M["schema.ts"] as unknown as { default: { tables: Record<string, { validator: unknown }> } }).default.tables;
const W = loadConvex(["savedViews.ts", "reports.ts", "dashboards.ts", "audiences.ts", "icps.ts", "canonGate.ts", "canon.ts"]);
const canon = W["canon.ts"] as unknown as { convexLedgerStore: (ctx: unknown) => any };
const X = loadConvex(["automations.ts", "patchPlans.ts"]);
const Auto = X["automations.ts"], Plans = X["patchPlans.ts"];
const Agents = loadConvex(["agentTurns.ts", "agents.ts", "researchAgents.ts", "dealPlays.ts", "conversationExtract.ts", "conversationView.ts"]) as Record<string, Record<string, { handler: (ctx: any, args: any) => Promise<any> }>>;
// The fit reconciler with a record service that keeps what each workspace was asked to score by.
const rescored = new Map<string, unknown>();
const F = loadConvex(["fitReconciler.ts"], { "records.ts": (r) => ({ ...r, clientFor: () => ({ contractVersion: async () => "1.41.0", rescore: async (org: string, weights: unknown, version: number, gates: unknown) => (rescored.set(org, JSON.parse(JSON.stringify({ weights, gates }))), { rescored: 0 }) }) }) });
async function rescore(db: Db, orgId: string) {
  const ctx: any = { db, scheduler: { runAfter: async () => null }, runMutation: (ref: unknown, args: unknown) => F["fitReconciler.ts"][String(ref).split(".")[2]].handler(ctx, args) };
  const state = db.rows("fitReconciliations").find((r) => r.orgId === orgId);
  assert.ok(state?.queued, "a rescore is queued");
  await F["fitReconciler.ts"].reconcile.handler(ctx, { orgId, generation: state.generation });
  return rescored.get(orgId);
}

// Convex-shaped ids, so every id grammar the importer rewrites is exercised.
const ALPHA = "0123456789abcdefghjkmnpqrstvwxyz";
let minted = 0;
const mint = () => Array.from(createHash("sha256").update(`id${++minted}`).digest().subarray(0, 32), (b) => ALPHA[b & 31]).join("");
const sha20 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);

type Db = ReturnType<typeof memoryDb>;
function world() {
  const A = mint(), B = mint(), C = mint(), ada = mint(), rex = mint(), adaB = mint(), carl = mint();
  const db = memoryDb({
    organizations: [
      { _id: A, name: "Acme Sales", slug: "acme", clerkOrgId: "org_a", fiscalYearStartMonth: 1, defaultCurrency: "USD", timezone: "UTC" },
      { _id: B, name: "New", slug: "acme-new", clerkOrgId: "org_b", fiscalYearStartMonth: 1, defaultCurrency: "USD", timezone: "UTC" },
      { _id: C, name: "Other", slug: "other", clerkOrgId: "org_c", fiscalYearStartMonth: 1, defaultCurrency: "USD", timezone: "UTC" },
    ],
    users: [
      { _id: ada, orgId: A, clerkUserId: "clerk_ada", email: "ada@acme.example", name: "Ada", role: "admin", isActive: true, createdAt: 1 },
      { _id: rex, orgId: A, clerkUserId: "clerk_rex", email: "rex@acme.example", name: "Rex", role: "admin", managerId: ada, title: "AE", isActive: true, createdAt: 1 },
      { _id: adaB, orgId: B, clerkUserId: "clerk_ada_b", email: "ada@acme.example", name: "Ada", role: "admin", isActive: true, createdAt: 1 },
      { _id: carl, orgId: C, clerkUserId: "clerk_carl", email: "carl@other.example", name: "Carl", role: "rep", isActive: true, createdAt: 1 },
    ],
  });
  const insert = db.insert;
  db.insert = (table: string, doc: Record<string, unknown>) => insert(table, { _id: mint(), ...doc });
  return { db, A, B, C, ada, rex, adaB };
}

const identity = (clerk: string) => ({ tokenIdentifier: clerk, subject: clerk, issuer: "https://clerk.example" });
const handlers: Record<string, Record<string, { handler: (ctx: any, args: any) => Promise<any> }>> = { workspaceImport: I, workspaceTransfer: T, dealHistory: M["dealHistory.ts"] };
function ctxOf(db: Db, clerk: string | null = null): any {
  const ctx: any = {
    db, auth: { getUserIdentity: async () => (clerk ? identity(clerk) : null) }, scheduler: { runAfter: async () => null },
  };
  const run = (ref: unknown, args: unknown) => {
    const [, mod, fn] = String(ref).split(".");
    return handlers[mod][fn].handler(ctx, args);
  };
  // A mutation that throws leaves nothing behind, as in Convex.
  ctx.runQuery = run;
  ctx.runMutation = async (ref: unknown, args: unknown) => { const cp = db.checkpoint(); try { return await run(ref, args); } catch (e) { db.rollback(cp); throw e; } };
  return ctx;
}
const atomic = async <R>(db: Db, fn: () => Promise<R>) => { const cp = db.checkpoint(); try { return await fn(); } catch (e) { db.rollback(cp); throw e; } };

/** Workspace A: settings, a custom object, companies (one merged, one with no domain), people, a deal with history, edges, a long stream. */
async function buildA(w: ReturnType<typeof world>) {
  const { db, A, ada, rex } = w;
  const ctx = ctxOf(db);
  const store = objects.convexObjectStore(ctx);
  const def = (o: string) => orgDefs.loadOrgObject(ctx, A, o);
  const asAda = { source: { kind: "user" as const, ref: `user:${ada}` }, actor: { kind: "user" as const, id: ada } };
  const saveAs = async (o: string, cmd: any, now: number, who = asAda) => {
    const r = await save(store, { orgId: A, def: await def(o), ...who, now }, cmd);
    assert.ok(r.status === "applied" || r.status === "proposed", JSON.stringify(r));
    return r as { streamId: string };
  };
  db.patch(A, { fiscalYearStartMonth: 2, defaultCurrency: "EUR", timezone: "Europe/Paris" });
  const { apiName: widget } = await M["customObjects.ts"].create.handler(ctxOf(db, "clerk_ada"), { label: "Widget", pluralLabel: "Widgets", icon: "box", titleLabel: "Name" });
  await db.insert("orgRoles", { orgId: A, key: "sdr", name: "SDR", base: "rep", capabilities: ["workspace.transfer"], updatedAt: 1, updatedBy: ada });
  const stages = ["Discovery", "Proposal", "Negotiation"];
  await db.insert("objectDefs", { orgId: A, apiName: "deal", registryVersion: 1, customFields: [], picklistOptions: { stage: stages.map((value) => ({ value, label: value, active: true })) }, updatedAt: 1 });
  for (const [i, stageName] of stages.entries()) await db.insert("pipelineStageConfigs", { orgId: A, stageName, orderIndex: i, defaultProbability: 0.1 * (i + 1), forecastCategory: "pipeline", isActive: true, createdAt: 1 });
  await db.insert("dealPipelines", { orgId: A, name: "New business", stages: stages.map((value, i) => ({ value, probability: 0.1 * (i + 1), forecastCategory: "pipeline" })), createdAt: 1 });
  await db.insert("teamGroups", { orgId: A, name: "East", managerId: ada, memberIds: [ada, rex], createdAt: 1 });

  /** A company or person as the party ledger makes one: its stream projects to its register row. */
  const party = async (object: "account" | "contact", values: Record<string, unknown>, at: number) => {
    const id = await db.insert("canonEntities", { orgId: A, entityType: object, projectionTable: object === "account" ? "recordAccounts" : "recordContacts", projectionId: "", createdAt: at });
    const key = object === "account" ? values.domain : values.email;
    const recordId = key ? `${object === "account" ? "acc" : "con"}_${sha20(String(key))}` : await registerIdOf(object, id);
    await db.patch(id, { projectionId: recordId });
    await appendHistory(store, { orgId: A, def: await def(object), now: at }, id, [
      { streamId: id, version: 1, observedAt: at, ...asAda, body: { kind: "lifecycle", op: "create" } },
      { streamId: id, version: 2, observedAt: at, ...asAda, body: { kind: "assert", status: "accepted", assertions: Object.entries(values).map(([fieldId, value]) => ({ fieldId, value })) } },
    ] as any);
    await db.insert("canonExternalIds", { orgId: A, entityId: id, provider: "record", externalId: recordId });
    return { id, recordId };
  };
  const acme = await party("account", { name: "Acme", domain: "acme.example", ownerId: rex }, 1_000);
  const quiet = await party("account", { name: "Quiet Co", ownerId: rex }, 1_100);
  const dupe = await party("account", { name: "Acme Inc", domain: "acme-inc.example" }, 1_200);
  const pat = await party("contact", { fullName: "Pat Lee", email: "pat@acme.example" }, 1_300);
  const sam = await party("contact", { fullName: "Sam Noemail", ownerId: rex }, 1_400);
  await saveAs("account", { op: "update", streamId: acme.id, values: { industry: "Software" } }, 2_000);
  await saveAs("account", { op: "merge", streamId: dupe.id, into: acme.id }, 2_100);
  const undo = { survivor: { stream: acme.id, recordId: acme.recordId }, losers: [{ stream: dupe.id, recordId: dupe.recordId }], edges: [] };
  await db.insert("recordMerges", { orgId: A, mergeId: "m1", object: "account", survivorStream: acme.id, survivorId: acme.recordId, losers: [{ stream: dupe.id, recordId: dupe.recordId, title: "Acme Inc" }], undo: JSON.stringify(undo), mergedBy: ada, mergedAt: 2_100 });
  await db.patch(dupe.id, { mergedInto: acme.id });
  await db.insert("duplicateDismissals", { orgId: A, object: "account", a: quiet.recordId, b: acme.recordId, dismissedBy: ada, dismissedAt: 2_200 });

  // A deal with stage history, owned by Rex.
  // Its company's register id derives from the company's stream (acc_s_), which the import creates after the deal row.
  const dealRow = await db.insert("deals", { orgId: A, name: "Big deal", amount: 50_000, currency: "EUR", closeDate: "2026-12-01", dealType: "new_business", revenueType: "one_time", primaryRepId: rex, companyId: quiet.recordId, stage: "Discovery", isClosed: false, isWon: false, createdAt: 3_000, updatedAt: 3_000 });
  const deal = await db.insert("canonEntities", { orgId: A, entityType: "opportunity", projectionTable: "deals", projectionId: dealRow, createdAt: 3_000 });
  await appendHistory(store, { orgId: A, def: await def("deal"), now: 3_000 }, deal, [
    { streamId: deal, version: 1, observedAt: 3_000, ...asAda, body: { kind: "lifecycle", op: "create" } },
    { streamId: deal, version: 2, observedAt: 3_000, ...asAda, body: { kind: "assert", status: "accepted", assertions: [{ fieldId: "name", value: "Big deal" }, { fieldId: "amount", value: 50_000 }, { fieldId: "stage", value: "Discovery" }, { fieldId: "ownerId", value: rex }, { fieldId: "companyId", value: acme.recordId }, { fieldId: "closeDate", value: "2026-12-01" }] } },
  ] as any);
  await saveAs("deal", { op: "update", streamId: deal, values: { stage: "Proposal", amount: 60_000 } }, 4_000);
  await saveAs("deal", { op: "update", streamId: deal, values: { stage: "Negotiation" } }, 5_000);
  await db.insert("dealContacts", { orgId: A, dealId: dealRow, contactId: pat.recordId, contactName: "Pat Lee", slot: "champion", setBy: rex, updatedAt: 5_000 });

  // Edges: a person at a company, a parent company, a person on the deal in a role (a labelled edge).
  const edgeCtx = { orgId: A, ...asAda, now: 6_000 };
  for (const cmd of [{ op: "link", fromId: sam.recordId, toId: acme.recordId }, { op: "setParent", accountId: quiet.recordId, parentId: acme.recordId }, { op: "setRole", dealId: deal, contactId: pat.recordId, role: "champion" }] as const) {
    const r = await applyEdgeCommand(edges.edgeStore(ctx), edgeCtx, cmd as any);
    assert.notEqual(r.status, "invalid", JSON.stringify(r));
  }
  // A deleted task, a custom record, and a note longer than the fold cap, part of it written by an agent.
  const task = await saveAs("task", { op: "create", values: { subject: "Call Pat", ownerId: rex } }, 7_000);
  await saveAs("task", { op: "delete", streamId: task.streamId }, 7_100);
  await saveAs(widget, { op: "create", values: { "custom.name": "Gizmo" } }, 7_200);
  const note = await saveAs("note", { op: "create", values: { body: "v0", accountId: acme.recordId } }, 8_000);
  const agent = mint();
  const many = (from: number, n: number, who = asAda) => Array.from({ length: n }, (_, i) => ({ streamId: note.streamId, version: from + i, observedAt: 8_000 + from + i, ...who, body: { kind: "assert", status: "accepted", assertions: [{ fieldId: "body", value: `v${from + i}` }] } }));
  const noteDef = await def("note");
  await appendHistory(store, { orgId: A, def: noteDef, now: 9_000 }, note.streamId, many(2, 600) as any);
  await appendHistory(store, { orgId: A, def: noteDef, now: 9_100 }, note.streamId, many(602, 404, { source: { kind: "agent_run", ref: `agent:${agent}` }, actor: { kind: "agent", id: agent } } as any) as any);

  // The register as a deployment without a record service keeps it, an unworked TAM company, and an observation.
  for (const [rec, row] of [[acme, { name: "Acme", domain: "acme.example" }], [quiet, { name: "Quiet Co" }]] as const) {
    await db.insert("fakeRecordAccounts", { ws: A, recordId: rec.recordId, row: { id: rec.recordId, ...row, stream: rec.id, ownerId: rex } });
  }
  await db.insert("fakeRecordAccounts", { ws: A, recordId: `acc_${sha20("tam.example")}`, row: { id: `acc_${sha20("tam.example")}`, name: "Tam Corp", domain: "tam.example" } });
  await db.insert("fakeRecordContacts", { ws: A, recordId: sam.recordId, accountId: acme.recordId, row: { id: sam.recordId, fullName: "Sam Noemail", stream: sam.id } });
  await db.insert("fakeRecordHistory", { ws: A, recordId: acme.recordId, entry: { field: "name", newValue: "Acme", actorId: rex, ts: 1_000 } });
  await obs.appendObservations(ctx, A, { object: "contact", contactId: sam.recordId }, { kind: "pipeline", ref: "linkedin" }, [{ observedAt: 6_500, body: { type: "hot_lead", key: "h1", provider: "gmail", userId: rex, reply: "Interested" } }]);
  await settleDealHistory(db, A);
  const rich = await buildRich(w, { acme, quiet, pat, dealRow, deal, agent });
  return { acme, quiet, dupe, pat, sam, deal, dealRow, note, agent, widget, ...rich };
}

/**
 * The rest of A, with the app's own writers: an agent's proposal awaiting review, a field two CRMs contest, gate
 * rules, an ICP, a saved view, a report on a dashboard and an audience. Then one row of every other table the
 * importer writes (synthesized from its validator, refs to rows of A), and an active rule, which stays behind.
 */
async function buildRich(w: ReturnType<typeof world>, a: { acme: { id: string; recordId: string }; quiet: { id: string; recordId: string }; pat: { id: string; recordId: string }; dealRow: string; deal: string; agent: string }) {
  const { db, A, ada, rex } = w;
  const as = ctxOf(db, "clerk_ada");
  const gate = W["canonGate.ts"];
  await gate.propose.handler(as, { agentId: "researcher", sourceKind: "agent_run", title: "Industry", facts: [{ entityType: "account", entityId: a.acme.id, attribute: "industry", value: "Fintech", evidence: "Their site sells payments", confidence: 0.7 }] });
  const store = canon.convexLedgerStore(ctxOf(db));
  for (const [sourceKind, value] of [["salesforce", "Retail"], ["hubspot", "Wholesale"]] as const) {
    await ingestObservations(store, { orgId: A, entityId: a.quiet.id, entityType: "account", sourceKind, sourceRefBase: `${sourceKind}:q1`, actor: { kind: "integration", id: sourceKind }, observedAt: 6_000, observations: [{ attribute: "industry", value }] });
  }
  // A fact an agent's standing grant accepted: the grant never moves, so its decider arrives as a label.
  const grant = mint();
  await ingestObservations(store, { orgId: A, entityId: a.acme.id, entityType: "account", sourceKind: "agent_run", sourceRefBase: `agent_run:researcher:${a.acme.id}`, actor: { kind: "user", id: ada }, observedAt: 6_050, observations: [{ attribute: "employees", value: 120 }], acceptedBy: { kind: "grant", grantId: grant } });
  await gate.setOwnership.handler(as, { sourceKind: "enrichment", attribute: "industry", allowed: false, entityType: "account" });
  await gate.setAutoAcceptRule.handler(as, { sourceKind: "agent_run", attribute: "industry", minConfidence: 0.9, enabled: false, entityType: "account" });
  const icp = await W["icps.ts"].create.handler(as, { name: "Software buyers", query: "industry:Software" });
  const filter = [{ field: "industry", op: "eq", value: "Software" }];
  const view = await W["savedViews.ts"].create.handler(as, { object: "account", name: "Software", shared: true, spec: { filter, columns: ["name", "industry"], layout: "table" } });
  const contacts = await W["savedViews.ts"].create.handler(as, { object: "contact", name: "Champions", shared: false, spec: { filter: [], columns: ["fullName"], layout: "table" } });
  await W["savedViews.ts"].create.handler(as, { object: "task", name: "Due by day", shared: false, spec: { filter: [], columns: ["subject"], layout: "calendar", calendar: { field: "dueDate" } } });
  const report = await W["reports.ts"].create.handler(as, { name: "Pipeline by stage", shared: true, spec: { object: "deal", filter: [], groupBy: [{ field: "stage" }], measures: [{ fn: "sum", field: "amount" }], chart: "bar" } });
  const dashboard = await W["dashboards.ts"].create.handler(as, { name: "Sales", shared: true, tiles: [{ reportId: report, wide: true }] });
  const audience = await W["audiences.ts"].create.handler(as, { name: "Pat's team", filter: [{ field: "email", op: "contains", value: "acme" }], viewId: contacts });
  await db.insert("audienceMembers", { orgId: A, audienceId: audience, contactId: a.pat.recordId, email: "pat@acme.example", target: "csv", outcome: "exported", at: 6_100, by: ada });
  const shape = (t: string) => shapeOf(tables[t].validator as Record<string, unknown>);
  const actors = await buildActors(w, a, shape);
  const agents = await buildAgents(w, { ...a, icp, audience }, shape);
  await db.insert("audienceAdditions", { orgId: A, audienceId: audience, contactId: a.pat.recordId, agentId: agents.eventAgent, turnId: agents.turns.done, at: 6_200 });
  // This deployment's connections, which rows of the archive name and which never move with it.
  const here = (t: string) => db.insert(t, synthesize(shape(t), { organizations: A, users: ada }) as Record<string, unknown>);
  await synthesizeRest(db, A, { users: ada, deals: a.dealRow, canonEntities: a.acme.id, linkedinAccounts: agents.sender, dialerSessions: await here("dialerSessions"), connectorLinks: await here("connectorLinks") });
  // Suggestions keyed by the call or the deal they came from (lib/calls/suggestions.ts, dealGaps.ts).
  const call = db.rows("callRecordings").find((r) => r.orgId === A)!._id as string;
  for (const key of [`call:${call}`, `deal:${a.deal}:company`]) await db.insert("callSuggestions", { orgId: A, callId: call, userId: ada, kind: "deal", key, status: "pending", values: { name: "Big deal" }, createdAt: 1 });
  return { icp, view, report, dashboard, audience, rex, grant, ...actors, ...agents };
}

/**
 * The agents and what they read, each about to act: an event agent owned by Ada (the importing admin, so its owner
 * is eligible in B) listening for deal stage changes, with a webhook secret, a grant, Slack and a route, and a turn
 * queued on a deal event; a research field on a weekly refresh that is overdue, with a run in progress; a deal play
 * whose keeper is due, with research running, a state run due and a LinkedIn step handed to a cadence; and
 * conversations whose extraction is due, one logged by BCC and one read from a LinkedIn sender. Mo, a rep whose role
 * reads only their own activity, can't read Ada's thread.
 */
async function buildAgents(w: ReturnType<typeof world>, a: { acme: { id: string; recordId: string }; quiet: { id: string }; pat: { recordId: string }; dealRow: string; deal: string; icp: string; audience: string }, shape: (t: string) => Shape) {
  const { db, A, ada, rex } = w;
  const mo = await db.insert("users", { orgId: A, clerkUserId: "clerk_mo", email: "mo@acme.example", name: "Mo", role: "rep", isActive: true, createdAt: 1 });
  await db.insert("rolePermissions", { orgId: A, role: "rep", rules: [{ object: "note", visibility: "own" }], updatedAt: 1, updatedBy: ada });
  const at = { createdAt: 1, updatedAt: 1 };
  // A deal page with plays, so the keeper checks A's plays (and would check the copy's, were they not paused).
  await db.insert("recipeEnablements", { orgId: A, point: "deal.page", recipeId: "fsgtm-enterprise-deal", contributionKey: "page", enabled: true, by: ada, at: 1 });
  const agent = await db.insert("agents", {
    orgId: A, slug: "fit", label: "Fit checker", kind: "hosted", ownerUserId: ada, ledgerKey: "agent:fit", fieldSlugs: ["fit"],
    budget: { turnsPerDay: 50, maxRounds: 4, maxTokens: 100_000, maxSeconds: 60 }, route: { audienceId: a.audience }, crmTrigger: { event: "deal.stage_changed" }, slack: { mode: "all" }, createdBy: ada, ...at,
  });
  await db.insert("agentWebhooks", { orgId: A, agentId: agent, secret: "sealed", rotatedBy: ada, rotatedAt: 1 });
  await db.insert("agentGrants", { orgId: A, agentId: agent, operation: "set_field", entityType: "account", attribute: "custom.fit", expiresAt: 9e15, signature: "sig", createdBy: ada, createdAt: 1 });
  const spend = { modelCalls: 0, tokens: 0, pagesRead: 0, ms: 0 };
  const turns = {
    queued: await db.insert("agentTurns", { orgId: A, agentId: agent, trigger: "crm_event", eventKey: `deal.stage_changed:${a.dealRow}@3`, status: "queued", admitted: true, payload: JSON.stringify({ event: "deal.stage_changed", deal: { id: a.dealRow } }), subject: {}, outputs: [], spend, dispatchedAt: 2, createdAt: 2, updatedAt: 2 }),
    // A sender's payload holds a hash shaped like an id: free text, kept as written.
    done: await db.insert("agentTurns", { orgId: A, agentId: agent, trigger: "webhook", eventKey: "evt_1", status: "done", admitted: true, payload: JSON.stringify({ md5: "0123456789abcdef0123456789abcdef" }), subject: { domain: "acme.example" }, account: { recordId: a.acme.recordId, entityId: a.acme.id, name: "Acme", domain: "acme.example" }, outputs: [{ fieldSlug: "fit", label: "Fit", status: "proposed", value: "yes", reason: `Seen on deal ${a.dealRow}` }], spend, createdAt: 1, updatedAt: 1 }),
  };
  const research = await db.insert("researchAgents", { orgId: A, slug: "fit", label: "Fit", entityType: "account", kind: "qa", question: "Do they sell payments?", agentId: agent, refreshCadence: "weekly", refreshNextAt: 1, createdBy: ada, ...at });
  const run = await db.insert("researchRuns", { ...(synthesize(shape("researchRuns"), { organizations: A, users: ada, researchAgents: research }) as Record<string, unknown>), scope: { entity: "account", filter: { icpId: a.icp } }, status: "running", cursor: "scan-cursor", sample: [{ recordId: a.acme.recordId, entityId: a.acme.id, label: "Acme", status: "answered" }] });
  await db.insert("researchTraces", { orgId: A, runId: run, recordId: a.acme.recordId, label: "Acme", status: "answered", steps: [{ kind: "read", url: "https://acme.example", ok: true }], ms: 1, calls: 1, model: "m", promptVersion: "1", at: 1 });
  await db.insert("researchAttempts", { orgId: A, agentId: research, entityId: a.quiet.id, attemptedAt: 1 });

  const sender = await db.insert("linkedinAccounts", synthesize(shape("linkedinAccounts"), { organizations: A, users: rex }) as Record<string, unknown>);
  const conversations = {
    email: await db.insert("conversations", { orgId: A, ownerUserId: ada, channel: "email", accountRef: `emaillog:${ada}`, externalThreadId: "t1", counterpart: { email: "pat@acme.example", name: "Pat" }, subject: "Pricing", contactIds: [a.pat.recordId], lastMessageAt: 6_000, extractDueAt: 1, ...at }),
    linkedin: await db.insert("conversations", { orgId: A, ownerUserId: rex, channel: "linkedin", accountRef: sender, externalThreadId: "c1", counterpart: { providerId: "p1", name: "Pat" }, contactIds: [a.pat.recordId], lastMessageAt: 6_000, extractDueAt: 1, ...at }),
  };
  await db.insert("conversationMessages", { orgId: A, conversationId: conversations.email, externalMessageId: "<m1@acme.example>", direction: "in", at: 6_000, from: "pat@acme.example", text: `About deal ${a.dealRow}: send the quote`, subject: "Pricing", logged: "bcc" });
  await db.insert("conversationMessages", { orgId: A, conversationId: conversations.linkedin, externalMessageId: `local-linkedin-${conversations.linkedin}-0`, direction: "in", at: 6_000, from: "Pat", text: "Let's talk" });
  for (const c of Object.values(conversations)) await db.insert("conversationContacts", { orgId: A, contactId: a.pat.recordId, conversationId: c });

  // What Salesforce said about Acme's parent: it stays with the CRM connection.
  await db.insert("parentDisagreements", { orgId: A, accountId: a.acme.recordId, provider: "salesforce", crmRef: "salesforce:001A", crmParentId: null, seenAt: 1 });
  const fact = db.rows("facts").find((f) => f.orgId === A)!._id as string;
  const call = mint();
  const cadence = await db.insert("linkedinCadences", synthesize(shape("linkedinCadences"), { organizations: A, users: rex, linkedinAccounts: sender }) as Record<string, unknown>);
  const source = (kind: string, id: string, extra = {}) => ({ kind, id, quote: "they need it", support: "buyer", ...extra });
  const state = { ...(synthesize(shape("dealPlays").fields!.state, { users: ada }) as Record<string, unknown>), qualification: [{ key: "pain", group: "why", label: "Pain", status: "established", text: "Named in the email", sources: [source("fact", fact), source("email", conversations.email, { ownerUserId: ada }), source("deal", `${a.deal}:stages`), source("call", call)] }] };
  const running = { status: "running", startedAt: 1, startedBy: ada };
  const play = await db.insert("dealPlays", { orgId: A, dealId: a.dealRow, streamId: a.deal, context: "Payments for retailers", research: running, stateRun: running, stateDueAt: 1, state, peopleResearch: { ...running, contactIds: [a.pat.recordId], runIds: [run] }, linkedin: [{ senderAccountId: sender, cadenceId: cadence }], createdBy: ada, ...at });
  const step = { orgId: A, playId: play, origin: "research", createdAt: 1 };
  await db.insert("dealPlaySteps", { ...step, title: "Invite Pat", channel: "linkedin", contactId: a.pat.recordId, state: "planned", queuedAt: 5, draft: { body: "Hi Pat", by: "keeper", at: 1 } });
  await db.insert("dealPlayItems", { ...(synthesize(shape("dealPlayItems"), { organizations: A, dealPlays: play }) as Record<string, unknown>), text: "They launched in Spain" });
  await db.insert("dealPlayPeople", { orgId: A, playId: play, contactId: a.pat.recordId, persona: "Champion", origin: "research", updatedAt: 1 });
  return { mo, eventAgent: agent, turns, research, run, play, conversations, call, sender };
}

/**
 * What sends or acts, each in its most dangerous state: an active rule whose trigger matches every company A ever
 * created, a routing rule on, a running approved launch with an enrollment due now, an approved unapplied plan with
 * a granted approval and an apply claim, one awaiting approval, an applied one, and a send in flight.
 */
async function buildActors(w: ReturnType<typeof world>, a: { dealRow: string; pat: { recordId: string } }, shape: (t: string) => Shape) {
  const { db, A, B, ada, rex } = w;
  const rule = await db.insert("automationRules", { orgId: A, name: "Tag new", object: "account", status: "active", trigger: { kind: "created" }, conditions: [], actions: [], createdBy: ada, activeSince: 1, startSeqs: {}, createdAt: 1, updatedAt: 1 } as never);
  await db.insert("operationAuditLog", { orgId: A, userId: ada, verb: "do", operation: "automation_rule.create", status: "applied", details: { ruleId: rule, name: "Tag new" }, createdAt: 1 });
  await db.insert("routingRules", { orgId: A, name: "East pod", method: "round_robin", assignees: [{ userId: rex }], isActive: true, createdAt: 1, updatedAt: 1 });
  // The sequences module is installed on both sides, so its launches are imported.
  for (const org of [A, B]) await db.insert("modulePackages", { ...(synthesize(shape("modulePackages"), { organizations: org }) as Record<string, unknown>), moduleId: SEQUENCES, status: "installed" });
  const launch = await db.insert("sequenceLaunches", { ...(synthesize(shape("sequenceLaunches"), { organizations: A, users: ada }) as Record<string, unknown>), moduleId: SEQUENCES, state: "active", authorizationEpoch: 3, approvedBy: ada });
  await db.insert("sequenceEnrollments", { ...(synthesize(shape("sequenceEnrollments"), { organizations: A, users: rex, sequenceLaunches: launch }) as Record<string, unknown>), moduleId: SEQUENCES, contactId: a.pat.recordId, state: "active" });
  const mailbox = await db.insert("emailAccounts", synthesize(shape("emailAccounts"), { organizations: A, users: ada }) as Record<string, unknown>);
  await db.insert("emailSends", { orgId: A, accountId: mailbox, userId: ada, contactId: a.pat.recordId, to: "pat@acme.example", subject: "Hi", state: "sending", at: 6_300 });
  const plan = (status: string, extra: Record<string, unknown> = {}) => db.insert("patchPlans", { orgId: A, createdBy: ada, verb: "set", operation: "deal.next_step", args: { dealId: a.dealRow, nextStep: "Call" }, status, riskLevel: "low", approvalRequirement: "required", createdAt: 6_400, updatedAt: 6_400, ...extra });
  const approved = await plan("approved", { approvedBy: ada, approvedAt: 6_500, approvedOperationIds: ["op1"], applyClaim: { id: "hosted:x", replica: "hosted", claimedAt: 6_600, expiresAt: 9e15 } });
  const pending = await plan("pending_approval");
  const applied = await plan("applied", { approvedBy: ada, approvedAt: 6_500, appliedBy: ada, appliedAt: 6_700 });
  await db.insert("patchOperations", { orgId: A, patchPlanId: approved, objectType: "deal", objectId: a.dealRow, fieldOrAction: "nextStep", beforeValue: null, afterValue: "Call", riskLevel: "low", approvalRequirement: "required", status: "pending", packageOpId: "op1", createdAt: 6_400, updatedAt: 6_400 });
  await db.insert("approvalRequests", { orgId: A, patchPlanId: approved, requestedBy: rex, status: "approved", decidedBy: ada, decidedAt: 6_500, createdAt: 6_400, updatedAt: 6_500 });
  await db.insert("approvalRequests", { orgId: A, patchPlanId: pending, requestedBy: rex, status: "pending", createdAt: 6_400, updatedAt: 6_400 });
  return { rule, launch, plans: { approved, pending, applied } };
}

/** A value for each field of `s`: refs to rows of A (`ids`), the first fitting union member, and no optional fields but refs. */
function synthesize(s: Shape, ids: Record<string, string>, key = ""): unknown {
  switch (s.kind) {
    case "id": return ids[s.tableName!];
    case "string": return key || "text";
    case "float64": return 1;
    case "int64": return BigInt(1);
    case "boolean": return true;
    case "null": return null;
    case "literal": return s.value;
    case "any": return { note: "free-form" };
    case "array": return [];
    case "record": return {};
    case "union": {
      for (const m of s.members ?? []) { const v = synthesize(m, ids, key); if (v !== undefined) return v; }
      return undefined;
    }
    case "object": {
      const o: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(s.fields ?? {})) {
        if (f.optional && !(f.kind === "id" && ids[f.tableName!])) continue;
        const v = synthesize({ ...f, optional: false }, ids, k);
        if (v === undefined) return undefined;
        o[k] = v;
      }
      return o;
    }
    default: return undefined;
  }
}

/** One row in every imported table A has none of, in import order, so each row's refs name rows that exist. */
async function synthesizeRest(db: Db, A: string, seed: Record<string, string>) {
  const real = Object.fromEntries(Object.keys(IMPORT_TABLES).filter((t) => tables[t]).map((t) => [t, shapeOf(tables[t].validator as Record<string, unknown>)]));
  const ids: Record<string, string> = { organizations: A, ...seed };
  for (const t of importOrder(real)) {
    const have = db.rows(t).find((r) => (r.orgId ?? r.ws) === A);
    if (have) { ids[t] ??= have._id as string; continue; }
    if (!real[t] || IMPORT_TABLES[t].kind !== "rows") continue;
    const row = synthesize(real[t], { ...ids, users: seed.users }) as Record<string, unknown> | undefined;
    assert.ok(row, `a row for ${t}`);
    ids[t] = await db.insert(t, row);
  }
}

async function settleDealHistory(db: Db, orgId: string) {
  for (let i = 0; i < 20 && (await handlers.dealHistory.step.handler(ctxOf(db), { orgId })).more; i++);
}

function exportTransport(db: Db, key: string): Transport {
  const ctx = ctxOf(db);
  return {
    plan: async () => ({ ...(await T.exportPlan.handler(ctx, { key })), source: { appCommit: null, dataEpoch: 1, minEpoch: 0 } }),
    page: (args) => T.exportPage.handler(ctx, { key, ...args }),
    registerInfo: () => T.exportRegisterInfo.handler(ctx, { key }),
    register: (args) => T.exportRegister.handler(ctx, { key, ...args }),
  };
}

/** The import route's operations over the real handlers, each call one transaction. `fail` throws on the nth call. */
function importTransport(db: Db, key: string, fail?: { at: number }): ImportTransport {
  const ctx = ctxOf(db);
  let calls = 0;
  const tx = async <R>(fn: () => Promise<R>) => {
    if (fail && ++calls === fail.at) throw new Error("connection lost");
    return atomic(db, fn);
  };
  return {
    plan: async () => ({ ...(await I.importPlan.handler(ctx, { key })), refusals: [] }),
    begin: (a) => tx(() => I.begin.handler(ctx, { key, ...a })),
    users: (a) => tx(() => I.importUsers.handler(ctx, { key, ...a })),
    page: (a) => tx(() => I.importPage.handler(ctx, { key, ...a })),
    register: (a) => tx(() => I.importRegister.handler(ctx, { key, ...a })),
    finish: (a) => tx(() => I.finish.handler(ctx, { key, ...a })),
  };
}

const sink = () => { const files = new Map<string, Uint8Array>(); return { files, add: (p: string, b: Uint8Array) => void files.set(p, b) }; };
async function exportOf(db: Db, clerk: string) {
  const { key } = await T.createExportKey.handler(ctxOf(db, clerk), {});
  const s = sink();
  const manifest = await exportWorkspace(exportTransport(db, key), s);
  return { files: s.files, manifest };
}
const importKey = async (db: Db, clerk = "clerk_ada_b") => (await I.createImportKey.handler(ctxOf(db, clerk), {})).key as string;

process.env.CANON_WORKSPACE_IMPORT = "on";
const SEQUENCES = "@canon/sequences";

/** Old id -> new, from the import's map, with the labels history keeps for ids the archive doesn't carry. */
function idMap(db: Db, extra: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(extra));
  for (const r of db.rows("workspaceImportIds")) map.set(r.oldId as string, r.newId as string);
  return map;
}
const remapText = (map: Map<string, string>) => {
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  return (value: unknown) => { let s = JSON.stringify(value); for (const k of keys) s = s.split(k).join(JSON.stringify(map.get(k)!).slice(1, -1)); return JSON.parse(s); };
};
const strip = ({ _id, _creationTime, orgId, ws, lastReadAt, seq, shard, ...rest }: Record<string, unknown>) => (void _id, void _creationTime, void orgId, void ws, void lastReadAt, void seq, void shard, rest);
/** JSON with every object's keys sorted, so rows compare by value whatever order their fields were written in. */
const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : typeof v === "bigint" ? `${v}n` : v));

/** The paths where two values differ, with both sides, so a failure says where. */
function differences(x: unknown, y: unknown, path = ""): string[] {
  if (JSON.stringify(x) === JSON.stringify(y)) return [];
  if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) === !Array.isArray(y)) {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...keys].flatMap((k) => differences((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return [`${path}: ${JSON.stringify(x)?.slice(0, 160)} != ${JSON.stringify(y)?.slice(0, 160)}`];
}
/** A value made inside the Convex sandbox, as plain data of this realm, so deepEqual compares it by value. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
const of = (db: Db, table: string, org: string) => db.rows(table).filter((r) => (r.orgId ?? r.ws) === org);

test("an exported workspace imports into an empty one and exports back the same, through the id map", async () => {
  const w = world();
  const a = await buildA(w);
  const { db, A, B, rex } = w;
  const before = await exportOf(db, "clerk_ada");
  assert.ok(of(db, "ledgerEntries", A).filter((e) => e.streamId === a.note.streamId).length > 1000, "a stream longer than the fold cap");

  const started = Date.now();
  const key = await importKey(db);
  const dry = await planImport(before.files, { ...(await I.importPlan.handler(ctxOf(db), { key })), refusals: [] });
  assert.deepEqual(dry.report.unmapped, []);
  const report = await importWorkspace(importTransport(db, key), before.files);
  assert.deepEqual([...report.refusals, ...report.unmapped], []);
  await settleDealHistory(db, B);
  const after = await exportOf(db, "clerk_ada_b");
  const map = idMap(db, { [A]: B, [a.agent]: foreignLabel(a.agent), [a.grant]: foreignLabel(a.grant), [a.call]: foreignLabel(a.call), [a.sender]: foreignLabel(a.sender) });
  const mapped = remapText(map);
  const seconds = (Date.now() - started) / 1000;

  // 1. Every imported section has the same rows, less those the report says it left out; streams by object and lifecycle match.
  const imported = Object.keys(IMPORT_TABLES).filter((t) => before.manifest.sections[t]);
  const leftOut = (t: string) => Object.values(report.sections.find((x) => x.section === t)?.notWritten ?? {}).reduce((n, k) => n + k, 0);
  for (const t of imported) assert.equal(after.manifest.sections[t]?.count ?? 0, before.manifest.sections[t].count - leftOut(t), t);
  assert.deepEqual(report.sections.find((x) => x.section === "notificationEmail")?.notWritten, { "module moduleId": 1 });
  assert.equal(report.sections.find((x) => x.section === "parentDisagreements")?.status, "not imported yet");
  // Rows that need a connection of the source deployment, which never moves, are left out and counted.
  const needs = Object.fromEntries(["linkedinCadences", "linkedinEnrollments", "dialerCalls", "feedItems", "emailSends"].map((t) => [t, report.sections.find((x) => x.section === t)?.notWritten]));
  assert.deepEqual(needs, { linkedinCadences: { "needs linkedinAccounts": 1 }, linkedinEnrollments: { "needs linkedinCadences": 1 }, dialerCalls: { "needs dialerSessions": 1 }, feedItems: { "needs connectorLinks": 1 }, emailSends: { "needs emailAccounts": 1 } });
  // A play's LinkedIn cadences name a sender connected on the source, which never moves.
  assert.deepEqual(report.sections.find((x) => x.section === "dealPlays")?.cleared, { linkedinAccounts: 1 });
  // Every row of every table imported as rows equals A's through the id map, but what ROW_EXCEPTIONS says differs and why.
  const leftIds = new Set(db.rows("workspaceImportIds").filter((r) => r.newId === "\u0000skipped").map((r) => r.oldId));
  for (const t of imported.filter((t) => IMPORT_TABLES[t].kind === "rows" || IMPORT_TABLES[t].kind === "facts")) {
    // A table that can act arrives through its arrival (actors.ts), the only declared difference: B holds exactly
    // what that arrival makes of A's row, at the clock and ledger heads B's row was stamped with.
    const arrival = IMPORT_TABLES[t].arrive;
    const expect = (r: Record<string, unknown>) => {
      const row = mapped(strip(r));
      for (const k of Object.keys(IMPORT_TABLES[t].local ?? {})) delete row[k];
      if (!arrival) return row;
      const twin = of(db, t, B).find((x) => x._id === map.get(r._id as string))!;
      // The clock B's row was stamped with, wherever its arrival keeps it.
      const now = [twin.activeSince, (twin.pause as { at?: number })?.at, (twin.keeperPaused as { at?: number })?.at, (twin.refreshHold as { at?: number })?.at].find((x) => typeof x === "number") as number;
      return arrive(t, arrival, row, { now, heads: twin.startSeqs as Record<string, number> });
    };
    const sorted = (rows: Record<string, unknown>[]) => rows.map(canonical).sort();
    assert.deepEqual(sorted(of(db, t, B).map(strip)), sorted(of(db, t, A).filter((r) => !leftIds.has(r._id as string)).map(expect)), t);
  }
  // The arrivals in the source's terms: the launch paused under a new epoch, the rule paused from the end of the import.
  const heads = Object.fromEntries(of(db, "ledgerShardHeads", B).map((h) => [String(h.shard), h.seq]));
  const ruleB = of(db, "automationRules", B)[0];
  assert.deepEqual(plain([ruleB.status, ruleB.startSeqs, ruleB.nextSlotAt ?? null]), ["paused", heads, null]);
  assert.deepEqual(of(db, "sequenceLaunches", B).map((l) => [l.state, l.authorizationEpoch]), [["paused", 4]]);
  assert.deepEqual(of(db, "patchPlans", B).map((p) => `${p.operation}:${p.status}`).sort(), ["canon.propose_facts:pending_approval", "deal.next_step:applied", "deal.next_step:cancelled", "deal.next_step:cancelled"]);
  // Field values and contested fields resolve the same, and the review queue lists the same proposals and contests.
  const states = (org: string, f = (x: unknown) => x) => of(db, "canonFieldState", org).map((r) => { const { updatedAt: _u, ...rest } = strip(r); void _u; return canonical(f(rest)); }).sort();
  assert.deepEqual(states(B), states(A, mapped));
  assert.ok(of(db, "canonFieldState", A).some((r) => r.state === "contested"), "a contested field");
  const queue = async (clerk: string) => (await W["canonGate.ts"].reviewQueue.handler(ctxOf(db, clerk), {})) as { proposed: unknown[]; contested: unknown[] };
  const qa = await queue("clerk_ada"), qb = await queue("clerk_ada_b");
  assert.equal(qa.proposed.length, 1);
  assert.equal(qa.contested.length, 1);
  // Fit: the import queues a rescore, and B's register is scored by the same ICP gates and weights as A's.
  const fitA = await rescore(db, A), fitB = await rescore(db, B);
  assert.ok((fitA as { gates: unknown[] }).gates.length, "an ICP gate");
  assert.deepEqual(differences(fitB, mapped(fitA)), []);
  // The proposal names its plan, so the queue says which agent label it came "via".
  assert.equal((qb.proposed[0] as { actor: { via: unknown } }).actor.via, "researcher");
  assert.deepEqual(differences(qb, mapped(qa)), []);
  const lifecycles = (org: string) => of(db, "recordRows", org).map((r) => `${r.object}:${(r.lifecycle as { status: string }).status}`).sort();
  assert.deepEqual(lifecycles(B), lifecycles(A));
  assert.ok(lifecycles(A).includes("account:merged") && lifecycles(A).includes("task:deleted"));

  // 2. Every stream has the same versions, and folds and projects to the same values.
  for (const ra of of(db, "recordRows", A)) {
    const rb = of(db, "recordRows", B).find((r) => r.streamId === map.get(ra.streamId as string));
    assert.ok(rb, `stream ${ra.object} ${ra.streamId}`);
    assert.deepEqual(differences(strip(rb), mapped(strip(ra))), [], `${ra.object} ${ra.title}`);
    const versions = (org: string, s: unknown) => of(db, "ledgerEntries", org).filter((e) => e.streamId === s).map((e) => e.version).sort((x, y) => (x as number) - (y as number));
    assert.deepEqual(versions(B, rb.streamId), versions(A, ra.streamId));
  }
  // 3. The register matches by id, with ids derived from a stream remapped.
  for (const t of ["fakeRecordAccounts", "fakeRecordContacts", "fakeRecordHistory"]) {
    const sorted = (rows: Record<string, unknown>[]) => rows.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    assert.deepEqual(differences(sorted(of(db, t, B).map(strip)), sorted(of(db, t, A).map((r) => mapped(strip(r))))), [], t);
  }
  assert.ok(of(db, "fakeRecordAccounts", B).some((r) => r.recordId === map.get(a.quiet.recordId) && r.recordId !== a.quiet.recordId), "an acc_s_ id follows its new stream");
  // 4. The same edges, by association, ends, label, primary and active.
  const edgeSet = (org: string) => of(db, "associations", org).map((e) => JSON.stringify([e.association, e.fromId, e.toId, e.label, e.primary, e.active])).sort();
  assert.deepEqual(edgeSet(B), edgeSet(A).map((e) => JSON.stringify(mapped(JSON.parse(e)))).sort());
  assert.ok(of(db, "associations", A).some((e) => e.label), "an edge with a label");
  // 5. The custom object's definition and its record.
  assert.deepEqual(differences(strip(of(db, "objectDefs", B).find((d) => d.apiName === a.widget)!), strip(of(db, "objectDefs", A).find((d) => d.apiName === a.widget)!)), []);
  assert.equal(of(db, "recordRows", B).find((r) => r.object === a.widget)?.title, "Gizmo");
  // 6. Deal history: as many versions, and the same deal as of three times.
  const versionsOf = (org: string) => of(db, "dealVersions", org);
  assert.equal(versionsOf(B).length, versionsOf(A).length);
  for (const at of [3_500, 4_500, 99_000]) {
    const asOf = (org: string) => versionsOf(org).find((r) => (r.validFrom as number) <= at && at < (r.validTo as number))?.fields;
    assert.ok(asOf(A), `a version as of ${at}`);
    assert.deepEqual(differences(asOf(B), mapped(asOf(A))), [], `as of ${at}`);
  }
  // The workspace's settings, and the deal's company under its new stream.
  const org = db.rows("organizations").find((o) => o._id === B)!;
  assert.deepEqual([org.defaultCurrency, org.timezone, org.fiscalYearStartMonth, org.slug], ["EUR", "Europe/Paris", 2, "acme-new"]);
  assert.equal(of(db, "deals", B)[0].companyId, map.get(a.quiet.recordId));
  // 7. Owners are members here: Rex arrives as an inactive placeholder, never an admin.
  const owner = of(db, "users", B).find((u) => u._id === map.get(rex))!;
  assert.deepEqual([owner.email, owner.isActive, owner.role, String(owner.clerkUserId).startsWith("member:")], ["rex@acme.example", false, "rep", true]);
  assert.equal((of(db, "recordRows", B).find((r) => r.object === "deal")!.values as Record<string, unknown>).ownerId, owner._id);
  assert.equal(of(db, "users", B).filter((u) => u.role === "admin" && u.isActive).length, 1);
  // A merged company can still be un-merged: its merge record names the new streams, and the loser's stream takes the unmerge.
  const merge = of(db, "recordMerges", B)[0];
  assert.equal(merge.survivorStream, map.get(a.acme.id));
  assert.equal(JSON.parse(merge.undo as string).losers[0].stream, map.get(a.dupe.id));
  const ctx = ctxOf(db);
  const un = await save(objects.convexObjectStore(ctx), { orgId: B, def: await orgDefs.loadOrgObject(ctx, B, "account"), source: { kind: "user", ref: `user:${w.adaB}` }, actor: { kind: "user", id: w.adaB }, now: 10_000 }, { op: "unmerge", streamId: map.get(a.dupe.id)! });
  assert.equal(un.status, "applied");
  // 8. Nothing sends: no connections or grants arrive, and every switch the archive brought is off.
  for (const t of ["linkedinEnrollments", "integrations", "emailAccounts", "emailSends", "agentGrants", "moduleGrants"]) assert.equal(of(db, t, B).length, 0, t);
  assert.deepEqual(plain(report.gates?.filter((g) => g.open)), []);
  // 9. No source id is left anywhere in B's archive.
  const text = [...after.files].filter(([p]) => p.startsWith("sections/")).map(([, b]) => gunzipSync(b).toString("utf8")).join("\n");
  const left = [...map.keys()].filter((old) => old !== map.get(old) && text.includes(old));
  assert.deepEqual(left, [], "source ids in the imported workspace");
  console.log(`round trip: ${Object.values(before.manifest.sections).reduce((n, s) => n + s.count, 0)} rows in ${seconds.toFixed(2)} s`);
});

test("an import writes only the key's workspace, and an untrusted file can't reach another one or a table the importer doesn't write", async () => {
  const w = world();
  await buildA(w);
  const { db, B, C } = w;
  const { files } = await exportOf(db, "clerk_ada");
  const before = new Set(Object.keys(tables).flatMap((t) => db.rows(t).map((r) => r._id)));
  const key = await importKey(db);
  await importWorkspace(importTransport(db, key), files);
  for (const t of Object.keys(tables)) {
    for (const r of db.rows(t).filter((r) => !before.has(r._id))) {
      const org = r.orgId ?? r.ws;
      if (org !== undefined) assert.equal(org, B, `${t} row written outside the workspace`);
    }
  }
  // A table the importer doesn't write is refused, whatever the archive holds; so is a row naming another workspace.
  const ctx = ctxOf(db);
  await assert.rejects(I.importPage.handler(ctx, { key, section: "integrations", offset: 0, rows: [JSON.stringify({ _id: mint(), orgId: { $ref: "organizations", id: C } })] }), /not a section this import writes|No import is running/);
  const fresh = world();
  await buildA(fresh);
  const archive = await exportOf(fresh.db, "clerk_ada");
  const k = await importKey(fresh.db);
  const tamper = new Map(archive.files);
  const manifest = JSON.parse(Buffer.from(tamper.get("manifest.json")!).toString("utf8"));
  const part = manifest.sections.deals.parts[0];
  const rows = gunzipSync(tamper.get(part.file)!).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  rows[0].orgId = { $ref: "organizations", id: fresh.C };
  rows[0].isAdmin = true;
  const gz = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  tamper.set(part.file, gz);
  part.sha256 = createHash("sha256").update(gz).digest("hex");
  tamper.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const plan = { ...(await I.importPlan.handler(ctxOf(fresh.db), { key: k })), refusals: [] };
  const dry = await planImport(tamper, plan);
  assert.deepEqual(dry.report.unmapped.map((u) => [u.table, u.field]).sort(), [["deals", "isAdmin"], ["deals", "orgId"]]);
  await assert.rejects(importWorkspace(importTransport(fresh.db, k), tamper), /Import refused/);
  assert.equal(of(fresh.db, "deals", fresh.B).length, 0, "nothing written");
  // Convex refuses the page too, whatever the CLI sends.
  await atomic(fresh.db, () => I.begin.handler(ctxOf(fresh.db), { key: k, digest: "0".repeat(64), sourceWorkspaceId: fresh.A, registerRows: 0 }));
  await assert.rejects(I.importPage.handler(ctxOf(fresh.db), { key: k, section: "deals", offset: 0, rows: [JSON.stringify(rows[0])] }), /can't map/);
});

test("only a person who is an admin creates an import key, an export key never imports, and the key's admin must still hold the right", async () => {
  const { db } = world();
  assert.ok("api.workspaceImport.createImportKey" in gtmHumanOnlyFunctions);
  await assert.rejects(I.createImportKey.handler(ctxOf(db, "clerk_carl"), {}), /Your role can't do this/);
  process.env.CANON_SERVICE_JWT_ISSUER = "https://canon.example";
  try {
    const agentCtx = { ...ctxOf(db), auth: { getUserIdentity: async () => ({ ...identity("clerk_ada_b"), issuer: "https://canon.example", azp: "canon-cli" }) } };
    await assert.rejects(I.createImportKey.handler(agentCtx, {}), /Only a person imports/);
  } finally {
    delete process.env.CANON_SERVICE_JWT_ISSUER;
  }
  const { key: exportKey } = await T.createExportKey.handler(ctxOf(db, "clerk_ada_b"), {});
  await assert.rejects(I.importPlan.handler(ctxOf(db), { key: exportKey }), /unknown or has expired/);
  const key = await importKey(db);
  const adaB = db.rows("users").find((u) => u.clerkUserId === "clerk_ada_b")!;
  await db.patch(adaB._id, { role: "rep" });
  await assert.rejects(I.importPlan.handler(ctxOf(db), { key }), /can no longer import/);
  delete process.env.CANON_WORKSPACE_IMPORT;
  try {
    await db.patch(adaB._id, { role: "admin" });
    await assert.rejects(I.importPlan.handler(ctxOf(db), { key }), /not switched on/);
  } finally {
    process.env.CANON_WORKSPACE_IMPORT = "on";
  }
});

test("a dry run writes nothing and reports what an import would do; an interrupted import resumes to the same workspace", async () => {
  const w = world();
  const a = await buildA(w);
  const { db, B } = w;
  const { files } = await exportOf(db, "clerk_ada");
  const key = await importKey(db);
  const count = () => db.rows("workspaceImportIds").length + of(db, "ledgerEntries", B).length + of(db, "users", B).length;
  const was = count();
  const dry = await importWorkspace(importTransport(db, key), files, { dryRun: true });
  assert.equal(count(), was);
  assert.ok(dry.sections.some((s) => s.section === "ledgerEntries" && s.status === "import"));
  assert.ok(dry.sections.some((s) => s.status === "not imported yet"), "tables left for later are named");
  assert.deepEqual(dry.users.map((u) => [u.email, u.as]).sort(), [["ada@acme.example", "you"], ["mo@acme.example", "placeholder"], ["rex@acme.example", "placeholder"]]);
  // Lose the connection part way through, twice, then finish.
  for (const at of [7, 25]) await assert.rejects(importWorkspace(importTransport(db, key, { at }), files), /connection lost/);
  await importWorkspace(importTransport(db, key), files);
  const clean = world();
  await buildA(clean);
  await importWorkspace(importTransport(clean.db, await importKey(clean.db)), (await exportOf(clean.db, "clerk_ada")).files);
  for (const t of ["users", "canonEntities", "ledgerEntries", "recordRows", "associations", "canonExternalIds", "fakeRecordAccounts", "deals", "observations", "facts", "canonFieldState", "savedViews", "reports", "audienceMembers"]) {
    assert.equal(of(db, t, B).length, of(clean.db, t, clean.B).length, t);
  }
  assert.equal(of(db, "ledgerEntries", B).filter((e) => e.streamId === idMap(db).get(a.note.streamId)).length, of(db, "ledgerEntries", w.A).filter((e) => e.streamId === a.note.streamId).length);
  await assert.rejects(importWorkspace(importTransport(db, key), (await exportOf(db, "clerk_ada")).files), /another archive/);
});

test("the import order puts every table after the tables it references, and writes only data and ledger tables", () => {
  const real = Object.fromEntries(Object.keys(IMPORT_TABLES).filter((t) => tables[t]).map((t) => [t, shapeOf(tables[t].validator as Record<string, unknown>)]));
  const order = importOrder(real);
  for (const [i, t] of order.entries()) for (const dep of dependenciesOf(t, real[t])) assert.ok(order.indexOf(dep) < i, `${t} comes before ${dep}`);
  for (const t of Object.keys(IMPORT_TABLES)) if (!t.startsWith("register.")) assert.ok(exported(entryOf(t)), `${t} is a data or ledger table`);
});

test("every data table is imported or deferred with a reason, never both, so none is left behind silently", () => {
  const data = Object.keys(ARCHIVE_TABLES).filter((t) => exported(entryOf(t)));
  assert.deepEqual(data.filter((t) => !(t in IMPORT_TABLES) && !DEFERRED[t]), [], "neither imported nor deferred");
  assert.deepEqual(Object.keys(DEFERRED).filter((t) => t in IMPORT_TABLES || !data.includes(t)), [], "deferred but imported, or not an exported table");
});

test("nothing in the imported workspace acts, an actor made here stops the import, and a rule turned on here acts only on what happens next", async () => {
  const w = world();
  const a = await buildA(w);
  const { db, A, B } = w;
  const { files } = await exportOf(db, "clerk_ada");
  const key = await importKey(db);
  // A rule made here before the import: replayed history would reach it, so the import doesn't start.
  const rule = await db.insert("automationRules", { orgId: B, name: "Here", object: "account", status: "active", trigger: { kind: "created" }, conditions: [], actions: [], createdBy: w.adaB, activeSince: 0, startSeqs: {}, createdAt: 1, updatedAt: 1 } as never);
  await assert.rejects(importWorkspace(importTransport(db, key), files), /active automation rule/);
  db.patch(rule, { status: "paused" });
  // An endpoint made part way through stops the next page; turning it off lets the import resume to the end.
  const transport = importTransport(db, key);
  let pages = 0, hook = "";
  const page = transport.page;
  transport.page = async (args) => {
    if (++pages === 3) hook = await db.insert("recordWebhookEndpoints", { orgId: B, url: "https://hooks.example", enabled: true, cursors: {}, createdBy: w.adaB, createdAt: 1, updatedAt: 1 } as never);
    return page(args);
  };
  await assert.rejects(importWorkspace(transport, files), /live record webhook/);
  db.patch(hook, { enabled: false });
  const report = await importWorkspace(importTransport(db, key), files);
  const ids = idMap(db);
  assert.deepEqual(plain(report.gates?.filter((g) => g.open)), []);
  assert.deepEqual(db.rows("workspaceImportIds").filter((r) => String(r.table) in DEFERRED).map((r) => r.table), [], "nothing deferred is written");

  // The workers, as their crons call them: the sweep wakes no fan-out for B, and a fan-out finds no rule to run.
  const scheduled: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const ctx = { ...ctxOf(db), scheduler: { runAfter: async (_ms: number, fn: unknown, args: Record<string, unknown>) => void scheduled.push({ fn: String(fn), args }) } };
  await Auto.sweep.handler(ctx, {});
  assert.deepEqual(scheduled.filter((s) => s.args.orgId === B || s.args.ruleId === ids.get(a.rule)), []);
  await Auto.fanout.handler(ctx, { orgId: B });
  assert.equal(of(db, "automationRuns", B).length, 0, "no rule ran on the history");
  // The plan approved on A can't be applied or approved again here: it is cancelled, with the reason.
  const asAdaB = ctxOf(db, "clerk_ada_b");
  const plan = ids.get(a.plans.approved)!;
  assert.match(String(of(db, "patchPlans", B).find((p) => p._id === plan)?.error), /approval given there doesn't carry over/);
  await assert.rejects(Plans.claimHostedApply.handler(asAdaB, { patchPlanId: plan }), /must be approved/);
  await assert.rejects(Plans.approve.handler(asAdaB, { patchPlanId: plan, decision: "approved" }), /cancelled/);

  // An admin turns the imported rule on: it acts on the next company created, and on nothing the archive brought.
  const imported = ids.get(a.rule)!;
  await Auto.setStatus.handler(asAdaB, { id: imported, status: "active" });
  await Auto.fanout.handler(ctx, { orgId: B });
  assert.equal(of(db, "automationRuns", B).length, 0, "turning it on runs nothing on the history");
  const store = objects.convexObjectStore(ctx);
  const fresh = await save(store, { orgId: B, def: await orgDefs.loadOrgObject(ctx, B, "account"), source: { kind: "user", ref: `user:${w.adaB}` }, actor: { kind: "user", id: w.adaB }, now: Date.now() }, { op: "create", values: { name: "Fresh Co" } });
  await Auto.fanout.handler(ctx, { orgId: B });
  assert.deepEqual(of(db, "automationRuns", B).map((r) => [r.ruleId, r.streamId]), [[imported, (fresh as { streamId: string }).streamId]]);
  assert.equal(of(db, "automationRuns", A).length, 0);
});

test("imported agents, research, plays and conversations act on nothing the archive brought until a person here turns each on", async () => {
  const w = world();
  const a = await buildA(w);
  const { db, A, B } = w;
  const report = await importWorkspace(importTransport(db, await importKey(db)), (await exportOf(db, "clerk_ada")).files);
  assert.deepEqual(plain(report.gates?.filter((g) => g.open)), []);
  const ids = idMap(db);
  const scheduled: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const ctx = { ...ctxOf(db), scheduler: { runAfter: async (_ms: number, fn: unknown, args: Record<string, unknown>) => void scheduled.push({ fn: String(fn), args }) } };
  const rowsOf = (org: string) => new Set(Object.keys(tables).flatMap((t) => of(db, t, org).map((r) => r._id as string)).concat(org));
  /** What the ticks scheduled or wrote for a workspace, as each job's function. */
  const jobsFor = (org: string) => { const own = rowsOf(org); return scheduled.filter((s) => Object.values(s.args).some((v) => own.has(v as string))).map((s) => s.fn); };
  const turnsB = () => of(db, "agentTurns", B).map((t) => t.status).sort();
  const was = { turns: turnsB(), runs: of(db, "researchRuns", B).length };
  process.env.TOKEN_ENCRYPTION_KEY = "test";
  try {
    // The ticks, as their crons call them. Each finds A's due rows, so each would act; none finds B's.
    const refreshes = await Agents["researchAgents.ts"].startDueRefreshes.handler(ctx, { now: Date.now() + 1e12 });
    assert.equal(refreshes.held, 1, "A's overdue field is looked at");
    assert.equal(await Agents["conversationExtract.ts"].startDue.handler(ctx, {}), 2, "A's two threads are due");
    const due = await Agents["dealPlays.ts"].duePlays.handler(ctx, { before: Date.now(), limit: 50 });
    assert.deepEqual(plain(due.map((p: { orgId: string }) => p.orgId)), [A]);
    const pat = ids.get(a.pat.recordId) ?? a.pat.recordId;
    assert.deepEqual(plain(await Agents["dealPlays.ts"].playsOfContact.handler(ctx, { orgId: B, contactId: pat })), []);
    // A new deal stage change here reaches the paused agent: its turn is recorded skipped, and nothing runs.
    const dealB = ids.get(a.dealRow)!;
    await Agents["agentTurns.ts"].crmEvent.handler(ctx, { orgId: B, dealId: dealB, version: 50, to: "Proposal" });
    assert.deepEqual(jobsFor(B), []);
    assert.deepEqual([turnsB(), of(db, "researchRuns", B).length], [[...was.turns, "skipped"].sort(), was.runs]);
    assert.ok(of(db, "researchAgents", B).every((r) => r.refreshNextAt === undefined) && of(db, "conversations", B).every((c) => c.extractDueAt === undefined));

    // An admin turns each back on. The agent runs on the next deal event only: the turns the archive brought stay skipped.
    const asAdaB = ctxOf(db, "clerk_ada_b");
    // Ada signs in to ChatGPT here, which an agent's turns run on: a plan is never in an archive.
    await db.insert("chatgptAuth", { userId: w.adaB, status: "connected", updatedAt: 1 });
    await Agents["agents.ts"].setPaused.handler(asAdaB, { agent: { agentId: ids.get(a.eventAgent)! }, paused: false });
    // A deal event here names no company (it reads the deal's CRM mirror account, which never moves), so the
    // resumed agent is woken by a verified webhook event, as one sent after its secret is rotated here.
    await Agents["agentTurns.ts"].receive.handler(ctx, { agentId: ids.get(a.eventAgent)!, eventKey: "evt_new", payload: "{}", subject: { domain: "acme.example" } });
    const fresh = of(db, "agentTurns", B).find((t) => t.eventKey === "evt_new")!;
    assert.deepEqual(plain([fresh.status, (fresh.skip as { message?: string } | undefined)?.message ?? null, jobsFor(B)]), ["queued", null, ["internal.agentTurnActions.runTurn"]]);
    assert.equal(scheduled.at(-1)!.args.turnId, fresh._id);
    assert.deepEqual(plain(of(db, "agentTurns", B).filter((t) => t._id !== fresh._id).map((t) => t.status).sort()), ["done", "skipped", "skipped"]);
    // The refresh starts a cadence from now, not from the source's schedule.
    await Agents["researchAgents.ts"].setRefresh.handler(asAdaB, { slug: "fit", cadence: "weekly" });
    assert.ok((of(db, "researchAgents", B)[0].refreshNextAt as number) > Date.now() + 6 * 86_400_000);
    // Running the keeper on the play (what Check now does first) puts it back on the daily check.
    await Agents["dealPlays.ts"].resumeKeeper.handler(ctx, { orgId: B, streamId: ids.get(a.deal)! });
    assert.deepEqual(plain((await Agents["dealPlays.ts"].duePlays.handler(ctx, { before: Date.now(), limit: 50 })).map((p: { orgId: string }) => p.orgId).sort()), [A, B].sort());
  } finally {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  }
});

test("a conversation's text is readable in the copy by exactly whom it was readable in the source", async () => {
  const w = world();
  const a = await buildA(w);
  const { db } = w;
  await importWorkspace(importTransport(db, await importKey(db)), (await exportOf(db, "clerk_ada")).files);
  const ids = idMap(db);
  // Mo's placeholder signs in here, as after an invitation: same role, and that role reads only Mo's own activity.
  db.patch(ids.get(a.mo)!, { isActive: true, clerkUserId: "clerk_mo_b" });
  const read = async (clerk: string, conversation: string) => {
    const t = await Agents["conversationView.ts"].thread.handler(ctxOf(db, clerk), { conversationId: conversation });
    return plain(t?.messages.map((m: { text?: string; hidden?: boolean }) => m.text ?? "hidden"));
  };
  const email = a.conversations.email, copy = ids.get(email)!;
  assert.deepEqual([await read("clerk_ada", email), await read("clerk_mo", email)], [[`About deal ${a.dealRow}: send the quote`], ["hidden"]]);
  assert.deepEqual([await read("clerk_ada_b", copy), await read("clerk_mo_b", copy)], [[`About deal ${ids.get(a.dealRow)}: send the quote`], ["hidden"]]);
  // The logged thread is Ada's here, and no account here lists the thread read from A's LinkedIn sender.
  const linkedin = of(db, "conversations", w.B).find((c) => c._id === ids.get(a.conversations.linkedin))!;
  assert.deepEqual([of(db, "conversations", w.B).find((c) => c._id === copy)!.accountRef, linkedin.accountRef], [`emaillog:${w.adaB}`, foreignLabel(a.sender)]);
});

/** The archive with `fn` applied to every row of `section`, its checksum and manifest made to match: a hand-built file. */
function tamper(files: Map<string, Uint8Array>, section: string, fn: (row: Record<string, any>) => void) {
  const out = new Map(files);
  const manifest = JSON.parse(Buffer.from(out.get("manifest.json")!).toString("utf8"));
  for (const part of manifest.sections[section].parts) {
    const rows = gunzipSync(out.get(part.file)!).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    rows.forEach(fn);
    const gz = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    out.set(part.file, gz);
    part.sha256 = createHash("sha256").update(gz).digest("hex");
  }
  out.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return out;
}

test("a hand-built archive whose rules are active, plans approved and launches running still arrives switched off", async () => {
  const w = world();
  await buildA(w);
  const { db, B, ada } = w;
  let files = (await exportOf(db, "clerk_ada")).files;
  files = tamper(files, "automationRules", (r) => Object.assign(r, { status: "active", activeSince: 0, startSeqs: {}, nextSlotAt: 1, pausedReason: undefined }));
  files = tamper(files, "routingRules", (r) => Object.assign(r, { isActive: true }));
  files = tamper(files, "patchPlans", (r) => Object.assign(r, { status: "approved", approvedBy: { $ref: "users", id: ada }, approvedAt: 1, applyClaim: { id: "cli:x", replica: "cli", claimedAt: 1, expiresAt: 9e15 } }));
  files = tamper(files, "approvalRequests", (r) => Object.assign(r, { status: "approved" }));
  files = tamper(files, "sequenceLaunches", (r) => Object.assign(r, { state: "active" }));
  files = tamper(files, "sequenceEnrollments", (r) => Object.assign(r, { state: "active" }));
  files = tamper(files, "agents", (r) => { delete r.pause; r.slack = { mode: "all" }; });
  files = tamper(files, "agentTurns", (r) => Object.assign(r, { status: "queued", dispatchedAt: 1 }));
  files = tamper(files, "researchAgents", (r) => Object.assign(r, { refreshCadence: "weekly", refreshNextAt: 1 }));
  files = tamper(files, "researchRuns", (r) => Object.assign(r, { status: "running" }));
  files = tamper(files, "dealPlays", (r) => { delete r.keeperPaused; Object.assign(r, { stateDueAt: 1, research: { status: "running", startedAt: 1, startedBy: { $ref: "users", id: ada } } }); });
  files = tamper(files, "dealPlaySteps", (r) => Object.assign(r, { queuedAt: 1 }));
  files = tamper(files, "conversations", (r) => Object.assign(r, { extractDueAt: 1 }));
  files = tamper(files, "dialerSettings", (r) => Object.assign(r, { record: true }));
  files = tamper(files, "recordingPolicy", (r) => Object.assign(r, { callRecording: true }));
  files = tamper(files, "hierarchyScans", (r) => Object.assign(r, { status: "reading" }));
  files = tamper(files, "hierarchyResearch", (r) => Object.assign(r, { status: "running" }));
  files = tamper(files, "fieldConsolidationRuns", (r) => Object.assign(r, { status: "applying" }));
  const report = await importWorkspace(importTransport(db, await importKey(db)), files);
  assert.deepEqual(plain(report.gates?.filter((g) => g.open)), []);
  assert.deepEqual(of(db, "automationRules", B).map((r) => [r.status, (r.activeSince as number) > 1, r.nextSlotAt]), [["paused", true, undefined]]);
  assert.deepEqual(of(db, "routingRules", B).map((r) => r.isActive), [false]);
  assert.deepEqual(of(db, "patchPlans", B).map((p) => [p.status, p.approvedBy, p.applyClaim]), Array(4).fill(["cancelled", undefined, undefined]));
  assert.deepEqual(of(db, "approvalRequests", B).map((r) => r.status), ["cancelled", "cancelled"]);
  assert.deepEqual([...of(db, "sequenceLaunches", B), ...of(db, "sequenceEnrollments", B)].map((r) => r.state), ["paused", "paused"]);
  assert.deepEqual(of(db, "agents", B).map((r) => [(r.pause as { reason: string }).reason, r.slack]), [["imported", undefined]]);
  assert.deepEqual(of(db, "agentTurns", B).map((r) => [r.status, r.dispatchedAt]), [["skipped", undefined], ["skipped", undefined]]);
  assert.deepEqual(of(db, "researchAgents", B).map((r) => [r.refreshCadence, r.refreshNextAt]), [[undefined, undefined]]);
  assert.deepEqual(of(db, "researchRuns", B).map((r) => r.status), ["cancelled"]);
  assert.deepEqual(of(db, "dealPlays", B).map((r) => [Boolean(r.keeperPaused), r.stateDueAt, (r.research as { status: string }).status]), [[true, undefined, "failed"]]);
  assert.deepEqual([...of(db, "dealPlaySteps", B), ...of(db, "conversations", B)].map((r) => r.queuedAt ?? r.extractDueAt ?? null), [null, null, null]);
  assert.deepEqual(plain([of(db, "dialerSettings", B)[0].record, of(db, "recordingPolicy", B)[0].callRecording, ...["hierarchyScans", "hierarchyResearch", "fieldConsolidationRuns"].map((t) => of(db, t, B)[0].status)]), [false, false, "failed", "failed", "failed"]);
  const dry = report.sections.filter((x) => x.arrives).map((x) => [x.section, x.arrives!.rows]).sort();
  assert.deepEqual(dry, [["agentTurns", 2], ["agents", 1], ["approvalRequests", 2], ["automationRules", 1], ["conversations", 2], ["dealPlaySteps", 1], ["dealPlays", 1], ["dialerSettings", 1], ["fieldConsolidationRuns", 1], ["hierarchyResearch", 1], ["hierarchyScans", 1], ["patchPlans", 4], ["recordingPolicy", 1], ["researchAgents", 1], ["researchRuns", 1], ["routingRules", 1], ["sequenceEnrollments", 1], ["sequenceLaunches", 1]]);
});

test("the census names every cron and route that can act, and every imported table with a switch arrives switched off or says why it is inert", () => {
  const read = (f: string) => readFileSync(new URL(`../convex/${f}`, import.meta.url), "utf8");
  const crons = [...read("crons.ts").matchAll(/internal\.(\w+)\.(\w+)/g)].map((m) => m[0]);
  const http = read("http.ts");
  const routes = [...http.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]).concat([...http.matchAll(/^(register\w+)\(http\)/gm)].map((m) => m[1]), http.includes("function ledgerFeedRoute") ? ["ledgerFeedRoute"] : []);
  const named = new Set([...CENSUS.flatMap((m) => m.runs), ...Object.keys(QUIET)]);
  assert.deepEqual([...crons, ...routes].filter((r) => !named.has(r)), [], "a cron or route the census doesn't name");
  // QUIET may name operator crons the public export leaves out; a mechanism's own entry point must exist.
  assert.deepEqual(CENSUS.flatMap((m) => m.runs).filter((r) => !crons.includes(r) && !routes.includes(r)), [], "a census entry no cron or route has");
  const real = (t: string) => shapeOf(tables[t].validator as Record<string, unknown>);
  const switches = new Set(CENSUS.flatMap((m) => m.imported.map((s) => s.table)));
  const imported = Object.keys(IMPORT_TABLES).filter((t) => tables[t]);
  const hasSwitch = (t: string) => Object.keys(real(t).fields ?? {}).some((f) => (SWITCH_FIELDS as readonly string[]).includes(f));
  assert.deepEqual(imported.filter((t) => hasSwitch(t) && !IMPORT_TABLES[t].arrive && !INERT[t]), [], "an imported table with a switch, no arrival and no reason it is inert");
  assert.deepEqual(Object.keys(INERT).filter((t) => !imported.includes(t) || IMPORT_TABLES[t].arrive || !hasSwitch(t)), [], "an INERT entry that isn't an imported table with a switch and no arrival");
  assert.deepEqual(imported.filter((t) => IMPORT_TABLES[t].arrive && !switches.has(t)), [], "an arrival the census doesn't check");
  for (const m of CENSUS) for (const s of [...m.imported, ...m.here]) {
    const index = ((tables[s.table] as unknown as { indexes: Array<{ indexDescriptor: string; fields: string[] }> }).indexes ?? []).find((i) => i.indexDescriptor === s.index);
    // A switch under a parent is read through the parent's id, and the parent is one of the mechanism's own switches.
    const first = index ? real(s.table).fields?.[index.fields[0]] : undefined;
    if (s.parent) assert.ok(first?.tableName === s.parent && m.imported.some((p) => p.table === s.parent && !p.parent), `${s.table}.${s.index} starts with a ${s.parent} id`);
    else assert.equal(index?.fields[0], "orgId", `${s.table}.${s.index} starts with orgId`);
  }
});

test("a file reference is cleared and counted, a row that is only its file is left out, and an id in text no grammar reads is refused", () => {
  const shape: Shape = { kind: "object", fields: { orgId: { kind: "id", tableName: "organizations" }, name: { kind: "string" }, logo: { kind: "id", tableName: "_storage", optional: true }, file: { kind: "id", tableName: "_storage" } } };
  const env = { orgId: "dest", map: () => undefined, imported: (t: string) => t !== "_storage" };
  const optional = decodeRow("t", { ...shape, fields: { ...shape.fields, file: { kind: "id", tableName: "_storage", optional: true } } }, { _id: mint(), name: "a", logo: { $ref: "_storage", id: mint() } }, env);
  assert.deepEqual([optional.row, optional.cleared, optional.needs], [{ name: "a", orgId: "dest" }, { _storage: 1 }, null]);
  const only = decodeRow("t", shape, { _id: mint(), name: "a", file: { $ref: "_storage", id: mint() } }, env);
  assert.deepEqual([only.needs, only.unmapped], ["_storage", []]);
  const known = mint();
  const text = decodeRow("t", { kind: "object", fields: { orgId: { kind: "id", tableName: "organizations" }, name: { kind: "string" } } }, { _id: mint(), name: `see /deals/${known}` }, { ...env, map: (id: string) => (id === known ? "new" : undefined) });
  assert.deepEqual(text.unmapped.map((u) => [u.field, u.value]), [["name", known]]);
});
