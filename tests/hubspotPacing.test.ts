import assert from "node:assert/strict";
import test from "node:test";
import { concurrencyLimit, createHubspotPacer, mapLimit, hubspotRateLimitDelayMs, parseHubspotRateLimit } from "../engine/src/connectors/hubspotPacing.ts";
import { createHubspotConnector } from "../engine/src/connectors/hubspot.ts";
import { fakeHubspotFetch, northwindPortal, scaledPortal } from "../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";
import { writeInBatches, writeSplitting } from "../convex/lib/batchWrites.ts";

test("a nearly spent rate-limit window holds the next request until it resets; a stale or roomy one does not", () => {
  const seen = parseHubspotRateLimit(new Headers({ "X-HubSpot-RateLimit-Max": "100", "X-HubSpot-RateLimit-Remaining": "10", "X-HubSpot-RateLimit-Interval-Milliseconds": "10000" }), 1_000);
  assert.deepEqual(seen, { max: 100, remaining: 10, intervalMs: 10_000, observedAt: 1_000 });
  assert.equal(hubspotRateLimitDelayMs(seen, 4_000), 7_100);
  assert.equal(hubspotRateLimitDelayMs(seen, 11_000), 0);
  assert.equal(hubspotRateLimitDelayMs({ ...seen!, remaining: 11 }, 4_000), 0);
  // A small window keeps at least five calls in reserve.
  assert.ok(hubspotRateLimitDelayMs({ max: 10, remaining: 5, intervalMs: 1_000, observedAt: 0 }, 10) > 0);
  // Search responses carry no headers: nothing is observed.
  assert.equal(parseHubspotRateLimit(new Headers(), 0), undefined);
});

test("the concurrency limit keeps at most that many tasks running", async () => {
  const run = concurrencyLimit(3);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => run(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  })));
  assert.equal(peak, 3);
});

test("paced concurrent reads stay inside HubSpot's rolling window instead of drawing 429s", async () => {
  const statuses: number[] = [];
  const fetchImpl = fakeHubspotFetch(northwindPortal(), { latencyMs: 5, rateLimit: { max: 20, intervalMs: 400 } });
  const pacer = createHubspotPacer({ maxConcurrent: 4 });
  await Promise.all(Array.from({ length: 50 }, () => pacer.send(() => fetchImpl("https://api.hubapi.com/crm/v3/pipelines/deals")).then((r) => statuses.push(r.status))));
  assert.equal(statuses.length, 50);
  assert.deepEqual(statuses.filter((s) => s !== 200), []);
});

test("the concurrent pull reads the same snapshot as the sequential one", async () => {
  const portal = scaledPortal(150);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(portal), sleep: async () => {} });
  const sequential = await connector.fetchSnapshot();
  const pull = connector.pullSnapshot();
  const [users, accounts, contacts, deals] = await Promise.all([pull.users, pull.accounts, pull.contacts, pull.deals]);
  assert.equal(accounts.length, 156);
  assert.equal(contacts.length, 458);
  assert.deepEqual({ users, accounts, contacts, deals }, { users: sequential.users, accounts: sequential.accounts, contacts: sequential.contacts, deals: sequential.deals });
});

test("a pull whose part fails rejects that part when awaited, and never as an unhandled rejection", async () => {
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(northwindPortal({ forbidden: ["deals"] })), sleep: async () => {} });
  const pull = connector.pullSnapshot();
  assert.equal((await pull.accounts).length, 6);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(pull.deals, /403/);
});

const conflict = () => new Error('Documents read from or written to the "ledgerShardHeads" table changed while this mutation was being run and on every subsequent retry.');

test("a batch that conflicts or passes a transaction limit is split and retried; any other error is thrown", async () => {
  const written: number[][] = [];
  let failures = 2;
  await writeSplitting([1, 2, 3, 4], async (rows) => {
    if (rows.length > 1 && failures-- > 0) throw conflict();
    written.push(rows);
  });
  // The batch failed, then its first half; the halves of that half and the second half went through.
  assert.deepEqual(written, [[1], [2], [3, 4]]);

  await assert.rejects(writeSplitting([1, 2], async () => {
    throw new Error("Deal 9 is not valid");
  }), /not valid/);

  let tries = 0;
  await assert.rejects(writeSplitting([7], async () => {
    tries++;
    throw new Error("Too many documents read in a single function execution");
  }), /Too many documents/);
  assert.equal(tries, 2);
});

test("rows a transaction hands back are written in turn, and batches run a few at a time", async () => {
  const seen: number[] = [];
  let active = 0;
  let peak = 0;
  await writeInBatches(Array.from({ length: 10 }, (_, i) => i), {
    size: 3, concurrency: 2,
    submit: async (rows) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      // Each transaction writes only its first row and hands the rest back, as a party sync past its budget does.
      seen.push(rows[0]);
      return rows.slice(1);
    },
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(peak, 2);
});

test("after a batch fails, no batch starts and none is still writing when the call rejects", async () => {
  const started: number[] = [];
  let active = 0;
  await assert.rejects(writeInBatches([1, 2, 3, 4, 5, 6], {
    size: 1, concurrency: 3,
    submit: async ([n]) => {
      started.push(n);
      active++;
      await new Promise((r) => setTimeout(r, n === 1 ? 1 : 20));
      active--;
      if (n === 1) throw new Error("Deal 1 is not valid");
    },
  }), /not valid/);
  assert.equal(active, 0);
  const settled = [...started];
  await new Promise((r) => setTimeout(r, 50));
  // Batches 2 and 3 were already running and finished; nothing started after the failure.
  assert.deepEqual(started, settled);
  assert.deepEqual(settled, [1, 2, 3]);
  assert.deepEqual(await mapLimit([3, 1, 2], 2, async (n) => n * 10), [30, 10, 20]);
});
