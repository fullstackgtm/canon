import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutMap, lens } from "../src/lib/icp-map.ts";
import { sentence, sentenceText, withValues } from "../src/lib/icp-sentence.ts";
import { parseQuery } from "../convex/lib/icpQuery.ts";
import { focusedKey, focusQuery, layoutSetMap, setMapValue, setState, sharedCount } from "../modules/kernel/setMap.ts";

test("the map draws shared accounts as overlap, keeps disjoint siblings apart, and holds children in their parent", () => {
  const nodes = [
    { id: "icp", parent: null, kind: "icp" as const },
    { id: "leader", parent: "icp", kind: "segment" as const },
    { id: "sales-led", parent: "icp", kind: "segment" as const },
    { id: "mid", parent: "icp", kind: "segment" as const },
  ];
  const counts = {
    nodes: [{ id: "icp", accounts: 277 }, { id: "leader", accounts: 74 }, { id: "sales-led", accounts: 47 }, { id: "mid", accounts: 168 }],
    overlaps: [{ a: "leader", b: "sales-led", accounts: 0 }, { a: "leader", b: "mid", accounts: 44 }, { a: "sales-led", b: "mid", accounts: 30 }],
  };
  const { circles } = layoutMap(nodes, counts);
  const map = setMapValue({ sets: nodes.map((n) => ({ key: n.id, parent: n.parent, label: `Set ${n.id}`, count: counts.nodes.find((c) => c.id === n.id)!.accounts })), pairs: counts.overlaps.map((o) => ({ a: o.a, b: o.b, count: o.accounts })) }, "sets", "pairs");
  const general = () => layoutSetMap(map.rows.map((r) => ({ id: r.key, parent: r.parent, count: r.count })), map.overlaps);
  const neutral = circles.map((c) => ({ id: c.id, x: c.x, y: c.y, r: c.r, depth: c.depth }));
  assert.deepEqual(general().circles, neutral, "the core wrapper and general component use the same geometry");
  const selection = { param: "sel", aliases: ["legacy"] };
  assert.equal(focusedKey(map.rows.map((r) => r.key), selection, {}), "icp");
  assert.equal(focusedKey(map.rows.map((r) => r.key), selection, { legacy: "leader" }), "leader");
  assert.deepEqual(focusQuery(selection, "mid"), { sel: "mid", legacy: null });
  assert.deepEqual(map.rows.map((r) => setState(map, r.key, "leader")), ["path", "focus", "dim", "sibling"]);
  assert.deepEqual(general().circles, neutral, "selection does not move circles");
  const unknown = setMapValue({ sets: [{ key: "unknown", parent: null, label: "Unknown", count: null }], pairs: [] }, "sets", "pairs");
  assert.equal(unknown.rows[0].count, null);
  assert.equal(sharedCount(map.overlaps, "leader", "sales-led"), 0);
  assert.equal(sharedCount([], "leader", "sales-led"), null);
  assert.throws(() => setMapValue({ sets: [{ key: "loop", parent: "loop", label: "Loop", count: 1 }], pairs: [] }, "sets", "pairs"));
  assert.deepEqual(layoutMap(nodes, counts).circles, circles, "the same tree and counts always draw the same map");
  const c = Object.fromEntries(circles.map((x) => [x.id, x]));
  const shared = (a: string, b: string) => {
    const [p, q] = [c[a], c[b]];
    const small = Math.min(...counts.nodes.filter((n) => n.id === a || n.id === b).map((n) => n.accounts));
    return Math.round((lens(p.r, q.r, Math.hypot(p.x - q.x, p.y - q.y)) / (Math.PI * Math.min(p.r, q.r) ** 2)) * small);
  };
  // Three siblings constrain each other, so the drawn overlap lands within a couple of accounts; disjoint stays 0.
  for (const [a, b, n] of [["leader", "mid", 44], ["sales-led", "mid", 30]] as const) assert.ok(Math.abs(shared(a, b) - n) <= 2, `${a}/${b}: ${shared(a, b)} drawn, ${n} shared`);
  assert.equal(shared("leader", "sales-led"), 0);
  for (const k of ["leader", "sales-led", "mid"]) assert.ok(Math.hypot(c[k].x - c.icp.x, c[k].y - c.icp.y) + c[k].r <= c.icp.r + 1e-6, `${k} sits inside its ICP`);
});

test("a sentence names each clause, and editing a token rewrites only its clause", () => {
  const { query } = parseQuery("size:201-500 has(level:vp,head dept:revenue-operations) -has(dept:sales)", "segment");
  assert.equal(sentenceText(sentence("segment", query, [])), "Of those, the ones with 201–500 employees and that employ a VP or Head in Revenue operations and with no one in Sales.");
  // An ICP's buyer with no level is still C-suite to Director, as its gate checks (lib/icps.ts specBuyer).
  assert.equal(sentenceText(sentence("icp", parseQuery("has(dept:sales)", "icp").query, [])), "Companies of any kind, where a C-suite, VP, Head or Director in Sales works.");
  assert.equal(withValues(query, { has: 0, index: 0 }, { values: ["director"] }), "size:201-500 has(level:director dept:revenue-operations) -has(dept:sales)");
  assert.equal(withValues(query, { has: 1, index: 0 }, { values: [] }), "size:201-500 has(level:vp,head dept:revenue-operations)", "an emptied -has(…) goes");
});
