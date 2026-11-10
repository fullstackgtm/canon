import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { parseMime } from "../convex/lib/emailLog/mime.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

process.env.EMAIL_LOG_DOMAIN = "log.example.com";
process.env.EMAIL_LOG_SECRET = "s3cret";

const TOKEN = "testtokentesttokentestto";
const BOB = "bobtokenbobtokenbobtoken";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/email-log/${name}`, import.meta.url));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** The CRM as the record service holds it: Grace is a contact at example.org; Alan is not in it. */
const REGISTER: Record<string, Array<{ id: string; values: Record<string, unknown> }>> = {
  contact: [{ id: "contact-grace", values: { email: "grace@example.org" } }],
  account: [{ id: "acc-example-org", values: { domain: "example.org" } }],
};
const register = {
  listRegister: async (_org: string, object: string, q: { filter: Array<{ field: string; value: string[] }> }) => {
    const [{ field, value }] = q.filter;
    return { rows: (REGISTER[object] ?? []).filter((r) => value.includes(String(r.values[field]))) };
  },
};

const M = loadConvex(["emailLog.ts", "conversations.ts", "callSuggestions.ts", "conversationView.ts", "lib/emailLog/routes.ts"], {
  "records.ts": (real) => ({ ...real, principalClient: () => register, clientFor: () => register }),
  "lib.ts": (real) => ({ ...real, requireUser: async (ctx: { user: unknown }) => ctx.user, getCurrentUser: async (ctx: { user: unknown }) => ctx.user }),
});
const logInbound = M["emailLog.ts"].logInbound as unknown as (ctx: unknown, d: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

function world() {
  const member = (id: string, email: string, role = "rep") => ({ _id: `users:${id}`, orgId: "organizations:o", email, name: id, role, isActive: true });
  const db = memoryDb({
    users: [member("ada", "ada@example.com"), member("bob", "bob@example.com"), member("carol", "carol@example.com", "narrow")],
    emailLogAddresses: [
      { _id: "emailLogAddresses:ada", orgId: "organizations:o", userId: "users:ada", token: TOKEN, createdAt: 0 },
      { _id: "emailLogAddresses:bob", orgId: "organizations:o", userId: "users:bob", token: BOB, createdAt: 0 },
    ],
    // Carol's role sees only her own people.
    rolePermissions: [{ _id: "rolePermissions:n", orgId: "organizations:o", role: "narrow", rules: [{ object: "contact", visibility: "own" }] }],
  });
  const scheduled: unknown[] = [];
  const mctx = { db, scheduler: { runAfter: async (...a: unknown[]) => void scheduled.push(a) } };
  const run = async (ref: unknown, args: Record<string, unknown>) => {
    const [, file, fn] = String(ref).split(".");
    if (file === "dealPlays") return { access: accessOf({ userId: String(args.userId), role: "rep" }) };
    return M[`${file}.ts`][fn].handler(mctx, args);
  };
  const actx = { runQuery: run, runMutation: run };
  const deliver = (raw: Buffer | string, token = TOKEN) => logInbound(actx, { mail: parseMime(raw), recipients: [`log+${token}@log.example.com`] });
  const messages = () => db.rows("conversationMessages");
  const timeline = (contactId: string) => db.rows("observations").filter((o) => (o.subject as { contactId: string }).contactId === contactId).map((o) => plain({ body: o.body, occurredAt: o.occurredAt }));
  return { db, mctx, actx, scheduled, deliver, messages, timeline };
}

test("a BCC on a sent email logs once on each matched person, from the rep, suggests the unknown one, and sends nothing", async () => {
  const w = world();
  assert.deepEqual(plain(await w.deliver(fixture("bcc-sent.eml"))), { status: 200, body: { status: "logged", matched: 1, suggested: 1 } });
  assert.deepEqual(w.timeline("contact-grace"), [{
    occurredAt: Date.UTC(2026, 10, 2, 18, 15),
    body: {
      type: "email", key: "email:msg:pilot-1@mail.example.com",
      event: { kind: "message", direction: "out", userId: "users:ada", from: "ada@example.com", to: "Grace Hopper <grace@example.org>, \"Turing, Alan\" <alan@example.org>, Bob Babbage <bob@example.com>", subject: "Pilot plan – next steps" },
    },
  }]);
  const [m] = w.messages();
  assert.equal(m.text, "Hi Grace and Alan,\n\nAttached is the pilot plan. Can we start on the 16th – does that work?\n\nAda\n\n[Attachments, not kept: pilot-plan.pdf (600 B)]");
  assert.equal(m.logged, "bcc");
  const [c] = w.db.rows("conversations");
  assert.deepEqual(plain([c.ownerUserId, c.contactIds, c.participants, c.extractDueAt]), ["users:ada", ["contact-grace"], [{ email: "grace@example.org", name: "Grace Hopper" }, { email: "alan@example.org", name: "Turing, Alan" }], null]);
  // The company and deal pages find it through the person (conversationView.ts forRecord).
  assert.deepEqual(plain(w.db.rows("conversationContacts").map((r) => r.contactId)), ["contact-grace"]);
  // Alan is suggested for Ada to add, at the company the CRM already has; nothing is created and nothing is scheduled.
  assert.deepEqual(plain(w.db.rows("callSuggestions").map((s) => [s.kind, s.key, s.userId, s.status])), [["contact", "alan@example.org", "users:ada", "pending"]]);
  assert.deepEqual(w.scheduled, []);
  for (const t of ["emailSends", "sequenceEnrollments", "linkedinEnrollments", "outboundMessages", "backgroundJobs"]) assert.equal(w.db.rows(t).length, 0, t);
});

test("a forwarded email is logged from its original sender and date in the Gmail, Outlook and Apple Mail formats", async () => {
  for (const file of ["forward-gmail.eml", "forward-outlook.eml", "forward-apple.eml"]) {
    const w = world();
    assert.equal((await w.deliver(fixture(file))).body.status, "logged", file);
    const [entry] = w.timeline("contact-grace");
    assert.deepEqual([entry.occurredAt, entry.body.event.direction, entry.body.event.from, entry.body.event.subject], [Date.UTC(2026, 10, 2, 18, 15), "in", "grace@example.org", "Pilot budget"], file);
    assert.match(w.messages()[0].text as string, /The pilot budget is approved\. Let.s sign by Friday\./, file);
    assert.equal(w.messages()[0].logged, "forward");
  }
});

test("the same email is stored once: delivered twice, and BCCed by one rep then forwarded by another", async () => {
  const w = world();
  await w.deliver(fixture("bcc-sent.eml"));
  assert.equal((await w.deliver(fixture("bcc-sent.eml"))).body.status, "duplicate");
  const forward = [
    "Message-ID: <bob-fwd@mail.example.com>", "Date: Tue, 3 Nov 2026 09:00:00 -0800", "From: Bob Babbage <bob@example.com>",
    `To: log+${BOB}@log.example.com`, "Subject: Fwd: Pilot plan – next steps", "", "---------- Forwarded message ---------",
    "From: Ada Lovelace <ada@example.com>", "Date: Mon, Nov 2, 2026 at 10:15 AM", "Subject: Pilot plan – next steps", "To: Grace Hopper <grace@example.org>", "", "Hi Grace and Alan,",
  ].join("\r\n");
  assert.equal((await w.deliver(forward, BOB)).body.status, "duplicate");
  assert.equal(w.messages().length, 1);
  // A different email with its own Message-ID, same sender, minute and subject, is kept.
  const correction = fixture("bcc-sent.eml").toString("latin1").replace("pilot-1@mail", "pilot-1b@mail").replace("Subject: ", "Subject: Re: ");
  assert.equal((await w.deliver(correction)).body.status, "logged");
  assert.equal(w.messages().length, 2);
});

test("a reply joins the thread of the message it answers", async () => {
  const w = world();
  await w.deliver(fixture("bcc-sent.eml"));
  await w.deliver(fixture("reply.eml"));
  assert.equal(w.db.rows("conversations").length, 1);
  assert.deepEqual(plain(w.messages().map((m) => [m.externalMessageId, m.inReplyTo ?? null, m.text])), [
    ["pilot-1@mail.example.com", null, w.messages()[0].text],
    ["pilot-2@mail.example.com", "pilot-1@mail.example.com", "Following up: the 16th is booked."],
  ]);
});

test("an unknown or regenerated-away address is refused, and a new one works", async () => {
  const w = world();
  assert.equal((await w.deliver(fixture("bcc-sent.eml"), "unknowntokenunknowntoken")).status, 403);
  const address = await M["emailLog.ts"].regenerate.handler({ ...w.mctx, user: { _id: "users:ada", orgId: "organizations:o" } }, {});
  assert.equal((await w.deliver(fixture("bcc-sent.eml"))).status, 403);
  const fresh = /^log\+([a-z2-7]{24})@log\.example\.com$/.exec(address)![1];
  assert.equal((await w.deliver(fixture("bcc-sent.eml"), fresh)).body.status, "logged");
  // Past 20 rotations, the latest address still works and every older one is refused.
  let latest = fresh;
  for (let i = 0; i < 21; i++) latest = /^log\+([a-z2-7]{24})@/.exec(await M["emailLog.ts"].regenerate.handler({ ...w.mctx, user: { _id: "users:ada", orgId: "organizations:o" } }, {}))![1];
  const active = w.db.rows("emailLogAddresses").filter((r) => r.userId === "users:ada" && r.revokedAt === undefined);
  assert.deepEqual(active.map((r) => r.token), [latest]);
});

function routesOf(w: ReturnType<typeof world>) {
  const routes: Array<{ path: string; handler: (ctx: unknown, r: Request) => Promise<Response> }> = [];
  (M["lib/emailLog/routes.ts"].registerEmailLogRoutes as unknown as (h: unknown) => void)({ route: (r: never) => routes.push(r) });
  const bodies: Record<string, [string, Buffer]> = {
    raw: [`/email-log/raw?to=log%2B${TOKEN}%40log.example.com`, fixture("bcc-sent.eml")],
    postmark: ["/email-log/postmark", fixture("postmark-bcc.json")],
  };
  return (adapter: "raw" | "postmark", auth = "Bearer s3cret") => {
    const [path, body] = bodies[adapter];
    return routes.find((r) => r.path === path.split("?")[0])!.handler(w.actx, new Request(`https://x.example.com${path}`, { method: "POST", headers: { authorization: auth }, body: new Uint8Array(body) }));
  };
}

test("both endpoints refuse a delivery without the adapter's secret, and take it as a bearer or basic-auth password", async () => {
  for (const adapter of ["raw", "postmark"] as const) {
    const w = world();
    const post = routesOf(w);
    assert.equal((await post(adapter, "Bearer wrong")).status, 401, adapter);
    assert.equal((await post(adapter, `Basic ${btoa("postmark:wrong")}`)).status, 401, adapter);
    assert.equal((await post(adapter, "")).status, 401, adapter);
    assert.equal((await post(adapter, `Basic ${btoa("postmark:s3cret")}`)).status, 200, adapter);
    assert.equal((await post(adapter, "Bearer s3cret")).status, 200, adapter);
    assert.equal(w.messages().length, 1, adapter);
  }
});

test("mail whose From is not the token's member is held, not logged as theirs", async () => {
  const w = world();
  assert.deepEqual(plain(await w.deliver(fixture("spoofed.eml"))), { status: 202, body: { status: "held", reason: "not_member" } });
  assert.deepEqual([w.messages().length, w.db.rows("observations").length], [0, 0]);
  const held = (await w.db.get("emailLogAddresses:ada"))!.held as Array<{ from: string; subject: string }>;
  assert.deepEqual(plain(held.map((h) => [h.from, h.subject])), [["mallory@example.org", "Please wire the deposit"]]);
});

test("HTML-only mail is stored as text without markup, and a long body is cut at the cap with a note", async () => {
  const w = world();
  await w.deliver(fixture("html-only.eml"));
  assert.equal(w.messages()[0].text, "Agenda for Friday & next steps:\n\n- Budget\n- Timeline");
  const long = `Message-ID: <long@mail.example.com>\r\nFrom: ada@example.com\r\nTo: grace@example.org\r\nSubject: Notes\r\n\r\n${"word ".repeat(30_000)}`;
  await w.deliver(long);
  const text = w.messages()[1].text as string;
  assert.ok(text.length <= 50_000);
  assert.match(text, /\[Truncated: the last [\d,]+ characters were not kept\]$/);
});

test("a member who cannot see the person cannot open the logged email; its owner reads it", async () => {
  const w = world();
  await w.deliver(fixture("bcc-sent.eml"));
  const [c] = w.db.rows("conversations");
  const as = (id: string, role: string) => M["conversationView.ts"].thread.handler({ ...w.mctx, user: { _id: `users:${id}`, orgId: "organizations:o", role } }, { conversationId: c._id });
  assert.equal(await as("carol", "narrow"), null);
  const own = await as("ada", "rep");
  assert.match(own.messages[0].text, /^Hi Grace and Alan/);
});

test("the raw and Postmark adapters store the same email the same way, once", async () => {
  const stored = async (adapter: "raw" | "postmark") => {
    const w = world();
    assert.deepEqual(plain(await (await routesOf(w)(adapter)).json()), { status: "logged", matched: 1, suggested: 1 }, adapter);
    return { w, rows: plain({ messages: w.messages().map(({ _id: _i, _creationTime: _c, conversationId: _conv, ...m }) => m), timeline: w.timeline("contact-grace") }) };
  };
  const raw = await stored("raw");
  assert.deepEqual((await stored("postmark")).rows, raw.rows);
  assert.equal(raw.rows.messages.length, 1);
  assert.deepEqual(plain(await (await routesOf(raw.w)("postmark")).json()), { status: "duplicate" });
});
