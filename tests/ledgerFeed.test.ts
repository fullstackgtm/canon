import assert from "node:assert/strict";
import test from "node:test";
import { bearerMatches, boundedPage, PAGE_BYTES_MAX, parseStreamParams, parseTailParams, tailPage, TAIL_LIMIT_DEFAULT, TAIL_LIMIT_MAX, wireSize, type WireEntry } from "../convex/lib/objects/tail.ts";

const entry = (seq: number, streamId = "s1", version = seq): WireEntry => ({
  streamId, version, observedAt: 1000 + seq, object: "lead", shard: 3, seq,
  source: { kind: "user", ref: "user:u1" }, actor: { kind: "user", id: "u1" }, body: { kind: "lifecycle", op: "create" },
});

test("tail params: defaults, bounds and rejections", () => {
  assert.deepEqual(parseTailParams(new URLSearchParams("org=k57abc&shard=3")), { ok: true, value: { org: "k57abc", shard: 3, after: 0, limit: TAIL_LIMIT_DEFAULT } });
  assert.deepEqual(parseTailParams(new URLSearchParams("org=k57abc&shard=15&after=42&limit=500")), { ok: true, value: { org: "k57abc", shard: 15, after: 42, limit: 500 } });
  assert.deepEqual(parseTailParams(new URLSearchParams("org=k57abc&shard=16")), { ok: false, error: "shard must be 0 to 15" });
  assert.deepEqual(parseTailParams(new URLSearchParams("org=k57abc&shard=1&limit=501")), { ok: false, error: "limit must be 1 to 500" });
  assert.deepEqual(parseTailParams(new URLSearchParams("org=k57abc&shard=1&after=-1")), { ok: false, error: "after must be a whole number" });
  assert.deepEqual(parseTailParams(new URLSearchParams("shard=1")), { ok: false, error: "org is required" });
  assert.deepEqual(parseTailParams(new URLSearchParams("org=../x&shard=1")), { ok: false, error: "org is required" });
  assert.deepEqual(parseTailParams(new URLSearchParams("org=k57abc")), { ok: false, error: "shard is required" });
});

test("stream params: fromVersion starts at 1 and the page is capped", () => {
  assert.deepEqual(parseStreamParams(new URLSearchParams("org=o&id=e1")), { ok: true, value: { org: "o", id: "e1", fromVersion: 1, limit: 500 } });
  assert.deepEqual(parseStreamParams(new URLSearchParams("org=o&id=e1&fromVersion=0")), { ok: false, error: "fromVersion must be 1 to 9007199254740991" });
  assert.deepEqual(parseStreamParams(new URLSearchParams("org=o")), { ok: false, error: "id is required" });
});

test("a tail page is the contiguous run of seq after the cursor", () => {
  const page = tailPage([entry(5), entry(6), entry(7)], 4, 9);
  assert.deepEqual(page.entries.map((e) => e.seq), [5, 6, 7]);
  assert.equal(page.head, 9);
});

test("a tail page stops before a missing seq instead of skipping it", () => {
  assert.deepEqual(tailPage([entry(5), entry(6), entry(8)], 4, 8).entries.map((e) => e.seq), [5, 6]);
  assert.deepEqual(tailPage([entry(6)], 4, 6).entries, []);
  assert.deepEqual(tailPage([], 4, 4).entries, []);
});

/** An index read Convex serves lazily: counts how many rows were pulled from it. */
function lazyRows<T>(rows: readonly T[]) {
  const read = { n: 0 };
  async function* gen() {
    for (const r of rows) {
      read.n++;
      yield r;
    }
  }
  return { rows: gen(), read };
}

const big = (seq: number, bytes: number): WireEntry => ({
  ...entry(seq), body: { kind: "assert", status: "accepted", assertions: [{ fieldId: "description", value: "x".repeat(bytes) }] } as never,
});

test("a page of large entries stops at the byte budget and continues after its last entry", async () => {
  // 500 entries of 100 KB each is ~50 MB: past Convex's 16 MiB read and return limits if read as one page.
  const all = Array.from({ length: TAIL_LIMIT_MAX }, (_, i) => big(i + 1, 100_000));
  const first = lazyRows(all);
  const page = await boundedPage(first.rows, { limit: TAIL_LIMIT_MAX });
  const bytes = page.items.reduce((n, e) => n + wireSize(e), 0);
  assert.ok(page.items.length >= 1 && page.items.length < TAIL_LIMIT_MAX, `got ${page.items.length} entries`);
  assert.ok(bytes <= PAGE_BYTES_MAX, `page is ${bytes} bytes`);
  assert.equal(page.more, true);
  assert.ok(first.read.n <= page.items.length + 1, `read ${first.read.n} rows for a page of ${page.items.length}`);
  const tail = tailPage(page.items, 0, TAIL_LIMIT_MAX);
  assert.deepEqual(tail.entries.map((e) => e.seq), page.items.map((_, i) => i + 1));

  // The continuation is the last included entry: the next page starts right after it.
  const after = tail.entries[tail.entries.length - 1].seq;
  const next = await boundedPage(lazyRows(all.filter((e) => e.seq > after)).rows, { limit: TAIL_LIMIT_MAX });
  assert.equal(next.items[0].seq, after + 1);
});

test("a single entry larger than the byte budget still makes progress", async () => {
  const page = await boundedPage(lazyRows([big(1, 1_000_000), big(2, 10)]).rows, { limit: 500, maxBytes: 500_000 });
  assert.deepEqual(page.items.map((e) => e.seq), [1]);
  assert.equal(page.more, true);
});

test("a bounded page reports the end only when the rows ran out", async () => {
  assert.deepEqual(await boundedPage(lazyRows([1, 2]).rows, { limit: 2, size: () => 1 }), { items: [1, 2], more: false });
  const capped = lazyRows([1, 2, 3]);
  assert.deepEqual(await boundedPage(capped.rows, { limit: 2, size: () => 1 }), { items: [1, 2], more: true });
  assert.deepEqual(await boundedPage(lazyRows([]).rows, { limit: 2 }), { items: [], more: false });
});

test("bearer tokens match only exactly", async () => {
  const token = "projector-token-0123456789";
  assert.equal(await bearerMatches(`Bearer ${token}`, token), true);
  assert.equal(await bearerMatches(`Bearer ${token}x`, token), false);
  assert.equal(await bearerMatches(`Bearer ${token.slice(0, -1)}`, token), false);
  assert.equal(await bearerMatches(token, token), false);
  assert.equal(await bearerMatches(null, token), false);
  assert.equal(await bearerMatches("Bearer ", ""), false);
});
