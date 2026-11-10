// Contract 1.2.0: sfId identity, merge hints, rejections, fieldUpdatedAt,
// edit source/sourceTimestamp, metadata-driven objects, history, outbox origin.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { normalizeSfId } from "../src/contract.ts";
import { startApp } from "./helpers.ts";

// Real-shaped ids (15-char form + computed suffix).
const sf = (prefix: string, n: number) => normalizeSfId(`${prefix}${String(n).padStart(12, "0")}`)!;

describe("contract 1.2.0 sync surface", () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => {
    ctx = await startApp();
  });
  after(async () => {
    await ctx.app.shutdown();
  });

  it("normalizes 15-char Salesforce ids to 18 and rejects bad checksums", () => {
    assert.equal(normalizeSfId("001000000000001"), "001000000000001AAA");
    assert.equal(normalizeSfId("001Ab0000000XyZ")?.length, 18);
    const good = normalizeSfId("001Ab0000000XyZ")!;
    assert.equal(normalizeSfId(good), good);
    assert.equal(normalizeSfId(good.slice(0, 15) + "ZZZ"), null);
    assert.equal(normalizeSfId("short"), null);
  });

  it("matches accounts by sfId then domain, merges TAM rows, rejects collisions with reasons, and re-runs as a no-op", async () => {
    const ws = ctx.client.ws("sfacc");
    await ws.post("provision");
    // TAM rows with no sfId.
    await ws.post("accounts/upsert", { records: [{ domain: "tam1.com", name: "Tam One" }, { domain: "tam2.com", name: "Tam Two" }], source: "tam", idempotencyKey: "tam" });
    const s1 = sf("001", 1), s2 = sf("001", 2), s3 = sf("001", 3), s4 = sf("001", 4);
    const batch = [
      { sfId: s1, domain: "tam1.com", name: "Tam One Inc" }, // merges into TAM row
      { sfId: s2, domain: "new.com", name: "New Co" }, // created
      { sfId: s3, domain: "tam1.com", name: "Dup" }, // same domain, different sfId -> rejected
      { sfId: s4.slice(0, 15), domain: "fifteen.com", name: "Fifteen" }, // 15-char id normalized
    ];
    const r = await ws.post("accounts/upsert", { records: batch, source: "salesforce", idempotencyKey: "imp1", merge: { matchBy: ["sfId", "domain"] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.created, 2);
    assert.equal(r.json.merged, 1);
    assert.equal(r.json.upserted, 3);
    assert.equal(r.json.rejected.length, 1);
    assert.equal(r.json.rejected[0].index, 2);
    assert.equal(r.json.rejected[0].sfId, s3);
    assert.match(r.json.rejected[0].reason, /already linked to Salesforce id/);
    assert.equal(r.json.upserted + r.json.rejected.length, batch.length);

    const list = await ws.post("accounts/list", { limit: 200 });
    assert.equal(list.json.total, 4);
    const tam1 = list.json.rows.find((a: any) => a.domain === "tam1.com");
    assert.equal(tam1.sfId, s1);
    assert.equal(tam1.name, "Tam One Inc");
    assert.ok(tam1.fieldUpdatedAt.sfId > 0 && tam1.fieldUpdatedAt.name > 0);
    assert.equal(list.json.rows.find((a: any) => a.domain === "fifteen.com").sfId, s4);

    // 1.2.1: exact sfId filter (15- or 18-char input) on accounts/list.
    const byId = await ws.post("accounts/list", { filter: { sfId: s4.slice(0, 15) }, limit: 5 });
    assert.equal(byId.status, 200, JSON.stringify(byId.json));
    assert.deepEqual(byId.json.rows.map((a: any) => a.sfId), [s4]);
    const none = await ws.post("accounts/list", { filter: { sfId: sf("001", 999) }, limit: 5 });
    assert.equal(none.json.total, 0);

    // sfId wins over domain: the Salesforce account changed its website.
    const moved = await ws.post("accounts/upsert", { records: [{ sfId: s2, domain: "renamed.com", name: "New Co" }], source: "salesforce", idempotencyKey: "imp2" });
    assert.equal(moved.json.created, 0);
    assert.equal(moved.json.ids[0], r.json.ids[1]);
    assert.equal((await ws.post("accounts/get", { id: r.json.ids[1] })).json.account.domain, "renamed.com");

    // Re-run with a fresh key: no new rows, no changes, no duplicate sfIds.
    const before = (await ws.get("changes?after=0&limit=500")).json.lastSeq;
    const again = await ws.post("accounts/upsert", { records: batch.slice(0, 1), source: "salesforce", idempotencyKey: "imp3" });
    assert.equal(again.json.created, 0);
    assert.equal(again.json.merged, 0);
    assert.equal((await ws.get(`changes?after=${before}`)).json.changes.length, 0);
    const sfIds = (await ws.post("accounts/list", { limit: 200 })).json.rows.map((a: any) => a.sfId).filter(Boolean);
    assert.equal(new Set(sfIds).size, sfIds.length);

    // matchBy without domain: a TAM domain collision is rejected, not merged.
    const strict = await ws.post("accounts/upsert", { records: [{ sfId: sf("001", 9), domain: "tam2.com", name: "X" }], source: "salesforce", idempotencyKey: "imp4", merge: { matchBy: ["sfId"] } });
    assert.equal(strict.json.upserted, 0);
    assert.match(strict.json.rejected[0].reason, /matchBy does not include domain/);

    // Invalid sfId is a 400 (contract validation).
    assert.equal((await ws.post("accounts/upsert", { records: [{ sfId: "bad", domain: "x.com", name: "X" }], source: "s", idempotencyKey: "bad" })).status, 400);
  });

  it("matches contacts by sfId, email, linkedinUrl; resolves accounts by accountSfId; rejects unknown accounts per row", async () => {
    const ws = ctx.client.ws("sfcon");
    await ws.post("provision");
    const a1 = sf("001", 11);
    await ws.post("accounts/upsert", { records: [{ sfId: a1, domain: "acme.com", name: "Acme" }], source: "salesforce", idempotencyKey: "a" });
    await ws.post("contacts/upsert", { records: [{ accountDomain: "acme.com", fullName: "Ada", email: "ada@acme.com" }, { accountDomain: "acme.com", fullName: "Lin", linkedinUrl: "https://linkedin.com/in/lin" }], source: "tam", idempotencyKey: "tam" });
    const c1 = sf("003", 1), c2 = sf("003", 2), c3 = sf("003", 3), c4 = sf("003", 4);
    const recs = [
      { sfId: c1, accountSfId: a1, fullName: "Ada L", email: "ADA@acme.com" }, // merge by email
      { sfId: c2, accountSfId: a1, fullName: "Lin", linkedinUrl: "https://LinkedIn.com/in/lin" }, // merge by linkedin (case-insensitive)
      { sfId: c3, accountSfId: sf("001", 99), fullName: "Orphan" }, // unknown account -> rejected
      { sfId: c4, accountSfId: a1, fullName: "Bob", email: "ada@acme.com" }, // email owned by c1 -> rejected
    ];
    const r = await ws.post("contacts/upsert", { records: recs, source: "salesforce", idempotencyKey: "c", merge: { matchBy: ["sfId", "email", "linkedinUrl"] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.merged, 2);
    assert.equal(r.json.created, 0);
    assert.deepEqual(r.json.rejected.map((x: any) => x.index), [2, 3]);
    assert.match(r.json.rejected[0].reason, /unknown account/);
    assert.match(r.json.rejected[1].reason, /already linked to Salesforce id/);
    const cl = await ws.post("contacts/list", { limit: 50 });
    assert.equal(cl.json.total, 2);
    assert.deepEqual(cl.json.rows.map((c: any) => c.sfId).sort(), [c1, c2].sort());
    assert.equal(cl.json.rows.find((c: any) => c.sfId === c1).fullName, "Ada L");
  });

  it("records/edit takes source, sourceTimestamp and expectedVersion; outbox carries fields, values and origin", async () => {
    const ws = ctx.client.ws("sfedit");
    await ws.post("provision");
    const up = await ws.post("accounts/upsert", { records: [{ sfId: sf("001", 21), domain: "e.com", name: "E" }], source: "salesforce", idempotencyKey: "u" });
    const id = up.json.ids[0];
    const e = await ws.post("records/edit", { object: "account", id, patch: { name: "E2" }, actorId: "sync", idempotencyKey: "e1", source: "salesforce", sourceTimestamp: 1_700_000_000_000, expectedVersion: 1 });
    assert.equal(e.json.version, 2);
    assert.ok(e.json.at > 1_700_000_000_000, "at is the service's commit clock; sourceTimestamp stamps fieldUpdatedAt");
    const stale = await ws.post("records/edit", { object: "account", id, patch: { name: "E3" }, actorId: "u", idempotencyKey: "e2", expectedVersion: 1 });
    assert.equal(stale.status, 409);
    await ws.post("records/edit", { object: "account", id, patch: { ownerId: "u9" }, actorId: "user-1", idempotencyKey: "e3" });
    const acc = (await ws.post("accounts/get", { id })).json.account;
    assert.equal(acc.fieldUpdatedAt.name, 1_700_000_000_000);
    assert.ok(acc.fieldUpdatedAt.ownerId > 1_700_000_000_000);
    const ch = (await ws.get("changes?after=0")).json.changes;
    assert.deepEqual(ch.map((c: any) => [c.op, c.origin, c.fields]), [
      ["upsert", "salesforce", ["domain", "name", "sfId"]],
      ["edit", "salesforce", ["name"]],
      ["edit", "fsgtm", ["ownerId"]],
    ]);
    assert.equal(ch[1].values.name, "E2");
    const hist = await ws.post("history", { object: "account", id });
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.json.rows.map((h: any) => [h.field, h.newValue, h.source, h.actorId]), [["ownerId", "u9", "fsgtm", "user-1"], ["name", "E2", "salesforce", "sync"]]);
  });

  it("defines objects and upserts, lists, gets, edits and histories custom records", async () => {
    const ws = ctx.client.ws("sfobj");
    await ws.post("provision");
    const def = {
      name: "Project__c", label: "Project",
      fields: [
        { name: "Name", type: "string" }, { name: "Budget__c", type: "number" }, { name: "Active__c", type: "boolean" },
        { name: "Start__c", type: "date" }, { name: "Account__c", type: "reference", referenceTo: ["Account"] },
      ],
    };
    assert.deepEqual((await ws.post("objects/define", { objects: [def] })).json, { defined: 1 });
    assert.equal((await ws.post("objects/Nope__c/list", {})).status, 404);
    assert.equal((await ws.post("objects/bad-name/list", {})).status, 400);
    const ids = Array.from({ length: 120 }, (_, i) => sf("a01", i));
    const recs = ids.map((id, i) => ({ sfId: id, fields: { Name: `P${i}`, Budget__c: String(i * 10), Active__c: i % 2 ? "true" : "false", Start__c: "2026-01-02" } }));
    recs.push({ sfId: sf("a01", 999), fields: { Name: "Bad", Budget__c: "lots" } as any });
    recs.push({ sfId: sf("a01", 998), fields: { Name: "Bad2", Unknown__c: 1 } as any });
    const up = await ws.post("objects/Project__c/upsert", { records: recs, source: "salesforce", idempotencyKey: "p1" });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.equal(up.json.created, 120);
    assert.equal(up.json.upserted, 120);
    assert.deepEqual(up.json.rejected.map((r: any) => r.index), [120, 121]);
    assert.match(up.json.rejected[0].reason, /Budget__c: not a number/);
    assert.match(up.json.rejected[1].reason, /not defined/);
    // Idempotent re-run with another key changes nothing.
    const again = await ws.post("objects/Project__c/upsert", { records: recs.slice(0, 120), source: "salesforce", idempotencyKey: "p2" });
    assert.equal(again.json.created, 0);
    // Paging covers every row exactly once.
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const p = await ws.post("objects/Project__c/list", { limit: 50, ...(cursor ? { cursor } : {}) });
      assert.equal(p.json.total, 120);
      for (const r of p.json.rows) seen.add(r.id);
      cursor = p.json.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 120);
    const q = await ws.post("objects/Project__c/list", { filter: { q: "p119" } });
    assert.equal(q.json.total, 1);
    const id = q.json.rows[0].id;
    const got = (await ws.post("objects/Project__c/get", { id })).json.record;
    assert.equal(got.fields.Budget__c, 1190);
    assert.equal(got.fields.Active__c, true);
    assert.equal(got.sfId, ids[119]);
    const e = await ws.post("objects/Project__c/edit", { id, fields: { Budget__c: 5 }, expectedVersion: 1, actor: "u1", source: "fsgtm" });
    assert.deepEqual(e.json, { version: 2 });
    assert.equal((await ws.post("objects/Project__c/edit", { id, fields: { Budget__c: 6 }, expectedVersion: 1, actor: "u1", source: "fsgtm" })).status, 409);
    assert.equal((await ws.post("objects/Project__c/edit", { id, fields: { Nope: 6 }, actor: "u1", source: "fsgtm" })).status, 400);
    const h = await ws.post("history", { object: "Project__c", id });
    assert.deepEqual(h.json.rows.map((r: any) => [r.field, r.oldValue, r.newValue]), [["Budget__c", "1190", "5"]]);
    const after = (await ws.post("objects/Project__c/list", { filter: { updatedAfter: got.updatedAt } })).json;
    assert.deepEqual(after.rows.map((r: any) => r.id), [id]);
    const ch = (await ws.get("changes?after=0&limit=500")).json.changes;
    assert.equal(ch.filter((c: any) => c.object === "Project__c" && c.op === "upsert").length, 120);
    assert.deepEqual(ch.at(-1).fields, ["Budget__c"]);
    // Redefining an object (new field) keeps its records.
    await ws.post("objects/define", { objects: [{ ...def, fields: [...def.fields, { name: "Notes__c", type: "string" }] }] });
    assert.equal((await ws.post("objects/Project__c/edit", { id, fields: { Notes__c: "hi" }, actor: "u1", source: "fsgtm" })).json.version, 3);
  });

  it("a 10k-account / 10k-contact import in full 5,000-row batches lands every row and re-runs as a no-op", async () => {
    const ws = ctx.client.ws("sfscale");
    await ws.post("provision");
    const N = 10_000, M = 10_000;
    const t0 = Date.now();
    for (let off = 0; off < N; off += 5000) {
      const recs = Array.from({ length: 5000 }, (_, k) => ({ sfId: sf("001", off + k), domain: `s${off + k}.example.com`, name: `S ${off + k}` }));
      const r = await ws.post("accounts/upsert", { records: recs, source: "salesforce", idempotencyKey: `a${off}` });
      assert.equal(r.json.created, 5000);
    }
    for (let off = 0; off < M; off += 5000) {
      const recs = Array.from({ length: 5000 }, (_, k) => ({ sfId: sf("003", off + k), accountSfId: sf("001", (off + k) % N), fullName: `C ${off + k}`, email: `c${off + k}@s${(off + k) % N}.example.com` }));
      const r = await ws.post("contacts/upsert", { records: recs, source: "salesforce", idempotencyKey: `c${off}` });
      assert.equal(r.json.created, 5000, JSON.stringify(r.json.rejected?.slice(0, 2)));
    }
    const rerun = await ws.post("contacts/upsert", {
      records: Array.from({ length: 5000 }, (_, k) => ({ sfId: sf("003", k), accountSfId: sf("001", k % N), fullName: `C ${k}`, email: `c${k}@s${k % N}.example.com` })),
      source: "salesforce", idempotencyKey: "rerun",
    });
    assert.equal(rerun.json.created, 0);
    assert.equal((await ws.post("contacts/list", { limit: 1 })).json.total, M);
    assert.equal((await ws.post("accounts/list", { limit: 1 })).json.total, N);
    console.log(`# 10k/10k import: ${Date.now() - t0} ms`);
  });
});
