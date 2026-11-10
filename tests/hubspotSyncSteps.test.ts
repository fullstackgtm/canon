import assert from "node:assert/strict";
import test from "node:test";
import { createHubspotConnector, type HubspotSyncObject, type HubspotSyncPage } from "../engine/src/connectors/hubspot.ts";
import { fakeHubspotFetch, scaledPortal, touchRecords } from "../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";
import { FULL_SYNC_EVERY_MS, MODIFIED_OVERLAP_MS, mappingsKey, planHubspotSync } from "../convex/lib/hubspotSyncPlan.ts";
import { sameValue, syncFingerprint, unchangedRow } from "../convex/lib/syncUnchanged.ts";
import { prefetchPages, writeInOrder } from "../convex/lib/pagePrefetch.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a sync reads only what changed once a complete sync left a mark, and every record otherwise", () => {
  const now = 100 * DAY;
  const key = mappingsKey({ accounts: { name: "name" } });
  const done = { modifiedSince: now - DAY, fullSyncAt: now - 2 * DAY, mappingsKey: key };
  assert.deepEqual(planHubspotSync(done, { hasCounts: true, mappingsKey: key, now }), { mode: "incremental", since: now - DAY - MODIFIED_OVERLAP_MS });
  // No complete sync yet, no counts to add to, changed mappings, or a full sync too long ago: read everything.
  assert.deepEqual(planHubspotSync(null, { hasCounts: true, mappingsKey: key, now }), { mode: "full" });
  assert.deepEqual(planHubspotSync({ modifiedSince: now - DAY }, { hasCounts: true, mappingsKey: key, now }), { mode: "full" });
  assert.deepEqual(planHubspotSync(done, { hasCounts: false, mappingsKey: key, now }), { mode: "full" });
  assert.deepEqual(planHubspotSync(done, { hasCounts: true, mappingsKey: mappingsKey({ accounts: { name: "company_name" } }), now }), { mode: "full" });
  assert.deepEqual(planHubspotSync({ ...done, fullSyncAt: now - FULL_SYNC_EVERY_MS }, { hasCounts: true, mappingsKey: key, now }), { mode: "full" });
  // A sync that started and never succeeded may have created records an incremental sync would not count.
  assert.deepEqual(planHubspotSync({ ...done, openSince: now - DAY }, { hasCounts: true, mappingsKey: key, now }), { mode: "full" });
  // Full resync: the user asked to read everything again.
  assert.deepEqual(planHubspotSync(done, { hasCounts: true, mappingsKey: key, now, full: true }), { mode: "full" });
  // Key order does not change the mappings' name.
  assert.equal(mappingsKey({ a: 1, b: { c: [1, 2] } }), mappingsKey({ b: { c: [1, 2] }, a: 1, d: undefined }));
  assert.notEqual(mappingsKey(null), mappingsKey({}));
});

test("a row is unchanged when every synced value is, whatever its bookkeeping times", () => {
  const existing = { name: "Acme", rawData: { a: 1, b: { c: "x" } }, lastSyncAt: 1, updatedAt: 1, createdAt: 5 };
  assert.equal(unchangedRow(existing, { name: "Acme", rawData: { b: { c: "x" }, a: 1 }, lastSyncAt: 9, updatedAt: 9 }), true);
  assert.equal(unchangedRow(existing, { name: "Acme", domain: undefined, rawData: { a: 1, b: { c: "x" } } }), true);
  assert.equal(unchangedRow(existing, { name: "Acme", rawData: { a: 1, b: { c: "y" } } }), false);
  assert.equal(unchangedRow(existing, { name: "Acme", domain: "acme.com", rawData: existing.rawData }), false);
  assert.equal(sameValue([1, { a: 2 }], [1, { a: 2 }]), true);
  assert.equal(sameValue([1, 2], [2, 1]), false);
  assert.equal(sameValue(null, undefined), false);
  // A deal compares what the sync sent last time, not its row, which the ledger may have put in its own words.
  const sent = { stage: "closedwon", amount: 100, rawData: { a: 1, b: 2 }, lastSyncAt: 1, updatedAt: 1 };
  assert.equal(syncFingerprint(sent), syncFingerprint({ updatedAt: 9, rawData: { b: 2, a: 1 }, amount: 100, stage: "closedwon", lastSyncAt: 9, closedAt: undefined }));
  assert.notEqual(syncFingerprint(sent), syncFingerprint({ ...sent, stage: "closed_won" }));
  assert.match(syncFingerprint(sent), /^[0-9a-f]{16}$/);
});

test("page by page, a full read holds the same records as the snapshot", async () => {
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(scaledPortal(150)), sleep: async () => {} });
  const snapshot = await connector.fetchSnapshot();
  const all = async (object: HubspotSyncObject) => {
    const rows: unknown[] = [];
    let after: string | null = null;
    do {
      const page: HubspotSyncPage<HubspotSyncObject> = await connector.readPage(object, after);
      rows.push(...page.rows);
      after = page.next;
    } while (after);
    return rows;
  };
  assert.deepEqual(await all("companies"), snapshot.accounts);
  assert.deepEqual(await all("contacts"), snapshot.contacts);
  assert.deepEqual(await all("deals"), snapshot.deals);
  assert.equal(await connector.countRecords("contacts"), snapshot.contacts.length);
});

test("an incremental read pages by id through the records modified in its window, with their companies", async () => {
  const edited = new Date("2026-10-01T12:00:00.000Z");
  const portal = touchRecords(scaledPortal(400), 350, edited);
  const requests: string[] = [];
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(portal, { onRequest: (path) => requests.push(path) }), sleep: async () => {} });
  const window = { since: edited.getTime() - 1000, until: edited.getTime() + 1000 };
  const read = async (object: HubspotSyncObject) => {
    const rows: Array<{ crmId?: string; accountId?: string }> = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page: HubspotSyncPage<HubspotSyncObject> = await connector.readModifiedPage(object, window, after);
      rows.push(...page.rows);
      after = page.next;
      pages++;
    } while (after);
    return { rows, pages };
  };
  const contacts = await read("contacts");
  assert.equal(contacts.rows.length, 350);
  assert.equal(contacts.pages, 2);
  assert.equal(new Set(contacts.rows.map((r) => r.crmId)).size, 350);
  // Search returns no associations: each page reads its records' companies alongside, and the primary one wins.
  assert.ok(contacts.rows.filter((r) => r.accountId).length >= 340);
  assert.ok(requests.includes("/crm/v4/associations/contacts/companies/batch/read"));
  const full = await connector.fetchSnapshot();
  const primary = new Map(full.contacts.map((c) => [c.crmId, c.accountId]));
  assert.ok(contacts.rows.every((r) => primary.get(r.crmId) === r.accountId));

  const deals = await read("deals");
  assert.equal(deals.rows.length, 350);
  const dealCompany = new Map(full.deals.map((d) => [d.crmId, d.accountId]));
  assert.ok(deals.rows.every((r) => dealCompany.get(r.crmId) === r.accountId));
  assert.equal((await read("companies")).rows.length, 350);
  assert.equal(await connector.countRecords("deals", window), 350);
  // A window that ends before the edits holds none of them.
  assert.equal((await connector.readModifiedPage("deals", { since: 0, until: window.since }, null)).rows.length, full.deals.length - 350);
});

test("pages are read ahead of their writes, at most a buffer ahead, in order, until the last or the deadline", async () => {
  const reads: string[] = [];
  const read = async (after: string | null) => {
    reads.push(after ?? "start");
    await new Promise((r) => setTimeout(r, 1));
    const n = after === null ? 0 : Number(after);
    return { n, next: n < 9 ? String(n + 1) : null };
  };
  const pages = prefetchPages(null, read, { max: 3, until: Date.now() + 60_000 });
  await new Promise((r) => setTimeout(r, 30));
  // Nothing consumed yet: the reader stopped three pages ahead.
  assert.equal(reads.length, 3);
  const seen: number[] = [];
  for (let page = await pages.next(); page; page = await pages.next()) seen.push(page.n);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // Past the deadline the reader stops after the page in flight; a failed read reaches the consumer after the pages before it.
  const late = prefetchPages(null, read, { max: 5, until: Date.now() - 1 });
  assert.equal((await late.next())?.n, 0);
  assert.equal(await late.next(), undefined);
  let calls = 0;
  const failing = prefetchPages(null, async (after) => {
    if (calls++ === 1) throw new Error("HubSpot 502");
    return { n: 0, next: after === null ? "1" : null };
  }, { max: 5, until: Date.now() + 60_000 });
  assert.equal((await failing.next())?.n, 0);
  await assert.rejects(failing.next(), /502/);
  // A stopped reader reads no further.
  reads.length = 0;
  const stopped = prefetchPages(null, read, { max: 2, until: Date.now() + 60_000 });
  stopped.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(reads.length <= 1);
});

test("a sync's search requests start at least 200 ms apart, HubSpot's five a second, however many lanes ask at once", async () => {
  const starts: number[] = [];
  const fetchImpl = fakeHubspotFetch(scaledPortal(50), { onRequest: (path) => { if (path.endsWith("/search")) starts.push(Date.now()); } });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });
  await Promise.all((["companies", "contacts", "deals", "companies", "contacts"] as const).map((o) => connector.countRecords(o)));
  starts.sort((a, b) => a - b);
  assert.equal(starts.length, 5);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 200, `searches ${starts[i] - starts[i - 1]} ms apart`);
});

test("pages write a few at once, and the cursor moves only past pages written in full, in order", async () => {
  const queue = [0, 1, 2, 3, 4, 5, 6, 7];
  const delays = [30, 5, 5, 20, 5, 5, 5, 5];
  const committed: number[] = [];
  let active = 0;
  let peak = 0;
  await writeInOrder({
    next: async () => queue.shift(),
    more: () => true,
    max: 3,
    write: async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, delays[n]));
      active--;
      // Page 0 is slowest: nothing commits before it.
      if (n > 0 && n < 3) assert.ok(!committed.includes(n));
    },
    commit: (n) => committed.push(n),
  });
  assert.deepEqual(committed, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);

  // A failed page commits nothing after it, takes no further page, and throws once the running writes settle.
  const done: number[] = [];
  let taken = 0;
  let running = 0;
  await assert.rejects(writeInOrder({
    next: async () => (taken < 10 ? taken++ : undefined),
    more: () => true,
    max: 3,
    write: async (n) => {
      running++;
      await new Promise((r) => setTimeout(r, n === 1 ? 2 : 15));
      running--;
      if (n === 1) throw new Error("page 1 failed");
    },
    commit: (n) => done.push(n),
  }), /page 1 failed/);
  assert.equal(running, 0);
  assert.deepEqual(done, [0]);
  assert.ok(taken <= 4);

  // A failed read also waits for the writes already running before it throws.
  let writing = 0;
  let reads = 0;
  const readCommits: number[] = [];
  await assert.rejects(writeInOrder({
    next: async () => {
      if (reads++ === 1) throw new Error("HubSpot 502");
      return 0;
    },
    more: () => true,
    max: 3,
    write: async () => {
      writing++;
      await new Promise((r) => setTimeout(r, 20));
      writing--;
    },
    commit: (n) => readCommits.push(n),
  }), /502/);
  assert.equal(writing, 0);
  assert.deepEqual(readCommits, [0]);

  // Past the deadline only the first page is taken.
  const late: number[] = [];
  await writeInOrder({ next: async () => 7, more: (t) => t === 0, max: 3, write: async () => {}, commit: (n) => late.push(n) });
  assert.deepEqual(late, [7]);
});
