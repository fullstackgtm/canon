import assert from "node:assert/strict";
import test from "node:test";
import { createExpleeClient, ExpleeError } from "../convex/lib/outbound/explee.ts";
import { hotLeadKey, planHotLead, syncHotLeads, type HotLeadPorts } from "../convex/lib/outbound/hotLeads.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { PlannedObservation } from "../convex/lib/signals/observations.ts";

const KEY = "sk_explee_test_key";

const lead = (n: number, over: Record<string, unknown> = {}) => ({
  person_id: `p${n}`, campaign_id: 7, name: `Lead ${n}`, email: `Lead${n}@acme.example`, job_title: "CFO",
  company_name: "Acme", company_domain: "https://www.acme.example/", linkedin_url: null, country: "GB", phone: null,
  why_hot: `Yes, let's talk (${n})`, became_hot_at: `2026-10-0${n}T10:00:00Z`, ...over,
});

/** Explee's feed as pages of `size`, newest first; records each request's query. */
function fakeExplee(leads: Array<Record<string, unknown>>, size = 2) {
  const queries: URLSearchParams[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>)["X-API-Key"], KEY);
    const q = new URL(url).searchParams;
    queries.push(q);
    const since = q.get("since");
    const all = leads.filter((l) => !since || Date.parse(l.became_hot_at as string) >= Date.parse(since));
    const offset = Number(q.get("offset"));
    const page = all.slice(offset, offset + size);
    const more = offset + size < all.length;
    return new Response(JSON.stringify({ leads: page, total: all.length, has_more: more, next_offset: more ? offset + size : null }), { status: 200 });
  }) as typeof fetch;
  return { client: createExpleeClient({ apiKey: KEY, fetchImpl }), queries };
}

/** The action's ports over an in-memory record service and observation log. */
function ports() {
  const records = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  const log = new Map<string, PlannedObservation[]>();
  const p: HotLeadPorts = {
    upsert: async (key, account, contact) => {
      await records.upsertAccounts("ws", { records: [account], source: "explee", idempotencyKey: `${key}:a`, fill: "missing" });
      return (await records.upsertContacts("ws", { records: [contact], source: "explee", idempotencyKey: `${key}:c`, fill: "missing" })).ids[0] ?? null;
    },
    log: async (contactId, o) => {
      const list = log.get(contactId) ?? [];
      if (list.some((x) => x.body.key === o.body.key)) return false;
      log.set(contactId, [...list, o]);
      return true;
    },
  };
  return { records, log, p };
}

test("a lead's company comes from Explee's domain, else its work email; a personal mailbox or no email is skipped", () => {
  const plan = planHotLead({ personId: "p1", campaignId: 7, name: null, email: "Ann@Beta.example", jobTitle: null, companyName: null, companyDomain: "gmail.com", linkedinUrl: null, country: null, phone: null, whyHot: "Sure", becameHotAt: "2026-10-01T10:00:00Z" }, 5);
  assert.equal(plan.kind, "write");
  if (plan.kind === "write") {
    assert.deepEqual(plan.account, { domain: "beta.example", name: "beta.example" });
    assert.deepEqual(plan.contact, { accountDomain: "beta.example", fullName: "ann", email: "ann@beta.example" });
    assert.equal(plan.observation.occurredAt, Date.parse("2026-10-01T10:00:00Z"));
  }
  const base = { personId: "p", campaignId: 1, name: "X", jobTitle: null, companyName: null, linkedinUrl: null, country: null, phone: null, whyHot: null, becameHotAt: null };
  assert.deepEqual(planHotLead({ ...base, email: "x@gmail.com", companyDomain: null }, 5), { kind: "skip", reason: "no company domain" });
  assert.deepEqual(planHotLead({ ...base, email: null, companyDomain: "acme.example" }, 5), { kind: "skip", reason: "no email" });
});

test("a sync pages the whole feed, adds each lead once with its reply, and the next poll starts at the newest", async () => {
  const feed = [lead(3), lead(2), lead(1, { email: null })];
  const { client, queries } = fakeExplee(feed);
  const { records, log, p } = ports();

  const first = await syncHotLeads({ client, since: null, ports: p, now: 9 });
  assert.equal(queries.length, 2);
  assert.equal(queries[0].get("since"), null);
  assert.deepEqual([first.imported, first.already, first.skipped], [2, 0, [{ personId: "p1", reason: "no email" }]]);
  assert.equal(first.cursor, "2026-10-03T10:00:00Z");
  assert.deepEqual(first.recent.map((r) => r.name), ["Lead 3", "Lead 2"]);

  const contacts = (await records.listContacts("ws", { filter: { accountId: "acc_acme_example" } })).rows;
  assert.deepEqual(contacts.map((c) => [c.fullName, c.email, c.title]).sort(), [["Lead 2", "lead2@acme.example", "CFO"], ["Lead 3", "lead3@acme.example", "CFO"]]);
  const logged = log.get(first.recent[0].contactId)!;
  assert.deepEqual(logged.map((o) => o.body), [{ type: "hot_lead", key: hotLeadKey({ campaignId: 7, personId: "p3" }), provider: "explee", campaignId: 7, personId: "p3", reply: "Yes, let's talk (3)" }]);

  // `since` is inclusive: the boundary lead comes back and is not added again; a new one is.
  feed.unshift(lead(4));
  const second = await syncHotLeads({ client, since: first.cursor, ports: p, now: 10 });
  assert.equal(queries[2].get("since"), "2026-10-03T10:00:00Z");
  assert.deepEqual([second.imported, second.already, second.cursor], [1, 1, "2026-10-04T10:00:00Z"]);
});

test("a lead already in Canon gets the reply on the existing contact, and no field a rep set is overwritten", async () => {
  const { client } = fakeExplee([lead(2, { job_title: "Chief Financial Officer" })]);
  const { records, log, p } = ports();
  await records.upsertAccounts("ws", { records: [{ domain: "acme.example", name: "Acme Corp" }], source: "user", idempotencyKey: "seed-a" });
  const seeded = await records.upsertContacts("ws", { records: [{ accountDomain: "acme.example", fullName: "Lee Two", email: "lead2@acme.example", title: "VP Finance" }], source: "user", idempotencyKey: "seed-c" });

  const r = await syncHotLeads({ client, since: null, ports: p, now: 9 });
  assert.equal(r.recent[0].contactId, seeded.ids[0]);
  const contact = await records.getContact("ws", seeded.ids[0]);
  assert.deepEqual([contact?.fullName, contact?.title], ["Lee Two", "VP Finance"]);
  assert.equal((await records.get("ws", "acc_acme_example"))?.account.name, "Acme Corp");
  assert.equal(log.get(seeded.ids[0])?.length, 1);
});

test("Explee's refusal names the status and never the key", async () => {
  const client = createExpleeClient({ apiKey: KEY, fetchImpl: (async () => new Response(`bad key ${KEY}`, { status: 401 })) as typeof fetch });
  await assert.rejects(client.hotLeads({}), (e: unknown) => e instanceof ExpleeError && e.status === 401 && !e.message.includes(KEY));
});
