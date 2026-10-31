import assert from "node:assert/strict";
import test from "node:test";
import { winnersCheck } from "../convex/lib/tam/winnersCheck.ts";

const accounts = Array.from({ length: 20 }, (_, i) => ({ fit: i / 20, count: 1 }));

test("compares won fits with the histogram and counts the top quarter", () => {
  assert.deepEqual(winnersCheck(accounts, accounts.slice(10).map((a) => a.fit)), {
    status: "ready", wonAccounts: 10, totalAccounts: 20, medianPercentile: 75, topQuarter: 5, below60: false,
  });
});

test("refuses statistics below ten visible won accounts", () => {
  assert.deepEqual(winnersCheck(accounts, accounts.slice(0, 9).map((a) => a.fit)), { status: "needs-ten", wonAccounts: 9, required: 10 });
  assert.deepEqual(winnersCheck(accounts, accounts.slice(0, 10).map((a) => a.fit)), {
    status: "ready", wonAccounts: 10, totalAccounts: 20, medianPercentile: 25, topQuarter: 0, below60: true,
  });
});

test("ties share a midpoint rank and the warning applies strictly below 60", () => {
  assert.deepEqual(winnersCheck([{ fit: 1, count: 20 }], Array(11).fill(1)), {
    status: "ready", wonAccounts: 11, totalAccounts: 20, medianPercentile: 50, topQuarter: 0, below60: true,
  });
  assert.deepEqual(winnersCheck(accounts, accounts.slice(7, 17).map((a) => a.fit)), {
    status: "ready", wonAccounts: 10, totalAccounts: 20, medianPercentile: 60, topQuarter: 2, below60: false,
  });
});

const winnersHandlers = (async () => {
  const { loadConvex } = await import("./convexHandlers.ts");
  return loadConvex(["icpWinners.ts"], {
    "records.ts": (real) => ({ ...real, requireCaller: async () => ({ orgId: "org" }), callerClient: (ctx: { client: unknown }) => ctx.client }),
  })["icpWinners.ts"];
})();

test("the caller-visible read uses one histogram and one stored fit per distinct won account", async () => {
  const handlers = await winnersHandlers;
  const gets: string[] = [];
  let aggregates = 0;
  const result = await handlers.read.handler({
    runQuery: async () => true,
    client: {
      listObjects: async (org: string, object: string, args: { cursor?: string; limit: number; filter: unknown }) => {
        assert.equal(org, "org");
        assert.equal(object, "deal");
        assert.ok(args.limit <= 200);
        assert.deepEqual(JSON.parse(JSON.stringify(args.filter)), [{ field: "isWon", op: "eq", value: true }]);
        return args.cursor
          ? { rows: [{ values: { companyId: "9" } }, { values: { companyId: "0" } }, { values: { companyId: "hidden" } }] }
          : { rows: accounts.slice(0, 9).map((_, i) => ({ values: { companyId: String(i) } })), nextCursor: "deals-next" };
      },
      aggregate: async (org: string, object: string, request: unknown) => {
        aggregates++;
        assert.equal(org, "org");
        assert.equal(object, "account");
        assert.deepEqual(JSON.parse(JSON.stringify(request)), { groupBy: [{ field: "fit" }], measures: [{ fn: "count" }] });
        return { groups: accounts.map((a) => ({ keys: [a.fit * 100], values: [a.count] })), truncated: false };
      },
      get: async (_org: string, id: string) => {
        gets.push(id);
        return id === "hidden" ? null : { account: { fit: accounts[Number(id)].fit } };
      },
    },
  }, {});
  assert.equal(aggregates, 1);
  assert.deepEqual(gets, [...Array.from({ length: 10 }, (_, i) => String(i)), "hidden"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { sampled: false, check: {
    status: "ready", wonAccounts: 10, totalAccounts: 20, medianPercentile: 25, topQuarter: 0, below60: true,
  } });
});

test("the read stops deal pagination and stored-fit reads at 500 distinct won accounts", async () => {
  const handlers = await winnersHandlers;
  let pages = 0;
  const gets = new Set<string>();
  const result = await handlers.read.handler({
    runQuery: async () => true,
    client: {
      listObjects: async () => {
        const start = pages++ * 200;
        assert.ok(pages <= 3);
        return { rows: Array.from({ length: 200 }, (_, i) => ({ values: { companyId: String(start + i) } })), nextCursor: "more" };
      },
      aggregate: async () => ({ groups: [{ keys: [100], values: [1000] }], truncated: false }),
      get: async (_org: string, id: string) => {
        assert.ok(!gets.has(id));
        gets.add(id);
        return { account: { fit: 1 } };
      },
    },
  }, {});
  assert.equal(pages, 3);
  assert.equal(gets.size, 500);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { sampled: true, check: {
    status: "ready", wonAccounts: 500, totalAccounts: 1000, medianPercentile: 50, topQuarter: 0, below60: true,
  } });
});
