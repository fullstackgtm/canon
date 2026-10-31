/** P4a outbound effects (docs/modules.md, "Outbound"): the outbox, its gate, its dispatcher and its sinks. */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sendPostmark, sendSlack, sendWebhook } from "../convex/lib/outbound/adapters.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const MANIFEST = readFileSync("tests/fixtures/modules/visit-log/module.json", "utf8");
const ID = "@canon-fixtures/visit-log";
const members = [
  { _id: "admin", orgId: "org", role: "admin", name: "Ada", email: "a@x.test", isActive: true },
  { _id: "boss", orgId: "org", role: "manager", name: "Bo", email: "b@x.test", isActive: true },
  { _id: "rep1", orgId: "org", role: "rep", name: "Ria", email: "r1@x.test", isActive: true },
  { _id: "rep2", orgId: "org", role: "rep", name: "Rex", email: "r2@x.test", isActive: true },
];
let testNow: number | undefined;
const caller: { user: Record<string, unknown> | null } = { user: null };
const loaded = loadConvex(["modules.ts", "outbound.ts", "outboundDispatch.ts"], {
  "lib.ts": (r) => ({ ...r, getCurrentUser: async () => caller.user, requireUser: async () => caller.user, agentClientOf: async () => null }),
}, { Date: class extends Date { static now() { return testNow ?? Date.now(); } }, fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a) });
const fn = { ...loaded["modules.ts"], ...loaded["outbound.ts"], ...loaded["outboundDispatch.ts"] };

/** The fixture module with a Slack channel, workspace notices and a webhook declared, each turned on and mapped. */
function outboxOn(slackUrl: string, edit?: (m: Record<string, any>) => void) {
  const m = JSON.parse(MANIFEST);
  m.outbound = { email: { from: ["workspace"], kinds: ["notice"] }, slack: { channels: ["field-team"] }, webhook: { events: ["visit.done"] } };
  m.templates = { done: { channel: "slack", text: "{$doc.title} is done by {$doc.completedBy|user}" }, ping: { channel: "slack", text: "Ping {$vars.n}" } };
  m.machines.visit.transitions.complete.effects.push({ send: { template: "done", to: { slack: "field-team" } } });
  edit?.(m);
  const db = memoryDb({
    organizations: [{ _id: "org", defaultCurrency: "USD" }], users: members, teamGroups: [{ _id: "team", orgId: "org", managerId: "boss", memberIds: ["rep1"] }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: ID, slug: "visit-log", source: { kind: "github-public", owner: "o", repo: "r", ref: "v1", sha: "a".repeat(40) }, version: "1.2.0",
      manifest: JSON.stringify(m), manifestHash: createHash("sha256").update(JSON.stringify(m)).digest("hex"), installedBy: "admin", installedAt: 1, status: "installed" }],
    recipeEnablements: [{ _id: "on", orgId: "org", point: "module", recipeId: ID, contributionKey: "nav", enabled: true, at: 1 }],
    outboundChannels: ["email", "slack", "webhook"].map((channel) => ({ _id: `ch-${channel}`, orgId: "org", moduleId: ID, channel, enabledBy: "admin", enabledAt: 1 })),
    outboundTargets: [{ _id: "slack-1", orgId: "org", channel: "slack", name: "field-team", url: slackUrl, hint: "x", createdBy: "admin", createdAt: 1 }],
  });
  const scheduled: string[] = [];
  const ctx = () => ({ db, scheduler: { runAfter: async (_ms: number, ref: unknown) => { scheduled.push(String(ref)); } }, auth: { getUserIdentity: async () => null } });
  const act = { scheduler: ctx().scheduler, runMutation: (ref: unknown, args: unknown) => fn[String(ref).split(".").pop()!].handler(ctx(), args), runQuery: (ref: unknown, args: unknown) => fn[String(ref).split(".").pop()!].handler(ctx(), args) };
  const call = (name: string, args: Record<string, unknown> = {}) => fn[name].handler(name === "dispatch" ? act : ctx(), args);
  const as = (id: string) => { caller.user = members.find((u) => u._id === id)!; };
  /** A visit `as` makes and marks done. */
  const done = async (title: string, data: Record<string, unknown> = {}, module = "visit-log") => {
    const v = await call("op", { module, op: "visits.create", data: { title, visitOn: "2026-10-01", ...data } });
    await call("transition", { module, machine: "visit", name: "complete", key: v.key, expect: 1 });
    return v.key as string;
  };
  return { db, call, as, done, scheduled, rows: () => db.rows("outboundMessages") as Array<Record<string, any>> };
}

/** A loopback receiver: what each request carried. */
async function receiver() {
  const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const server = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)).on("end", () => { seen.push({ headers: req.headers, body }); res.end("ok"); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, seen, close: () => server.close() };
}

test("a transition queues its Slack post in its own write, links it on the doc's history, and a second post within the second is held, not dropped", async () => {
  const sink = await receiver();
  try {
    const h = outboxOn(sink.url);
    h.as("rep1");
    const key = await h.done("Acme");
    await h.done("Beta");
    assert.deepEqual(h.rows().map((r) => [r.state, r.target, r.rendered.text]), [["queued", "slack:field-team", "Acme is done by Ria"], ["queued", "slack:field-team", "Beta is done by Ria"]]);
    const linked = h.db.rows("moduleEvents").filter((e) => e.key === key && e.kind === "event");
    assert.deepEqual(linked.map((e) => (e.args as { outbound: string }).outbound), [h.rows()[0]._id], "the visit's history names its outbox row");
    assert.ok(h.scheduled.includes("internal.outboundDispatch.dispatch"), "the write wakes the dispatcher");

    h.as("rep2");
    assert.deepEqual(await h.call("outbox", { module: "visit-log" }), [], "another rep sees none of Ria's");
    h.as("boss");
    assert.equal((await h.call("outbox", { module: "visit-log" })).length, 2, "her manager sees them");

    await h.call("dispatch");
    const [first, second] = h.rows();
    assert.deepEqual([first.state, first.providerId], ["sent", "local"]);
    assert.deepEqual(sink.seen.map((s) => JSON.parse(s.body).text), ["Acme is done by Ria"], "the sink posts only to loopback, once");
    assert.equal(second.state, "held");
    assert.equal(second.notBefore, first.claimedAt + 1000, "it fits one second after the first post");
  } finally {
    sink.close();
  }
});

test("a rerun of a call's send finds its row and queues nothing again", async () => {
  const h = outboxOn("https://hooks.slack.com/services/T/B/x");
  const send = (key: string) => h.call("applyCall", { module: "visit-log", call: "dirtyMany", system: "org", epoch: 1, intents: [{ op: "send", template: "ping", to: { slack: "field-team" }, vars: { n: 1 }, key }] });
  await send("week-42");
  await send("week-42");
  assert.equal(h.rows().length, 1);
  await send("week-43");
  assert.deepEqual(h.rows().map((r) => r.rendered.text), ["Ping 1", "Ping 1"]);
});

test("a call cannot send the wrong template channel, and a malformed stored webhook cannot stop the next send", async () => {
  const h = outboxOn("https://hooks.slack.com/services/T/B/x");
  h.as("admin");
  const call = (to: { slack: string } | { webhook: string }, key: string) => h.call("applyCall", {
    module: "visit-log", call: "dirtyMany", system: "org", epoch: 1,
    intents: [{ op: "send", template: "ping", to, vars: { n: 1 }, key }],
  });
  await assert.rejects(() => call({ webhook: "visit.done" }, "wrong-channel"));
  await h.db.insert("outboundTargets", { _id: "hook-1", orgId: "org", channel: "webhook", name: "Visits", events: ["visit.done"], url: "https://receiver.example.test", secret: "fake-secret", createdBy: "admin", createdAt: 1 });
  await h.db.insert("outboundMessages", {
    orgId: "org", module: ID, cause: "old-malformed-row", channel: "webhook", kind: "automated",
    to: { event: "visit.done", endpoint: "hook-1" }, target: "webhook:hook-1", rendered: { text: "not JSON" },
    state: "queued", notBefore: 0, idempotencyKey: "old-malformed-row", at: 0,
  });
  await call({ slack: "field-team" }, "good-channel");
  await h.call("dispatch");
  assert.deepEqual(h.rows().map((r) => [r.channel, r.state, r.providerId ?? null]), [
    ["webhook", "failed", null], ["slack", "sent", "local"],
  ]);
});

test("a template that leaves a value empty refuses the whole message", async () => {
  const h = outboxOn("https://hooks.slack.com/services/T/B/x", (m) => {
    m.templates.done.text = "{$doc.title} closed at {$doc.amount|money}";
  });
  h.as("rep1");
  await h.done("No amount");
  const [row] = h.rows();
  assert.equal(row.state, "refused");
  assert.match(row.reason, /\{\$doc\.amount\|money\}/);
  assert.equal(row.rendered.text, "", "nothing half-filled is kept to send");
  await h.done("Priced", { amount: 120_000 });
  assert.equal(h.rows()[1].rendered.text, "Priced closed at $1,200.00");
});

test("a local stack never sends for real: Postmark's key changes nothing, and a real Slack URL isn't called", async (t) => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => { calls.push(String(url)); return Response.json({ ErrorCode: 0, MessageID: "pm-1" }); }) as typeof fetch;
  Object.assign(process.env, { POSTMARK_SERVER_TOKEN: "server-token", POSTMARK_FROM_ADDRESS: "Canon <notices@canon.test>" });
  t.after(() => { globalThis.fetch = real; delete process.env.POSTMARK_SERVER_TOKEN; delete process.env.POSTMARK_FROM_ADDRESS; delete process.env.CONVEX_SITE_URL; });
  const h = outboxOn("https://hooks.slack.com/services/T/B/x", (m) => {
    m.machines.visit.transitions.complete.effects.push({ notify: [{ role: ["manager"] }], message: "{$doc.title} is done", email: true });
  });
  h.as("rep1");
  await h.done("Acme");
  await h.call("dispatch");
  assert.deepEqual(h.rows().map((r) => [r.channel, r.target, r.state, r.providerId]), [["slack", "slack:field-team", "sent", "local"], ["email", "member:boss", "sent", "local"]]);
  assert.deepEqual(calls, [], "nothing left the stack");

  process.env.CONVEX_SITE_URL = "https://canon-dev.convex.site";
  await h.done("Beta");
  await h.call("dispatch");
  assert.deepEqual(h.rows().slice(2).map((r) => [r.channel, r.state, r.providerId]), [["slack", "held", undefined], ["email", "sent", "pm-1"]], "deployed, Postmark sends");
  assert.deepEqual(calls, ["https://api.postmarkapp.com/email"]);
});

test("a webhook is signed over its timestamp and body, and names its row", async () => {
  const sink = await receiver();
  try {
    const body = JSON.stringify({ id: "row-1", event: "visit.done", data: { title: "Acme" } });
    assert.deepEqual(await sendWebhook({ url: sink.url, secret: "whsec_test", id: "row-1", body }), { ok: true, providerId: "local" });
    const [{ headers, body: got }] = sink.seen;
    const [, ms, sig] = String(headers["canon-signature"]).match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    assert.equal(sig, createHmac("sha256", "whsec_test").update(`${ms}.${got}`).digest("hex"));
    assert.equal(headers["canon-event-id"], "row-1");
  } finally {
    sink.close();
  }
});

test("the manifest refuses sends it can't place, with the path that's wrong", () => {
  const errors = (edit: (m: Record<string, any>) => void) => {
    const m = JSON.parse(MANIFEST);
    m.outbound = { slack: { channels: ["field-team"] } };
    m.templates = { done: { channel: "slack", text: "{$doc.title}" } };
    edit(m);
    const r = parseModuleManifest(m);
    return r.ok ? [] : r.errors;
  };
  assert.deepEqual(errors(() => {}), []);
  assert.ok(errors((m) => { m.machines.visit.transitions.complete.effects.push({ send: { template: "done", to: { slack: "sales" } } }); }).some((e) => e.startsWith("machines.visit.transitions.complete.effects[1].send.to.slack")));
  assert.ok(errors((m) => { m.templates.mail = { channel: "email", subject: "Hi", body: "{$doc.title}" }; }).some((e) => e.startsWith("templates.mail.channel")));
  assert.ok(errors((m) => { m.templates.done.text = "{$doc.nope}"; m.machines.visit.transitions.complete.effects.push({ send: { template: "done", to: { slack: "field-team" } } }); }).some((e) => e.startsWith("machines.visit.transitions.complete.effects[1].send.template")));
  assert.ok(errors((m) => { m.machines.visit.transitions.complete.effects.push({ notify: [{ role: ["manager"] }], message: "Done", email: true }); }).some((e) => e.startsWith("machines.visit.transitions.complete.effects[1].email")));
});


test("a digest rechecks every module and channel and reserves each row's rate allowance", async (t) => {
  testNow = Date.UTC(2026, 9, 20, 7);
  t.after(() => { testNow = undefined; });
  const h = outboxOn("https://hooks.slack.com/services/T/B/x", (m) => {
    m.machines.visit.transitions.complete.effects = [{ notify: [{ role: ["manager"] }], message: "{$doc.title} is done", email: true }];
  });
  h.as("admin");
  const modules = ["visit-log", "channel-off", "module-off", "capped", "future"];
  const pkg = h.db.rows("modulePackages")[0];
  for (const slug of modules.slice(1)) {
    const id = `@canon-fixtures/${slug}`;
    const manifest = JSON.stringify({ ...JSON.parse(String(pkg.manifest)), id });
    await h.db.insert("modulePackages", { ...pkg, _id: `pkg-${slug}`, moduleId: id, slug, manifest, manifestHash: createHash("sha256").update(manifest).digest("hex") });
    await h.db.insert("recipeEnablements", { orgId: "org", point: "module", recipeId: id, contributionKey: "nav", enabled: true });
    await h.call("setChannel", { moduleId: id, channel: "email", on: true });
  }
  for (const slug of modules) {
    h.as("boss");
    await h.call("setEmailChoice", { moduleId: `@canon-fixtures/${slug}`, mode: "digest" });
    h.as("rep1");
    await h.done(slug, {}, slug);
  }
  await h.done("capped second", {}, "capped");
  h.as("admin");
  await h.call("setChannel", { moduleId: "@canon-fixtures/channel-off", channel: "email", on: false });
  const off = h.db.rows("recipeEnablements").find((r) => r.recipeId === "@canon-fixtures/module-off")!;
  await h.db.patch(off._id, { enabled: false });
  const future = h.rows().find((r) => r.module === "@canon-fixtures/future")!;
  await h.db.patch(future._id, { notBefore: testNow + 3 * 60 * 60_000 });
  for (let n = 0; n < 499; n++) await h.db.insert("outboundMessages", { orgId: "org", module: "@canon-fixtures/capped", target: "member:boss", state: "sent", claimedAt: testNow });
  testNow += 60 * 60_000;
  const jobs = await h.call("claim");
  assert.deepEqual(JSON.parse(JSON.stringify(jobs.map((j: any) => ({ channel: j.channel, to: j.to, subject: j.subject, text: j.text })))), [{ channel: "email", to: "b@x.test", subject: "Your Canon digest: 2 notices", text: "Visit log: visit-log is done\nvisit-log is done\n\n---\n\nVisit log: capped is done\ncapped is done" }]);
  assert.deepEqual(h.rows().slice(0, 6).map((r) => r.state), ["sending", "refused", "refused", "sending", "held", "held"]);
  assert.equal(h.rows()[5].notBefore, Date.UTC(2026, 9, 21, 7));
  await h.call("settle", { ids: jobs[0].ids, result: { ok: true, providerId: "local" } });
  assert.deepEqual(h.rows().slice(0, 4).map((r) => r.state), ["sent", "refused", "refused", "sent"]);
});

test("queued email checks current workspace membership and active status before delivery", async () => {
  for (const change of ["inactive", "other-org", "revoked-membership", "secondary-member"]) {
    const h = outboxOn("https://hooks.slack.com/services/T/B/x");
    await h.call("sendWorkspaceEmail", { orgId: "org", to: { member: "boss" }, subject: "Code", body: "123456", cause: change });
    if (change === "inactive") await h.db.patch("boss", { isActive: false });
    if (change === "other-org" || change === "secondary-member") await h.db.patch("boss", { orgId: "elsewhere" });
    if (change === "revoked-membership" || change === "secondary-member") await h.db.insert("orgMemberships", { userId: "boss", orgId: "org", isActive: change === "secondary-member", role: "manager" });
    await h.call("dispatch");
    assert.equal(h.rows()[0].state, change === "secondary-member" ? "sent" : "refused", change);
  }
});

test("notification email rechecks off and digest preferences while explicit system mail keeps its own route", async (t) => {
  testNow = Date.UTC(2026, 9, 20, 7);
  t.after(() => { testNow = undefined; });
  const h = outboxOn("https://hooks.slack.com/services/T/B/x", (m) => {
    m.machines.visit.transitions.complete.effects = [{ notify: [{ role: ["manager"] }], message: "{$doc.title} is done", email: true }];
  });
  h.as("rep1");
  await h.done("Off");
  h.as("boss");
  await h.call("setEmailChoice", { moduleId: ID, mode: "off" });
  await h.call("sendWorkspaceEmail", { orgId: "org", to: { member: "boss" }, subject: "Code", body: "123456", cause: "code" });
  await h.call("dispatch");
  assert.deepEqual(h.rows().map((r) => r.state), ["refused", "sent"]);
  await h.call("setEmailChoice", { moduleId: ID, mode: "instant" });
  h.as("rep1");
  await h.done("Later");
  h.as("boss");
  await h.call("setEmailChoice", { moduleId: ID, mode: "digest" });
  await h.call("dispatch");
  assert.deepEqual([h.rows()[2].state, h.rows()[2].notBefore], ["held", Date.UTC(2026, 9, 20, 8)]);
  testNow += 60 * 60_000;
  const jobs = await h.call("claim");
  assert.equal(jobs[0].subject, "Your Canon digest: 1 notice");
  await h.call("settle", { ids: jobs[0].ids, result: { ok: true, providerId: "local" } });
  h.as("rep1");
  await h.done("Send now");
  h.as("admin");
  await h.call("act", { id: h.rows()[3]._id, action: "sendNow" });
  await h.call("dispatch");
  assert.deepEqual([h.rows()[3].state, h.rows()[3].providerId], ["sent", "local"]);
});

test("a persisted approval requirement survives claim and sends only after the outbox approval", async () => {
  const h = outboxOn("https://hooks.slack.com/services/T/B/x", (m) => {
    m.machines.visit.transitions.complete.effects = [{ send: { template: "done", to: { slack: "field-team" }, approval: "person" } }];
  });
  h.as("rep1");
  await h.done("Approval");
  const row = h.rows()[0];
  assert.equal(row.approval, "person");
  await h.db.patch(row._id, { state: "queued" });
  await h.call("dispatch");
  assert.equal(row.state, "awaiting_approval");
  await h.call("act", { id: row._id, action: "approve" });
  await h.call("dispatch");
  assert.deepEqual([row.state, row.decidedBy, row.providerId], ["sent", "rep1", "local"]);
});

test("Postmark ambiguous transport and body failures settle unknown without a retry", async (t) => {
  const before = { ...process.env };
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; for (const key of ["CONVEX_SITE_URL", "POSTMARK_SERVER_TOKEN", "POSTMARK_FROM_ADDRESS"]) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
  Object.assign(process.env, { CONVEX_SITE_URL: "https://canon-test.convex.site", POSTMARK_SERVER_TOKEN: "fake-token", POSTMARK_FROM_ADDRESS: "notices@canon.test" });
  for (const outcome of ["network", "timeout", "body", "refusal-body", "unconfirmed", "rejected", "accepted"]) {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (outcome === "network") throw new TypeError("connection reset");
      if (outcome === "timeout") { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }
      if (outcome === "body" || outcome === "refusal-body") return new Response("truncated", { status: outcome === "body" ? 200 : 500 });
      if (outcome === "unconfirmed") return Response.json({ ErrorCode: 0 });
      if (outcome === "rejected") return Response.json({ ErrorCode: 100, Message: "Try later" }, { status: 429 });
      return Response.json({ ErrorCode: 0, MessageID: "fake-accepted" });
    }) as typeof fetch;
    const h = outboxOn("https://hooks.slack.com/services/T/B/x");
    await h.call("sendWorkspaceEmail", { orgId: "org", to: { address: "test@example.test" }, subject: "Notice", body: "Test", cause: outcome });
    await h.call("dispatch");
    assert.equal(h.rows()[0].state, outcome === "accepted" ? "sent" : outcome === "rejected" ? "queued" : "unknown", outcome);
    await h.call("dispatch");
    assert.equal(requests, 1, outcome);
  }
  const timeout = (async () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }) as typeof fetch;
  const slack = await sendSlack("https://hooks.slack.com/services/T/B/fake", "Test", timeout);
  assert.deepEqual(slack, { ok: false, error: "Slack didn't answer in time, so it may have posted.", retry: false, unknown: true });
  const refusal = await sendPostmark({ to: "test@example.test", subject: "Notice", text: "Test" }, async () => Response.json({ ErrorCode: 300, Message: "Invalid request" }, { status: 422 }));
  assert.deepEqual(refusal, { ok: false, error: "Postmark refused it (300: Invalid request).", retry: false });
});
