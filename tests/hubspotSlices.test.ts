// A full HubSpot sync reads large objects in id ranges at once (convex/lib/hubspotSlices.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { createHubspotConnector, type HubspotSyncObject } from "../engine/src/connectors/hubspot.ts";
import { fakeHubspotFetch, scaledPortal } from "../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";
import { MAX_SLICES, mergeSlice, planSlices, readSlicePage, SliceCursorUnsupported, slicePage, sliceRanks, type SyncSlice } from "../convex/lib/hubspotSlices.ts";

test("a large object splits into a few ranges of about as many records; a small one, or one without bounds, reads in one", () => {
  assert.deepEqual(sliceRanks(900), []);
  assert.deepEqual(sliceRanks(undefined), []);
  assert.deepEqual(sliceRanks(6000), [3000]);
  assert.deepEqual(sliceRanks(30_000), [7500, 15_000, 22_500]);
  assert.equal(sliceRanks(1_000_000).length, MAX_SLICES - 1);
  assert.deepEqual(planSlices([]), [{ after: null, done: false, read: 0 }]);
  const slices = planSlices([500, 9000, 70_000]);
  assert.equal(slices.length, 4);
  // The first starts at the list's start, each next where the last ends, and the last runs to the end.
  assert.deepEqual(slices[0], { after: null, end: 500, done: false, read: 0 });
  assert.deepEqual(slices[1], { after: "499", from: 500, end: 9000, done: false, read: 0 });
  assert.deepEqual(slices.at(-1), { after: "69999", from: 70_000, done: false, read: 0 });
  // A repeated bound makes no empty range.
  assert.equal(planSlices([500, 500]).length, 2);
});

test("search finds the ids at even ranks, hopping past its 10,000-result cap, however the ids cluster", async () => {
  const portal = scaledPortal(12_000);
  // Old records far below the new ones: an even split by id would put nearly all in one range.
  portal.objects.companies.slice(0, 100).forEach((r, i) => { r.id = String(10 + i); r.properties.hs_object_id = r.id; });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(portal), sleep: async () => {} });
  const sorted = portal.objects.companies.map((r) => Number(r.id)).sort((a, b) => a - b);
  const ranks = sliceRanks(sorted.length);
  assert.deepEqual(await connector.idsAtRanks("companies", ranks), ranks.map((r) => sorted[r]));
  assert.deepEqual(await connector.idsAtRanks("companies", [0, 10_500, 11_990]), [sorted[0], sorted[10_500], sorted[11_990]]);
  // Past the last record there is no id.
  assert.deepEqual(await connector.idsAtRanks("companies", [5, sorted.length + 3]), [sorted[5]]);
});

/** Read an object's ranges at once as the sync does (convex/hubspotActions.ts runSyncLane), merging a refused range. */
async function readSliced(connector: ReturnType<typeof createHubspotConnector>, object: HubspotSyncObject, slices: SyncSlice[]) {
  const ids: string[] = [];
  const merged: number[] = [];
  await Promise.all(slices.map(async (slice) => {
    let lastId: number | undefined;
    let after = slice.after;
    do {
      try {
        const page = await readSlicePage(slice, after, { list: (at) => connector.readPage(object, at), firstIdFrom: (from) => connector.firstIdFrom(object, from), previousId: lastId });
        lastId = page.lastId ?? lastId;
        ids.push(...page.rows.map((r) => r.crmId!));
        after = page.next;
      } catch (error) {
        if (!(error instanceof SliceCursorUnsupported) || !error.firstPage || !mergeSlice(slices, slice)) throw error;
        merged.push(slice.from!);
        after = null;
      }
    } while (after);
    slice.done = true;
  }));
  return { ids, merged };
}

test("read in ranges over an id cursor, an object holds every record once", async () => {
  const portal = { ...scaledPortal(9000), idCursor: true };
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(portal), sleep: async () => {} });
  const slices = planSlices(await connector.idsAtRanks("companies", sliceRanks(await connector.countRecords("companies"))));
  assert.equal(slices.length, 3);
  const { ids, merged } = await readSliced(connector, "companies", slices);
  assert.deepEqual(merged, []);
  const all = portal.objects.companies.map((r) => r.id);
  assert.equal(ids.length, all.length);
  assert.deepEqual([...ids].sort(), [...all].sort());
});

test("over a cursor that is a position, not an id, each range's ids join the one before it, and every record is read once", async () => {
  // Contiguous ids: a position cursor lands a record or two past each range's start, on pages in perfect id order.
  const portal = scaledPortal(9000);
  portal.objects.companies.forEach((r, i) => { r.id = String(i + 2); r.properties.hs_object_id = r.id; });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(portal), sleep: async () => {} });
  const slices = planSlices(await connector.idsAtRanks("companies", sliceRanks(await connector.countRecords("companies"))));
  assert.equal(slices.length, 3);
  const { ids, merged } = await readSliced(connector, "companies", slices);
  assert.equal(merged.length, 2);
  assert.equal(slices[0].end, undefined);
  assert.equal(ids.length, portal.objects.companies.length);
  assert.equal(new Set(ids).size, ids.length);
});

test("a range out of id order after its first page, or refused once the range before it passed its end, is not merged", () => {
  assert.throws(() => slicePage({ after: null, end: 50, done: false, read: 0 }, { rows: [{ crmId: "7" }, { crmId: "3" }], next: "8" }), SliceCursorUnsupported);
  const ended: SyncSlice[] = [{ after: null, end: 900, done: false, read: 800, ended: true }, { after: "899", from: 900, done: false, read: 0 }];
  assert.equal(mergeSlice(ended, ended[1]), false);
  const reading: SyncSlice[] = [{ after: "500", end: 900, done: false, read: 400 }, { after: "899", from: 900, end: 2000, done: false, read: 0 }, { after: "1999", from: 2000, done: false, read: 0 }];
  // The last range joins the middle one, which then joins the first: the first reads to the list's end.
  assert.equal(mergeSlice(reading, reading[2]), true);
  assert.equal(mergeSlice(reading, reading[1]), true);
  assert.equal(reading[0].end, undefined);
  assert.ok(reading[1].merged && reading[2].merged && reading[1].done);
});

test("a range keeps only its own ids, and ends once a page passes its end", () => {
  const slice: SyncSlice = { after: "99", from: 100, end: 200, done: false, read: 0 };
  // HubSpot may read from the cursor's id itself, which belongs to the range below.
  const page = slicePage(slice, { rows: [{ crmId: "99" }, { crmId: "150" }, { crmId: "199" }, { crmId: "200" }], next: "201" });
  assert.deepEqual(page.rows.map((r) => r.crmId), ["150", "199"]);
  assert.equal(page.next, null);
  assert.throws(() => slicePage(slice, { rows: [{ crmId: "42" }], next: null }), SliceCursorUnsupported);
});

test("a range's first page is kept to its end as the end stands once the page is proven, not as it stood when read", async () => {
  const slices = planSlices([100, 110]);
  const [, middle, last] = slices;
  const rows = Array.from({ length: 20 }, (_, i) => ({ crmId: String(100 + i) }));
  let merge: () => void = () => {};
  const proven = new Promise<number>((resolve) => (merge = () => resolve(100)));
  const reading = readSlicePage(middle, middle.after, { list: async () => ({ rows, next: "120" }), firstIdFrom: () => proven });
  // The last range is refused while the middle one waits on its search: its ids join the middle range.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(mergeSlice(slices, last), true);
  merge();
  const page = await reading;
  assert.deepEqual(page.rows.map((r) => r.crmId), rows.map((r) => r.crmId));
  assert.equal(page.next, "120");
  assert.equal(middle.ended, undefined);
});
