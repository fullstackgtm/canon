import assert from "node:assert/strict";
import test from "node:test";
import { inferredEvidence, inferredValue, jevGrounded, jevReadOf, jevStateFor, jevSummary, pickSample, probeVerdict, type ProbeRow } from "../convex/lib/research/probe.ts";

const rows = (spec: Record<string, number>): ProbeRow[] =>
  Object.entries(spec).flatMap(([k, n]) => Array.from({ length: n }, (): ProbeRow => {
    const [status, value] = k.split(":");
    return status === "pending" ? {} : { status: status as ProbeRow["status"], ...(value ? { value } : {}) };
  }));
const classify = { kind: "classify" as const };

test("a probe's verdict: pending, too few, undecidable, doesn't split, mixed, ready", () => {
  assert.equal(probeVerdict(rows({ "answered:a": 3, pending: 2 }), classify, false).kind, "pending");
  assert.equal(probeVerdict([], classify, false).kind, "pending");
  // A stopped probe judges what settled; errors count neither way.
  assert.equal(probeVerdict(rows({ "answered:a": 3, error: 10, pending: 5 }), classify, true).kind, "too_few");
  assert.equal(probeVerdict(rows({ "answered:a": 6, unknown: 4, no_evidence: 2 }), classify, true).kind, "undecidable");
  const flat = probeVerdict(rows({ "answered:a": 19, "answered:b": 1 }), classify, true);
  assert.deepEqual([flat.kind, flat.top?.value], ["doesnt_split", "a"]);
  // Free-text answers never "don't split".
  assert.equal(probeVerdict(rows({ "answered:a": 20 }), { kind: "qa", answerType: "text" }, true).kind, "ready");
  assert.equal(probeVerdict(rows({ "answered:a": 6, "answered:b": 5, unknown: 9 }), classify, true).kind, "mixed");
  assert.equal(probeVerdict(rows({ "answered:a": 10, "answered:b": 8, rejected: 2, no_evidence: 5 }), classify, true).kind, "ready");
});

test("a sample is n distinct items of the pool, or the whole pool when smaller", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pool = Array.from({ length: 100 }, (_, i) => i);
  const s = pickSample(pool, 25, rand);
  assert.equal(new Set(s).size, 25);
  assert.ok(s.every((x) => pool.includes(x)));
  assert.deepEqual(pickSample([1, 2], 25, rand).sort(), [1, 2]);
});

test("Jev reads: yes/no as a pick, a sample's picks and confidence bands, the person's passages first", () => {
  assert.deepEqual(jevReadOf({ type: "noul", noul: 0.2 }), { choice: "false", confidence: 0.8, probabilities: { true: 0.2, false: 0.8 } });
  const read = (choice: string, confidence: number): ProbeRow => ({ status: "unknown", jev: { choice, confidence, probabilities: {} } });
  const s = jevSummary([read("buyer", 0.9), read("buyer", 0.7), read("champion", 0.5), { status: "error" }]);
  assert.deepEqual(s, { read: 3, picks: [{ choice: "buyer", count: 2, confident: 1 }, { choice: "champion", count: 1, confident: 0 }], bands: { high: 1, mid: 1, low: 1 } });
  const state = jevStateFor({ name: "Acme", domain: "acme.com", person: { name: "Ada Lovelace", title: "CFO" } }, [
    { url: "https://acme.com/", text: "Acme makes widgets." },
    { url: "https://acme.com/team", text: "Our team. Ada Lovelace runs finance and approves every purchase." },
  ]);
  assert.match(String((state.evidence as string[])[0]), /^\[https:\/\/acme\.com\/team\].*approves every purchase/);
});

test("a confident Jev read becomes the field's value, with what Jev read as evidence", () => {
  const spec = { kind: "classify" as const, options: [{ key: "economic-buyer" }, { key: "champion" }] };
  assert.equal(inferredValue(spec, "champion"), "champion");
  assert.equal(inferredValue(spec, "nope"), null);
  assert.equal(inferredValue({ kind: "qa", answerType: "boolean" }, "false"), false);
  const evidence = inferredEvidence(
    { name: "Acme", domain: "acme.com", person: { name: "Ada Lovelace", title: "CFO" } },
    [{ url: "https://acme.com/team", text: "Ada Lovelace runs finance and approves every purchase." }],
    { choice: "economic-buyer", confidence: 0.83, probabilities: {} },
  );
  assert.match(evidence, /^Inferred by Jev \(0\.83\)/);
  assert.match(evidence, /Title on the record: "CFO"/);
  assert.match(evidence, /\n\nSource: https:\/\/acme\.com\/team \(inferred by Jev\)$/);
  assert.match(inferredEvidence({ name: "Acme", domain: "acme.com" }, [], { choice: "x", confidence: 0.7, probabilities: {} }), /Source: record \(inferred by Jev\)$/);
});

test("Jev reads a person only with something about them: a title, a page naming them in full, or a page about them", () => {
  const home = { url: "https://acme.com/", text: "Acme makes widgets for insurers." };
  const subject = (title?: string) => ({ name: "Acme", domain: "acme.com", person: { name: "Ada Lovelace", ...(title ? { title } : {}) } });
  assert.equal(jevGrounded(subject(), [home]), false, "the employer's homepage says nothing about her");
  assert.equal(jevGrounded(subject(), [home, { url: "https://x.example/", text: "Mrs. Lovelace of Leeds won the bake sale." }]), false, "a namesake's surname is not her");
  assert.equal(jevGrounded(subject("CFO"), [home]), true);
  assert.equal(jevGrounded(subject(), [{ url: "https://news.example/a", text: "Acme names Ada Lovelace CFO." }]), true);
  assert.equal(jevGrounded({ name: "Acme", domain: "acme.com" }, [home]), true);
});
