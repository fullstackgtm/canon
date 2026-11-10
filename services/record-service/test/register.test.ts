// One register of accounts and contacts (docs/cp0-object-layer.md, "One register";
// src/register.ts): rows linked to a ledger stream take their registry fields from
// the projector's write-back, and nothing else writes those fields.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { all } from "../src/db.ts";
import { FakeLedger } from "./ledgerFake.ts";
import { startApp } from "./helpers.ts";

describe("one register of accounts and contacts", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;

  before(async () => {
    const sourceUrl = await ledger.listen();
    ctx = await startApp({ projector: { sourceUrl, pollMs: 0, pageSize: 50, rebuildChunk: 2 } });
  });
  after(async () => {
    await ctx.app.shutdown();
    await ledger.close();
  });

  const ws = (id: string) => ctx.client.ws(id);
  const nudge = (id: string) => ws(id).post("projector/nudge", { wait: true });
  const sql = (id: string, q: string) => ctx.app.registry.with(id, (w) => w.read((c) => all(c, q)));
  const account = async (id: string, accountId: string) => (await ws(id).post("accounts/get", { id: accountId })).json.account;
  const provisioned = new Set<string>();
  const upsert = async (id: string, records: unknown[], key: string, extra: Record<string, unknown> = {}) => {
    if (!provisioned.has(id)) (provisioned.add(id), await ws(id).post("provision"));
    return ws(id).post("accounts/upsert", { records, source: "pdl", idempotencyKey: key, ...extra });
  };
  const changes = async (id: string) => (await ws(id).get("changes?after=0&limit=500")).json.changes as Array<{ id: string; op: string; origin: string; fields: unknown }>;

  it("links a stream seeded from a TAM row and writes the ledger's values back, with history and an outbox row", async () => {
    const w = "r1";
    const up = await upsert(w, [{ domain: "Atlas.example", name: "Atlas", industry: "Retail", employees: 40 }], "u1");
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const [id] = up.json.ids;
    assert.equal((await ws(w).post("rescore", { icp: { industries: { software: 30 } } })).status, 200);
    const before = await account(w, id);
    assert.equal(before.fit, 0);

    // Promoted by a person's edit: the stream starts from the row (record:account:<id>), then the edit.
    ledger.set(w, "account", "s-atlas", { name: "Atlas", domain: "atlas.example", industry: "Retail", employees: 40 }, 1000, { kind: "import", ref: `record:account:${id}` });
    ledger.set(w, "account", "s-atlas", { industry: "Software", status: "working" }, 1100, { kind: "user", ref: "user:u1:s-atlas:k1" });
    assert.equal((await nudge(w)).status, 200);

    const after = await account(w, id);
    assert.deepEqual([after.stream, after.ledgerVersion, after.industry, after.status, after.version], ["s-atlas", 2, "Software", "working", before.version + 1]);
    assert.equal(after.fit, 30, "fit follows the written-back industry");
    assert.equal(after.source, "ledger:user");
    const history = await sql(w, `SELECT field, oldValue, newValue, actorId FROM field_history WHERE id = '${id}' AND source = 'ledger:user' ORDER BY field`);
    assert.deepEqual(history.map((h) => [h.field, h.oldValue, h.newValue, h.actorId]), [["industry", "Retail", "Software", "u1"], ["status", "new", "working", "u1"]]);
    const edit = (await changes(w)).filter((c) => c.id === id && c.op === "edit").at(-1)!;
    assert.equal(edit.origin, "user", "the outbox names the ledger entry's source, so the Salesforce sync pushes a person's edit and skips its own");
    assert.equal(after.fieldUpdatedAt.industry, 1100, "fieldUpdatedAt is when the value became true at its source, not when it was written back");

    // Two people's edits applied together: each field's history names whoever set it.
    ledger.set(w, "account", "s-atlas", { city: "Oslo" }, 1150, { kind: "user", ref: "user:alice:s-atlas:k3" });
    ledger.set(w, "account", "s-atlas", { phone: "+47 1" }, 1160, { kind: "user", ref: "user:bob:s-atlas:k4" });
    assert.equal((await nudge(w)).status, 200);
    const who = await sql(w, `SELECT field, actorId FROM field_history WHERE id = '${id}' AND field IN ('city', 'phone') ORDER BY field`);
    assert.deepEqual(who.map((h) => [h.field, h.actorId]), [["city", "alice"], ["phone", "bob"]]);

    // A Salesforce change and a person's change applied together: each field's outbox row names its own source.
    ledger.set(w, "account", "s-atlas", { country: "US" }, 1200, { kind: "user", ref: "user:u1:s-atlas:k2" });
    ledger.set(w, "account", "s-atlas", { employees: 55 }, 1300, { kind: "salesforce", ref: "salesforce:account:001" });
    assert.equal((await nudge(w)).status, 200);
    const latest = (await changes(w)).filter((c) => c.id === id && c.op === "edit").slice(-2);
    const names = (f: unknown) => (Array.isArray(f) ? f : Object.keys(f as object));
    assert.deepEqual(latest.map((c) => [c.origin, names(c.fields)]).sort(), [["salesforce", ["employees"]], ["user", ["country"]]]);

    // Applying the same entries again changes nothing.
    const settled = (await account(w, id)).version;
    await ctx.app.registry.with(w, (x) => x.write((c) => c.run("DELETE FROM projector_cursor"), "exclusive"));
    assert.equal((await nudge(w)).status, 200);
    assert.equal((await account(w, id)).version, settled);
  });

  it("keeps a merge local: its picked values and its undo go to the outbox as op merge, and a merged row leaves the recycle bin (1.23.0)", async () => {
    const w = "r-merge";
    const up = await upsert(w, [{ domain: "keep.example", name: "Keep", industry: "Retail" }, { domain: "gone.example", name: "Gone", industry: "Software" }], "u1");
    const [keep, gone] = up.json.ids;
    ledger.set(w, "account", "s-keep", { name: "Keep", domain: "keep.example", industry: "Retail" }, 1000, { kind: "import", ref: `record:account:${keep}` });
    ledger.set(w, "account", "s-gone", { name: "Gone", domain: "gone.example", industry: "Software" }, 1000, { kind: "import", ref: `record:account:${gone}` });
    assert.equal((await nudge(w)).status, 200);

    // The merge: the survivor takes the loser's industry as a person's pick, and the loser is merged into it.
    ledger.set(w, "account", "s-keep", { industry: "Software" }, 1100, { kind: "user", ref: "user:u1:s-keep:merge:m1" });
    ledger.append(w, "account", "s-gone", { kind: "lifecycle", op: "merge", into: "s-keep" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const outOf = async (id: string) => (await changes(w)).filter((c) => c.id === id && (c.op === "edit" || c.op === "merge")).map((c) => c.op);
    assert.deepEqual(await outOf(keep), ["merge"], "a merged-in value is never an edit the Salesforce sync would push");
    assert.deepEqual((await sql(w, `SELECT mergedInto FROM accounts WHERE id = '${gone}'`))[0].mergedInto, "s-keep");
    const bin = (await ws(w).post("register/account/list", { deleted: true })).json.rows.map((r: { id: string }) => r.id);
    assert.equal(bin.includes(gone), false);

    // The undo puts the survivor's import fact back: that change is the merge's too, not an edit to push.
    const fact = { factId: "s-keep@1#2", fieldId: "industry", value: "Retail", sourceKind: "import", sourceRef: `record:account:${keep}`, observedAt: 1000, confidence: 1 };
    ledger.append(w, "account", "s-keep", { kind: "revert", mergeId: "m1", fields: [{ fieldId: "industry", fold: { candidates: [fact], pending: [], observed: [] } }] } as never, 1200);
    assert.equal((await nudge(w)).status, 200);
    assert.equal((await sql(w, `SELECT industry FROM accounts WHERE id = '${keep}'`))[0].industry, "Retail");
    assert.deepEqual(await outOf(keep), ["merge", "merge"]);
  });

  it("links a CRM stream to the unworked TAM row with its domain, and inserts a row for a company only the CRM knows", async () => {
    const w = "r2";
    const [tamId] = (await upsert(w, [{ domain: "northstar.example", name: "Northstar" }], "u1")).json.ids;
    ledger.set(w, "account", "s-north", { name: "Northstar Data", domain: "https://www.Northstar.example/" }, 1000, { kind: "hubspot", ref: "hubspot:account:1" });
    ledger.set(w, "account", "s-crm", { name: "Brightline", domain: "brightline.example", country: "US" }, 1000, { kind: "hubspot", ref: "hubspot:account:2" });
    assert.equal((await nudge(w)).status, 200);

    const north = await account(w, tamId);
    assert.deepEqual([north.stream, north.name, north.domain], ["s-north", "Northstar Data", "northstar.example"]);
    const rows = await sql(w, `SELECT id, stream, name, domain, country, status FROM accounts WHERE stream = 's-crm'`);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].name, rows[0].domain, rows[0].country, rows[0].status], ["Brightline", "brightline.example", "US", "new"]);

    // A later TAM upsert of that company finds the same row by domain: it fills TAM-only columns and leaves the ledger's fields.
    const again = await upsert(w, [{ domain: "brightline.example", name: "Brightline Robotics Inc", country: "DE", segmentIds: ["seg1"] }], "u2");
    assert.deepEqual(again.json.ids, [rows[0].id]);
    const crm = await account(w, String(rows[0].id));
    assert.deepEqual([crm.name, crm.country, crm.segmentIds], ["Brightline", "US", ["seg1"]]);
  });

  it("refuses records/edit of a ledger field on a linked row, and still takes the fields only the service keeps", async () => {
    const w = "r3";
    const [acc] = (await upsert(w, [{ domain: "cara.example", name: "Cara Co" }], "u1")).json.ids;
    const people = await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Cara Quill", email: "cara@cara.example" }], source: "pipe0", idempotencyKey: "p1" });
    const [con] = people.json.ids;
    ledger.set(w, "contact", "s-cara", { fullName: "Cara Quill", email: "cara@cara.example" }, 1000, { kind: "import", ref: `record:contact:${con}` });
    ledger.set(w, "contact", "s-cara", { title: "COO" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const contact = (await ws(w).post("contacts/get", { id: con })).json.contact;
    assert.deepEqual([contact.stream, contact.title], ["s-cara", "COO"]);

    const owned = await ws(w).post("records/edit", { object: "contact", id: con, patch: { title: "CEO" }, actorId: "u1", idempotencyKey: "e1" });
    assert.equal(owned.status, 409);
    assert.match(owned.json.error, /belong to its ledger record/);
    const own = await ws(w).post("records/edit", { object: "contact", id: con, patch: { emailStatus: "found", status: "working" }, actorId: "u1", idempotencyKey: "e2" });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    const after = (await ws(w).post("contacts/get", { id: con })).json.contact;
    assert.deepEqual([after.title, after.emailStatus, after.status], ["COO", "found", "working"]);

    // An unlinked row is edited as before.
    const [other] = (await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Dan Moss" }], source: "pipe0", idempotencyKey: "p2" })).json.ids;
    assert.equal((await ws(w).post("records/edit", { object: "contact", id: other, patch: { title: "CFO" }, actorId: "u1", idempotencyKey: "e3" })).status, 200);
  });

  it("claims an edit's key for its whole operation with an empty patch: a missing record is a 404, a different operation a 409", async () => {
    const w = "r8";
    const [id] = (await upsert(w, [{ domain: "claim.example", name: "Claim" }], "u1")).json.ids;
    const claim = (key: string, payload: string, recordId = id) =>
      ws(w).post("records/edit", { object: "account", id: recordId, patch: {}, actorId: "u1", idempotencyKey: key, payload });
    assert.equal((await claim("k1", "digest-a")).status, 200);
    assert.equal((await claim("k1", "digest-a")).status, 200, "a replay");
    assert.equal((await claim("k1", "digest-b")).status, 409, "the same key for another operation");
    assert.equal((await claim("k2", "digest-a", "acc_missing")).status, 404);
    assert.equal((await ws(w).post("records/edit", { object: "account", id, patch: {}, actorId: "u1", idempotencyKey: "k3" })).status, 400, "an empty patch needs a payload");
    assert.equal((await account(w, id)).version, 1, "a claim changes nothing");
  });

  it("clears a value the ledger cleared, storing a column that cannot be null in its empty form", async () => {
    const w = "r9";
    const [id] = (await upsert(w, [{ domain: "clear.example", name: "Clear", industry: "Retail" }], "u1")).json.ids;
    ledger.set(w, "account", "s-clear", { name: "Clear", domain: "clear.example", industry: "Retail" }, 1000, { kind: "import", ref: `record:account:${id}` });
    ledger.set(w, "account", "s-clear", { industry: null, domain: null }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const row = await account(w, id);
    assert.deepEqual([row.industry, row.domain], [undefined, ""]);
    // The released domain identifies nothing: a later upsert of it is a new company.
    const again = await upsert(w, [{ domain: "clear.example", name: "Someone Else" }], "u2");
    assert.notDeepEqual(again.json.ids, [id]);
  });

  it("links a Salesforce stream to the imported row its Salesforce id names, even a contact with no email; a cleared domain matches no other row", async () => {
    const w = "r10";
    const [acc] = (await upsert(w, [{ domain: "sf.example", name: "SF Co" }], "u1")).json.ids;
    const [con] = (await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Nora Field", sfId: "003000000000001AAA" }], source: "salesforce", idempotencyKey: "p1", merge: { matchBy: ["sfId"] } })).json.ids;
    ledger.set(w, "contact", "s-nora", { fullName: "Nora Field", title: "Buyer" }, 1000, { kind: "salesforce", ref: "salesforce:contact:003000000000001AAA" });
    assert.equal((await nudge(w)).status, 200);
    const rows = await sql(w, `SELECT id, stream, title FROM contacts WHERE fullName = 'Nora Field'`);
    assert.deepEqual(rows.map((r) => [r.id, r.stream, r.title]), [[con, "s-nora", "Buyer"]]);

    // A stream for one Salesforce account never takes over a row another Salesforce account holds, even with its domain.
    const [other] = (await upsert(w, [{ domain: "shared.example", name: "Holder Co", sfId: "001000000000009AAA" }], "u3")).json.ids;
    ledger.set(w, "account", "s-intruder", { name: "Intruder", domain: "shared.example" }, 1000, { kind: "salesforce", ref: "salesforce:account:001000000000008AAA" });
    assert.equal((await nudge(w)).status, 200);
    const holder = await account(w, other);
    assert.deepEqual([holder.name, holder.stream], ["Holder Co", undefined]);

    // A Salesforce stream linked to a TAM row by domain gives that row its Salesforce id.
    const [tam] = (await upsert(w, [{ domain: "tam-only.example", name: "TAM Only" }], "u4")).json.ids;
    ledger.set(w, "account", "s-sf2", { name: "TAM Only", domain: "tam-only.example" }, 1000, { kind: "salesforce", ref: "salesforce:account:001000000000007AAA" });
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual([(await account(w, tam)).stream, (await account(w, tam)).sfId], ["s-sf2", "001000000000007AAA"]);

    // Two domainless accounts: clearing one's domain neither folds nor is blocked by the other.
    ledger.set(w, "account", "s-blank", { name: "Blank" }, 1000, { kind: "hubspot", ref: "hubspot:account:9" });
    ledger.set(w, "account", "s-sf", { name: "SF Co", domain: "sf.example" }, 1000, { kind: "import", ref: `record:account:${acc}` });
    ledger.set(w, "account", "s-sf", { domain: null }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const accounts = await sql(w, `SELECT stream, domain FROM accounts WHERE stream IN ('s-blank', 's-sf') ORDER BY stream`);
    assert.deepEqual(accounts.map((r) => [r.stream, r.domain]), [["s-blank", ""], ["s-sf", ""]]);
  });

  it("leaves the row's value for a field the stream never asserted", async () => {
    const w = "r11";
    const [id] = (await upsert(w, [{ domain: "keep.example", name: "Keep", country: "US", industry: "Retail" }], "u1")).json.ids;
    ledger.set(w, "account", "s-keep", { name: "Keep Inc", domain: "keep.example" }, 1000, { kind: "hubspot", ref: "hubspot:account:5" });
    assert.equal((await nudge(w)).status, 200);
    const row = await account(w, id);
    assert.deepEqual([row.stream, row.name, row.country, row.industry], ["s-keep", "Keep Inc", "US", "Retail"]);
    assert.equal((await changes(w)).some((c) => c.id === id && c.op === "edit" && (Array.isArray(c.fields) ? c.fields : Object.keys(c.fields as object)).includes("country")), false);
  });

  it("never folds a row another Salesforce record holds into a stream that names a different Salesforce record", async () => {
    const w = "r12";
    const [mine, theirs] = (await upsert(w, [{ domain: "mine.example", name: "Mine" }, { domain: "theirs.example", name: "Theirs", sfId: "001000000000005AAA" }], "u1")).json.ids;
    ledger.set(w, "account", "s-mine", { name: "Mine", domain: "mine.example" }, 1000, { kind: "import", ref: `record:account:${mine}` });
    ledger.set(w, "account", "s-mine", { name: "Mine" }, 1050, { kind: "salesforce", ref: "salesforce:account:001000000000004AAA" });
    ledger.set(w, "account", "s-mine", { domain: "theirs.example" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    assert.equal((await account(w, theirs)).sfId, "001000000000005AAA", "the other record's row is still there");
    assert.equal((await account(w, mine)).domain, "mine.example");
  });

  it("lands a domain once the record that held it releases it, whatever order the projector applied them in", async () => {
    const w = "r13";
    const [a, b] = (await upsert(w, [{ domain: "x.example", name: "A" }, { domain: "b.example", name: "B" }], "u1")).json.ids;
    ledger.set(w, "account", "s-a", { name: "A", domain: "x.example" }, 1000, { kind: "import", ref: `record:account:${a}` });
    ledger.set(w, "account", "s-b", { name: "B", domain: "b.example" }, 1000, { kind: "import", ref: `record:account:${b}` });
    assert.equal((await nudge(w)).status, 200);
    // B's claim is applied before A's release.
    ledger.set(w, "account", "s-b", { domain: "x.example" }, 1200);
    assert.equal((await nudge(w)).status, 200);
    assert.equal((await account(w, b)).domain, "b.example", "blocked while A holds it");
    ledger.set(w, "account", "s-a", { domain: "a.example" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual([(await account(w, a)).domain, (await account(w, b)).domain], ["a.example", "x.example"]);

    // A wait the ledger moved on from never lands: B waits for a.example, then wants c.example instead.
    ledger.set(w, "account", "s-b", { domain: "a.example" }, 1300);
    assert.equal((await nudge(w)).status, 200);
    ledger.set(w, "account", "s-b", { domain: "c.example" }, 1400);
    ledger.set(w, "account", "s-a", { domain: "z.example" }, 1500);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual([(await account(w, a)).domain, (await account(w, b)).domain], ["z.example", "c.example"]);
  });

  it("swaps two accounts' domains when the ledger swapped them before the projector caught up", async () => {
    const w = "r15";
    const [p, q] = (await upsert(w, [{ domain: "p.example", name: "P" }, { domain: "q.example", name: "Q" }], "u1")).json.ids;
    ledger.set(w, "account", "s-p", { name: "P", domain: "p.example" }, 1000, { kind: "import", ref: `record:account:${p}` });
    ledger.set(w, "account", "s-q", { name: "Q", domain: "q.example" }, 1000, { kind: "import", ref: `record:account:${q}` });
    assert.equal((await nudge(w)).status, 200);
    ledger.set(w, "account", "s-p", { domain: "tmp.example" }, 1100);
    ledger.set(w, "account", "s-q", { domain: "p.example" }, 1200);
    ledger.set(w, "account", "s-p", { domain: "q.example" }, 1300);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual([(await account(w, p)).domain, (await account(w, q)).domain], ["q.example", "p.example"]);
  });

  it("keeps fieldUpdatedAt at the winning value's time even when the value did not change", async () => {
    const w = "r14";
    const [id] = (await upsert(w, [{ domain: "same.example", name: "Same", industry: "Retail" }], "u1")).json.ids;
    ledger.set(w, "account", "s-same", { name: "Same", domain: "same.example", industry: "Retail" }, 1000, { kind: "import", ref: `record:account:${id}` });
    ledger.set(w, "account", "s-same", { industry: "Retail" }, 5000, { kind: "salesforce", ref: "salesforce:account:001000000000006AAA" });
    assert.equal((await nudge(w)).status, 200);
    assert.equal((await account(w, id)).fieldUpdatedAt.industry, 5000);
  });

  it("clears every value the ledger erased from the row", async () => {
    const w = "r16";
    const [acc] = (await upsert(w, [{ domain: "erase.example", name: "Erase Co" }], "u1")).json.ids;
    const [con] = (await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Ivy Gone", email: "ivy@erase.example" }], source: "pipe0", idempotencyKey: "p1" })).json.ids;
    ledger.set(w, "contact", "s-ivy", { fullName: "Ivy Gone", email: "ivy@erase.example", phone: "+1 555" }, 1000, { kind: "import", ref: `record:contact:${con}` });
    assert.equal((await nudge(w)).status, 200);
    ledger.append(w, "contact", "s-ivy", { kind: "lifecycle", op: "erase" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const [row] = await sql(w, `SELECT fullName, email, phone, deletedAt FROM contacts WHERE id = '${con}'`);
    assert.deepEqual([row.fullName, row.email, row.phone, row.deletedAt != null], ["", null, null, true]);
  });

  it("drops a record deleted on the ledger from lists, counts and facets, and brings it back on restore", async () => {
    const w = "r4";
    const [id] = (await upsert(w, [{ domain: "gone.example", name: "Gone", industry: "Retail" }, { domain: "kept.example", name: "Kept", industry: "Retail" }], "u1")).json.ids;
    ledger.set(w, "account", "s-gone", { name: "Gone", domain: "gone.example" }, 1000, { kind: "import", ref: `record:account:${id}` });
    ledger.append(w, "account", "s-gone", { kind: "lifecycle", op: "delete" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const names = async () => (await ws(w).post("accounts/list", {})).json.rows.map((r: { name: string }) => r.name);
    assert.deepEqual(await names(), ["Kept"]);
    assert.equal((await ws(w).post("segments/count", { filter: {} })).json.total, 1);
    assert.equal((await ws(w).post("accounts/facets", { groupBy: "industry" })).json.total, 1);

    ledger.append(w, "account", "s-gone", { kind: "lifecycle", op: "restore" }, 1200);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual((await names()).sort(), ["Gone", "Kept"]);
  });

  it("lists worked and unworked rows through register/<object>/list with the generic list request, leaving out rows deleted on the ledger", async () => {
    const w = "r4l";
    const [worked, gone] = (await upsert(w, [
      { domain: "worked.example", name: "Worked", industry: "Retail", employees: 50, segmentIds: ["s1"] },
      { domain: "gone.example", name: "Gone", industry: "Retail", employees: 60 },
      { domain: "tam1.example", name: "Tam One", industry: "Retail", employees: 70 },
      { domain: "tam2.example", name: "Tam Two", industry: "", employees: 80 },
    ], "u1")).json.ids;
    ledger.set(w, "account", "s-worked", { name: "Worked", domain: "worked.example", industry: "Software" }, 1000, { kind: "import", ref: `record:account:${worked}` });
    ledger.set(w, "account", "s-gone", { name: "Gone", domain: "gone.example" }, 1000, { kind: "import", ref: `record:account:${gone}` });
    ledger.append(w, "account", "s-gone", { kind: "lifecycle", op: "delete" }, 1100);
    assert.equal((await nudge(w)).status, 200);

    const list = async (body: unknown) => (await ws(w).post("register/account/list", body)).json;
    const page1 = await list({ sort: { field: "employees", dir: "asc" }, limit: 2 });
    assert.equal(page1.total, 3);
    assert.deepEqual(page1.rows.map((r: { title: string; stream: string | null }) => [r.title, r.stream]), [["Worked", "s-worked"], ["Tam One", null]]);
    assert.deepEqual([page1.rows[0].values.industry, page1.rows[0].values.segmentIds], ["Software", ["s1"]]);
    const page2 = await list({ sort: { field: "employees", dir: "asc" }, limit: 2, cursor: page1.nextCursor });
    assert.deepEqual([page2.rows.map((r: { title: string }) => r.title), page2.nextCursor], [["Tam Two"], null]);
    // Empty text reads as empty, as the fake reads it.
    assert.deepEqual((await list({ filter: [{ field: "industry", op: "empty" }] })).rows.map((r: { title: string }) => r.title), ["Tam Two"]);
    assert.equal((await ws(w).post("register/account/list", { filter: [{ field: "nope", op: "empty" }] })).status, 400);
  });

  it("lists, filters and sorts on the workspace's custom fields, keeps a multi-value field's order, and leaves archived fields out (1.22.0)", async () => {
    const w = "r4c";
    const [a, b] = (await upsert(w, [{ domain: "a.example", name: "A" }, { domain: "b.example", name: "B" }, { domain: "c.example", name: "C" }], "u1")).json.ids;
    const field = (slug: string, rest: Record<string, unknown>) => ({ fieldId: `custom.${slug}`, apiName: `custom.${slug}`, label: slug, ...rest });
    ledger.extensions.set(w, {
      account: {
        registryVersion: 1,
        customFields: [
          field("renewal_risk", { type: "picklist", options: [{ value: "high", label: "High", active: true }, { value: "low", label: "Low", active: true }] }),
          field("seats", { type: "number" }),
          field("emails", { type: "emails" }),
          field("old", { type: "text", archivedAt: 1 }),
        ],
      } as never,
    });
    ledger.set(w, "account", "s-a", { name: "A", domain: "a.example", "custom.renewal_risk": "high", "custom.seats": 120, "custom.emails": ["z@a.example", "b@a.example"], "custom.old": "x" }, 1000, { kind: "import", ref: `record:account:${a}` });
    ledger.set(w, "account", "s-b", { name: "B", domain: "b.example", "custom.renewal_risk": "low", "custom.seats": 9 }, 1000, { kind: "import", ref: `record:account:${b}` });
    assert.equal((await nudge(w)).status, 200);

    const list = async (body: unknown) => (await ws(w).post("register/account/list", body)).json;
    const titles = (page: { rows: Array<{ title: string }> }) => page.rows.map((r) => r.title);
    const high = await list({ filter: [{ field: "custom.renewal_risk", op: "eq", value: "high" }] });
    assert.deepEqual(titles(high), ["A"]);
    assert.deepEqual(high.rows[0].values["custom.emails"], ["z@a.example", "b@a.example"], "the primary stays first");
    assert.equal("custom.old" in high.rows[0].values, false);
    assert.deepEqual(titles(await list({ sort: { field: "custom.seats", dir: "asc" } })), ["B", "A", "C"], "empty sorts last");
    assert.deepEqual(titles(await list({ filter: [{ field: "custom.emails", op: "hasAny", value: ["b@a.example"] }] })), ["A"]);
    assert.equal((await ws(w).post("register/account/list", { filter: [{ field: "custom.old", op: "empty" }] })).status, 400);
  });

  it("folds an unlinked row into the linked one when the ledger moves the company to that row's domain, keeping its Salesforce id and segments", async () => {
    const w = "r5";
    const [oldId, dupId] = (await upsert(w, [{ domain: "old.example", name: "Acme", segmentIds: ["s1"] }, { domain: "acme.example", name: "Acme (TAM)", sfId: "001000000000001AAA", segmentIds: ["s2"] }], "u1")).json.ids;
    await ws(w).post("accounts/annotate", { records: [{ id: dupId, revenue: 5_000_000, revenueSource: "estimate", traits: { model: "b2b" } }] });
    await ws(w).post("contacts/upsert", { records: [{ accountId: dupId, fullName: "Eve Stone" }], source: "pipe0", idempotencyKey: "p1" });
    ledger.set(w, "account", "s-acme", { name: "Acme", domain: "old.example" }, 1000, { kind: "import", ref: `record:account:${oldId}` });
    ledger.set(w, "account", "s-acme", { domain: "acme.example" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const rows = await sql(w, `SELECT id, domain, stream FROM accounts ORDER BY id`);
    assert.deepEqual(rows.map((r) => [r.id, r.domain, r.stream]), [[oldId, "acme.example", "s-acme"]]);
    const eve = await sql(w, `SELECT accountId FROM contacts WHERE fullName = 'Eve Stone'`);
    assert.deepEqual(eve.map((r) => r.accountId), [oldId], "the folded row's contacts move to the company's row");
    const merged = await account(w, oldId);
    assert.deepEqual([merged.sfId, merged.segmentIds.sort(), merged.revenue, merged.traits], ["001000000000001AAA", ["s1", "s2"], 5_000_000, { model: "b2b" }]);
  });

  it("does not fold two companies Salesforce knows as different records: the row keeps its domain", async () => {
    const w = "r7";
    const [a, b] = (await upsert(w, [{ domain: "one.example", name: "One", sfId: "001000000000002AAA" }, { domain: "two.example", name: "Two", sfId: "001000000000003AAA" }], "u1")).json.ids;
    ledger.set(w, "account", "s-one", { name: "One", domain: "one.example" }, 1000, { kind: "import", ref: `record:account:${a}` });
    ledger.set(w, "account", "s-one", { domain: "two.example" }, 1100);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual([(await account(w, a)).domain, (await account(w, b)).domain], ["one.example", "two.example"]);
  });

  it("a rebuild links and writes back streams that were projected before the register existed", async () => {
    const w = "r6";
    const [id] = (await upsert(w, [{ domain: "late.example", name: "Late Co" }], "u1")).json.ids;
    ledger.set(w, "account", "s-late", { name: "Late Co", domain: "late.example", industry: "Software" }, 1000, { kind: "import", ref: `record:account:${id}` });
    assert.equal((await nudge(w)).status, 200);
    // As before migration 6: no link, no written-back values.
    await ctx.app.registry.with(w, (x) => x.write((c) => c.run(`UPDATE accounts SET stream = NULL, ledgerVersion = NULL, industry = NULL`), "exclusive"));
    const rebuilt = await ws(w).post("projector/rebuild", { object: "account" });
    assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.json));
    const row = await account(w, id);
    assert.deepEqual([row.stream, row.ledgerVersion, row.industry], ["s-late", 1, "Software"]);
  });

  it("search finds register accounts and contacts, worked or not, by name, domain or email, by record id and with a detail", async () => {
    const w = "r-search";
    const [zenith] = (await upsert(w, [{ domain: "zenith.example", name: "Zenith Labs" }, { domain: "zenpeak.example", name: "Peak" }, { domain: "nope.example", name: "Nope" }], "u1")).json.ids;
    const added = await ws(w).post("contacts/upsert", { records: [{ accountId: zenith, fullName: "Zoe Lane", email: "zoe@zenith.example" }], source: "pipe0", idempotencyKey: "c1" });
    assert.equal(added.json.upserted, 1, JSON.stringify(added.json));
    ledger.set(w, "account", "s-zen", { name: "Zenith Labs", domain: "zenith.example" }, 1000, { kind: "import", ref: `record:account:${zenith}` });
    ledger.set(w, "deal", "s-deal", { name: "Zenith expansion", amount: 5000, currency: "USD", stage: "proposal" }, 1001);
    assert.equal((await nudge(w)).status, 200);
    const [{ id: zoe }] = await sql(w, `SELECT id FROM contacts`);
    const [{ id: peak }] = await sql(w, `SELECT id FROM accounts WHERE name = 'Peak'`);

    type Hit = { object: string; id: string; title: string; detail?: unknown };
    const hits = ((await ws(w).post("p/search", { q: "ZEN" })).json.hits as Hit[]).map((h) => [h.object, h.id, h.title, h.detail]);
    assert.deepEqual(hits.sort((a, b) => `${a[0]}${a[2]}`.localeCompare(`${b[0]}${b[2]}`)), [
      ["account", peak, "Peak", { domain: "zenpeak.example" }],
      ["account", zenith, "Zenith Labs", { domain: "zenith.example" }],
      ["contact", zoe, "Zoe Lane", { email: "zoe@zenith.example", company: "Zenith Labs" }],
      ["deal", "s-deal", "Zenith expansion", { amount: 5000, currency: "USD", stage: "proposal" }],
    ]);
    const bounded = (await ws(w).post("p/search", { q: "zen", perObject: 1, objects: ["account"] })).json.hits as Hit[];
    assert.deepEqual(bounded.map((h) => h.id), [zenith], "one per object, the title that starts with the query first");
  });

  it("links a ledger contact to the account its email's domain names, whichever arrives first, never by a personal domain (1.16.0)", async () => {
    const w = "r21";
    const [acme] = (await upsert(w, [{ domain: "acme.example", name: "Acme", industry: "Software" }], "u21")).json.ids;
    ledger.set(w, "contact", "s-ann", { fullName: "Ann Acme", email: "Ann@Acme.example" }, 1000, { kind: "hubspot", ref: "hubspot:contact:8" });
    ledger.set(w, "contact", "s-bo", { fullName: "Bo Free", email: "bo@gmail.com" }, 1000, { kind: "hubspot", ref: "hubspot:contact:9" });
    ledger.set(w, "contact", "s-cy", { fullName: "Cy Later", email: "cy@later.example" }, 1000, { kind: "hubspot", ref: "hubspot:contact:10" });
    assert.equal((await nudge(w)).status, 200);
    // The company Cy works at arrives after Cy.
    const [later] = (await upsert(w, [{ domain: "later.example", name: "Later" }], "u21b")).json.ids;
    await upsert(w, [{ domain: "gmail.com", name: "Google Mail" }], "u21c");
    const gate = { id: "sw", base: 10, max: 50, industries: { software: 40 }, countries: {}, employees: [], excludeIndustries: [], excludeCountries: [], custom: [] };
    assert.equal((await ws(w).post("rescore", { icp: {}, gates: [gate] })).status, 200);
    const rows = (await ws(w).post("register/contact/list", { sort: { field: "fullName", dir: "asc" } })).json.rows as Array<{ title: string; accountId: string; values: Record<string, unknown> }>;
    assert.deepEqual(rows.map((r) => [r.title, r.accountId, r.values.accountIcpIds]), [["Ann Acme", acme, ["sw"]], ["Bo Free", "", null], ["Cy Later", later, null]]);
    const history = await sql(w, `SELECT id, field, newValue, source FROM field_history WHERE field = 'accountId' ORDER BY newValue`);
    assert.deepEqual(history.map((h) => [h.field, h.newValue, h.source]), [["accountId", acme, "link:domain"], ["accountId", later, "link:domain"]].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
  });

  it("writes a contact's accountId from its primary edge, which upserts and domain linking then leave alone (1.20.0)", async () => {
    const w = "r22";
    const [acme, beta] = (await upsert(w, [{ domain: "acme.example", name: "Acme" }, { domain: "beta.example", name: "Beta" }], "u22")).json.ids;
    const addAnn = (key: string) => ws(w).post("contacts/upsert", { records: [{ fullName: "Ann", email: "ann@acme.example", accountId: acme }], source: "csv", idempotencyKey: key });
    const [ann] = (await addAnn("c22")).json.ids;
    const accountOf = async () => (await sql(w, `SELECT accountId, accountLedger FROM contacts WHERE id = '${ann}'`)).map((r) => [r.accountId, r.accountLedger])[0];

    ledger.set(w, "association", "s-e1", { association: "contact_account", fromId: ann, toId: acme, primary: true }, 1000, { kind: "import", ref: `record:contact:${ann}` });
    ledger.set(w, "association", "s-e2", { association: "contact_account", fromId: ann, toId: beta, primary: false }, 1001);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual(await accountOf(), [acme, true]);

    // Make Beta primary: both edges change in one Convex transaction.
    ledger.set(w, "association", "s-e1", { primary: false }, 1100);
    ledger.set(w, "association", "s-e2", { primary: true }, 1100);
    assert.equal((await nudge(w)).status, 200);
    assert.deepEqual(await accountOf(), [beta, true]);
    const history = await sql(w, `SELECT oldValue, newValue, actorId, source FROM field_history WHERE id = '${ann}' AND source LIKE 'ledger:%'`);
    assert.deepEqual(history.map((h) => [h.oldValue, h.newValue, h.actorId, h.source]), [[acme, beta, "u1", "ledger:user"]], "one change, by the person who moved the primary");

    // A CSV that names Acme does not move her back.
    assert.equal((await addAnn("c22b")).status, 200);
    assert.deepEqual(await accountOf(), [beta, true]);

    // Removing her only company leaves her with none: her email's domain does not link her again.
    ledger.set(w, "association", "s-e2", { primary: false }, 1200);
    ledger.append(w, "association", "s-e2", { kind: "lifecycle", op: "delete" }, 1200);
    assert.equal((await nudge(w)).status, 200);
    assert.equal((await addAnn("c22c")).status, 200);
    assert.deepEqual(await accountOf(), ["", true]);
  });

  it("finds a contact by email whatever the case it was written in", async () => {
    const w = "r20";
    await ws(w).post("provision");
    ledger.set(w, "contact", "s-jane", { fullName: "Jane Roe", email: "Jane@X.com" }, 1000, { kind: "hubspot", ref: "hubspot:contact:7" });
    assert.equal((await nudge(w)).status, 200);
    const list = async (op: string, value: unknown) => (await ws(w).post("register/contact/list", { filter: [{ field: "email", op, value }] })).json.rows.map((r: { values: { email: string } }) => r.values.email);
    assert.deepEqual(await list("in", ["jane@x.com"]), ["Jane@X.com"]);
    assert.deepEqual(await list("eq", "JANE@x.com"), ["Jane@X.com"]);
  });

  it("writes a person's other emails back as a list, finds them by any email, and leaves a row from before with none (1.28.0)", async () => {
    const w = "r-emails";
    const [acc] = (await upsert(w, [{ domain: "lane.example", name: "Lane" }], "u1")).json.ids;
    const [con] = (await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Lou Lane", email: "lou@lane.example" }], source: "pipe0", idempotencyKey: "p1" })).json.ids;
    const [old] = (await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Old Row", email: "old@lane.example" }], source: "pipe0", idempotencyKey: "p2" })).json.ids;
    ledger.set(w, "contact", "s-lou", { fullName: "Lou Lane", email: "lou@lane.example" }, 1000, { kind: "import", ref: `record:contact:${con}` });
    ledger.set(w, "contact", "s-lou", { additionalEmails: ["lou@home.example", "l.lane@lane.example"], additionalPhones: ["+1 555 0199"] }, 1100);
    assert.equal((await nudge(w)).status, 200);
    const list = async (op: string, value: unknown) =>
      (await ws(w).post("register/contact/list", { filter: [{ field: "email", op, value }] })).json.rows.map((r: { id: string }) => r.id).sort();
    assert.deepEqual(await list("eq", "LOU@home.example"), [con]);
    assert.deepEqual(await list("in", ["l.lane@lane.example", "old@lane.example"]), [con, old].sort());
    assert.deepEqual(await list("contains", "home"), [con]);
    const rows = (await ws(w).post("register/contact/list", { filter: [{ field: "id", op: "in", value: [con, old] }] })).json.rows as Array<{ id: string; values: Record<string, unknown> }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, [r.values.additionalEmails, r.values.additionalPhones]]));
    assert.deepEqual(byId[con], [["lou@home.example", "l.lane@lane.example"], ["+1 555 0199"]], "the order holds");
    assert.deepEqual(byId[old], [null, null], "a row from before reads as its single email");
    // A TAM upsert naming the second email is the same person, not a new row.
    const again = await ws(w).post("contacts/upsert", { records: [{ accountId: acc, fullName: "Lou Lane", email: "lou@home.example" }], source: "pdl", idempotencyKey: "p3" });
    assert.deepEqual(again.json.ids, [con]);
  });
});
