import assert from "node:assert/strict";
import test from "node:test";
import { findContact, qualifies, settleOutcome, stageChange, stageMatches } from "../convex/lib/agents/routing.ts";
import { resolveContacts } from "../convex/lib/outbound/resolve.ts";
import { AUDIENCE_MAX } from "../convex/lib/outbound/audience.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

test("qualification: an explicit rule over answers that passed the write gate", () => {
  const outputs = [
    { fieldSlug: "tier", label: "Tier", status: "answered", value: "Enterprise" },
    { fieldSlug: "stack", label: "Stack", status: "unchanged", value: "Salesforce, Outreach" },
    { fieldSlug: "trial", label: "Trial", status: "rejected", value: true },
  ];
  assert.equal(qualifies(undefined, outputs).ok, true);
  assert.equal(qualifies({ fieldSlug: "tier", op: "equals", value: " enterprise " }, outputs).ok, true);
  assert.equal(qualifies({ fieldSlug: "tier", op: "equals", value: "enter" }, outputs).ok, false);
  assert.equal(qualifies({ fieldSlug: "stack", op: "contains", value: "outreach" }, outputs).ok, true);
  // The gate rejected the answer (no verbatim quote, say): it never qualifies a contact.
  assert.equal(qualifies({ fieldSlug: "trial", op: "equals", value: "true" }, outputs).ok, false);
  assert.equal(qualifies({ fieldSlug: "missing", op: "equals", value: "x" }, outputs).ok, false);
});

test("routing finds an existing contact by exact email in its own workspace, and the audience then holds it once", async () => {
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await client.upsertAccounts("orgA", { records: [{ domain: "acme.example", name: "Acme" }], source: "pdl", idempotencyKey: "a" });
  await client.upsertAccounts("orgB", { records: [{ domain: "acme.example", name: "Acme" }], source: "pdl", idempotencyKey: "b" });
  await client.upsertContacts("orgA", {
    records: [
      { accountDomain: "acme.example", fullName: "Jane Doe", email: "Jane@acme.example" },
      { accountDomain: "acme.example", fullName: "Mary Jane", email: "mary.jane@acme.example" },
    ],
    source: "pipe0", idempotencyKey: "c",
  });
  await client.upsertContacts("orgB", { records: [{ accountDomain: "acme.example", fullName: "Bob", email: "bob@acme.example" }], source: "pipe0", idempotencyKey: "d" });

  const jane = await findContact(client, "orgA", "jane@ACME.example");
  assert.ok(jane && jane !== "ambiguous" && jane.fullName === "Jane Doe");
  assert.equal(await findContact(client, "orgA", "bob@acme.example"), null);
  assert.equal(await findContact(client, "orgA", "jane@acme"), null);

  // The audience's filter matches only Mary; Jane was added by the route, and adding Mary too doesn't double her.
  const all = (await client.listRegister("orgA", "contact", {})).rows;
  const mary = all.find((r) => r.title === "Mary Jane")!;
  const ports = {
    listContacts: async () => ({ rows: [mary], total: 1, nextCursor: null }),
    getContact: (id: string) => client.getContact("orgA", id),
    accountNames: async () => ({}),
    customValues: async () => ({}),
  };
  const { contacts } = await resolveContacts(ports as unknown as Parameters<typeof resolveContacts>[0], [], [jane.id, mary.id]);
  assert.deepEqual(contacts.map((c) => c.fullName).sort(), ["Jane Doe", "Mary Jane"]);
});

test("deal trigger: only a real stage change wakes it, and a named stage must match", () => {
  assert.deepEqual(stageChange("qualified", "demo"), { from: "qualified", to: "demo" });
  assert.deepEqual(stageChange(undefined, "demo"), { from: null, to: "demo" });
  assert.equal(stageChange("demo", "demo"), null);
  assert.equal(stageChange("demo", null), null);
  assert.equal(stageMatches({ event: "deal.stage_changed" }, "anything"), true);
  assert.equal(stageMatches({ event: "deal.stage_changed", toStage: "Demo Scheduled" }, "demo scheduled"), true);
  assert.equal(stageMatches({ event: "deal.stage_changed", toStage: "Demo Scheduled" }, "closedwon"), false);
});

test("a rule edited mid-turn: the outcome is re-judged against the rule now in force", () => {
  const outputs = [{ fieldSlug: "tier", label: "Tier", status: "answered", value: "Enterprise" }];
  const contact = { kind: "contact", contactId: "c1", email: "j@acme.example", name: "Jane" };
  const was = { fieldSlug: "tier", op: "equals" as const, value: "enterprise" };
  const now = { fieldSlug: "tier", op: "equals" as const, value: "smb" };
  assert.deepEqual(settleOutcome(was, outputs, contact), contact);
  // Qualified under the old rule, not under the new one: not routed.
  assert.equal(settleOutcome(now, outputs, contact).kind, "not_qualified");
  // Rejected under the old rule, accepted by the new one: needs a fresh lookup, so the turn is not routed.
  assert.equal(settleOutcome(was, outputs, { kind: "not_qualified", message: "old" }).kind, "stale");
});

test("the audience cap counts distinct members, not the filter total plus the additions", async () => {
  const matching = Array.from({ length: AUDIENCE_MAX - 500 }, (_, i) => ({ id: `c${i}`, accountId: "a", title: `c${i}`, values: {}, updatedAt: 0, stream: null }));
  const ports = {
    listContacts: async (req: { cursor?: string }) => {
      const from = Number(req.cursor ?? 0);
      return { rows: matching.slice(from, from + 200), total: matching.length, nextCursor: from + 200 < matching.length ? String(from + 200) : null };
    },
    getContact: async (id: string) => ({ id, accountId: "a", fullName: id }),
    accountNames: async () => ({}),
    customValues: async () => ({}),
  } as unknown as Parameters<typeof resolveContacts>[0];
  // 501 additions of which 500 already match: one new member, under the cap.
  const overlapping = [...matching.slice(0, 500).map((m) => m.id), "new"];
  assert.equal((await resolveContacts(ports, [], overlapping)).tooLarge, false);
  // 600 genuinely new members go 100 over.
  assert.equal((await resolveContacts(ports, [], Array.from({ length: 600 }, (_, i) => `n${i}`))).tooLarge, true);
});
