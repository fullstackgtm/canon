import assert from "node:assert/strict";
import test from "node:test";
import type { OutboundContact } from "../convex/lib/outbound/audience.ts";
import { SequencerError } from "../convex/lib/outbound/client.ts";
import { previewPush, pushTo, type MemberRow, type PushPorts } from "../convex/lib/outbound/push.ts";
import { normalizeInstanceUrl, SEQUENCERS, targetLabel } from "../convex/lib/outbound/sequencers.ts";

const KEY = "seq_secret_key_123";

const person = (i: number, over: Partial<OutboundContact> = {}): OutboundContact => ({
  id: `c${i}`, email: `p${i}@acme.example`, fullName: `Pat Number${i}`, title: null, company: "Acme", phone: null, linkedinUrl: null, custom: {}, ...over,
});
const ada = person(0, { email: "Ada@acme.example", fullName: "Ada Lovelace", title: "CRO", phone: "+1 555 0100", linkedinUrl: "https://linkedin.com/in/ada", custom: { deep_link: "https://x.io/a" } });

function memoryPorts() {
  const rows: Array<MemberRow & { target: string }> = [];
  const ports: PushPorts = {
    suppressed: async () => new Map(),
    sentEmails: async (target) => new Set(rows.filter((r) => r.target === target && r.outcome === "sent" && r.email).map((r) => r.email!)),
    record: async (target, added) => void rows.push(...added.map((r) => ({ ...r, target }))),
  };
  return { rows, ports };
}

type Call = { method: string; url: URL; auth: string | null; body: any };
function fakeFetch(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { method: init.method ?? "GET", url: new URL(url), auth: new Headers(init.headers).get("Authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return new Response(JSON.stringify(answer(call)), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("EmailBison: upserts leads 500 at a time on the customer's host, attaches them by id, skips no first name, and a re-push adds nothing", async () => {
  let nextId = 1;
  const { calls, fetchImpl } = fakeFetch((c) => {
    if (c.url.pathname === "/api/campaigns") return c.url.searchParams.get("cursor") ? { data: [{ id: 8, name: "B" }], meta: { next_cursor: null } } : { data: [{ id: 7, name: "A", status: "active" }], meta: { next_cursor: "n1" } };
    if (c.url.pathname === "/api/leads/create-or-update/multiple") return { data: c.body.leads.map((l: { email: string }) => ({ id: nextId++, email: l.email })) };
    return { data: { success: true } };
  });
  const client = SEQUENCERS.emailbison.create({ apiKey: KEY, instanceUrl: "https://send.acme.example", fetchImpl });
  assert.deepEqual(await client.listCampaigns(), [{ id: "7", name: "A", status: "active" }, { id: "8", name: "B" }]);
  calls.length = 0;

  const contacts = [ada, person(1, { fullName: "" }), ...Array.from({ length: 500 }, (_, i) => person(i + 2))];
  const store = memoryPorts();
  assert.deepEqual(await previewPush("emailbison", contacts, "7", store.ports), { total: 502, toSend: 501, skippedNoEmail: 0, skippedDuplicate: 0, alreadySent: 0, skippedUnfit: 1, skippedSuppressed: 0 });
  const result = await pushTo({ provider: "emailbison", contacts, campaignId: "7", client, ports: store.ports });
  assert.equal(result.sent, 501);

  assert.deepEqual(calls.map((c) => [c.method, c.url.origin + c.url.pathname]), [
    ["POST", "https://send.acme.example/api/leads/create-or-update/multiple"],
    ["POST", "https://send.acme.example/api/campaigns/7/leads/attach-leads"],
    ["POST", "https://send.acme.example/api/leads/create-or-update/multiple"],
    ["POST", "https://send.acme.example/api/campaigns/7/leads/attach-leads"],
  ]);
  assert.equal(calls[0].auth, `Bearer ${KEY}`);
  assert.equal(calls[0].body.existing_lead_behavior, "patch");
  assert.deepEqual([calls[0].body.leads.length, calls[2].body.leads.length], [500, 1]);
  assert.deepEqual(calls[0].body.leads[0], {
    email: "Ada@acme.example", first_name: "Ada", last_name: "Lovelace", title: "CRO", company: "Acme",
    custom_variables: [{ name: "phone", value: "+1 555 0100" }, { name: "linkedin_url", value: "https://linkedin.com/in/ada" }, { name: "deep_link", value: "https://x.io/a" }],
  });
  assert.deepEqual(calls[1].body, { lead_ids: Array.from({ length: 500 }, (_, i) => i + 1) });
  assert.deepEqual(store.rows.filter((r) => r.outcome === "skipped").map((r) => [r.contactId, r.reason]), [["c1", "no first name"]]);

  const again = await pushTo({ provider: "emailbison", contacts, campaignId: "7", client, ports: store.ports });
  assert.equal(again.alreadySent, 501);
  assert.equal(calls.length, 4);
});

test("Smartlead: adds leads 100 at a time with the key as a query parameter, and records the leads it skipped", async () => {
  const { calls, fetchImpl } = fakeFetch((c) =>
    c.method === "GET" ? [{ id: 42, name: "Q4", status: "ACTIVE" }]
    : c.body.lead_list.length === 1 ? { added_count: 0, skipped_count: 1, skipped_leads: [{ email: c.body.lead_list[0].email, reason: "duplicate" }] }
    : { added_count: 100, skipped_count: 0, skipped_leads: [] },
  );
  const client = SEQUENCERS.smartlead.create({ apiKey: KEY, fetchImpl });
  assert.deepEqual(await client.listCampaigns(), [{ id: "42", name: "Q4", status: "ACTIVE" }]);
  assert.equal(calls[0].url.searchParams.get("api_key"), KEY);
  const wrapped = SEQUENCERS.smartlead.create({ apiKey: KEY, fetchImpl: fakeFetch(() => ({ campaigns: [{ id: 43, name: "Q1" }] })).fetchImpl });
  assert.deepEqual(await wrapped.listCampaigns(), [{ id: "43", name: "Q1" }]);
  calls.length = 0;

  const contacts = [ada, ...Array.from({ length: 100 }, (_, i) => person(i + 1))];
  const store = memoryPorts();
  const result = await pushTo({ provider: "smartlead", contacts, campaignId: "42", client, ports: store.ports });
  assert.deepEqual([result.sent, result.rejected], [100, 1]);
  assert.deepEqual(calls.map((c) => [c.url.pathname, c.body.lead_list.length]), [["/api/v1/campaigns/42/leads", 100], ["/api/v1/campaigns/42/leads", 1]]);
  assert.equal(calls[0].url.searchParams.get("api_key"), KEY);
  assert.deepEqual(calls[0].body.settings, { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false });
  assert.deepEqual(calls[0].body.lead_list[0], {
    email: "Ada@acme.example", first_name: "Ada", last_name: "Lovelace", company_name: "Acme", phone_number: "+1 555 0100",
    linkedin_profile: "https://linkedin.com/in/ada", custom_fields: { title: "CRO", deep_link: "https://x.io/a" },
  });
  assert.deepEqual(store.rows.filter((r) => r.outcome === "skipped").map((r) => r.contactId), ["c100"]);
  // Sent ones are not sent again; the one Smartlead skipped is retried.
  assert.equal((await previewPush("smartlead", contacts, "42", store.ports)).toSend, 1);
});

test("a refused or unreachable sequencer never shows the key, the URL or the body; 429 carries Retry-After", async () => {
  const answer = (status: number, headers: Record<string, string> = {}) => (async () => new Response(`denied for ${KEY}`, { status, headers })) as unknown as typeof fetch;
  for (const id of ["instantly", "emailbison", "smartlead"] as const) {
    const err = await SEQUENCERS[id].create({ apiKey: KEY, instanceUrl: "https://send.acme.example", fetchImpl: answer(401) }).validate().catch((e) => e);
    assert.ok(err instanceof SequencerError && err.status === 401);
    assert.ok(!err.message.includes(KEY) && !err.message.includes("denied"));
  }
  const thrown = (async (url: string) => { throw new TypeError(`fetch failed: ${url}`); }) as unknown as typeof fetch;
  const lost = await SEQUENCERS.smartlead.create({ apiKey: KEY, fetchImpl: thrown }).validate().catch((e) => e);
  assert.ok(lost instanceof SequencerError && !lost.message.includes(KEY));
  const limited = await SEQUENCERS.smartlead.create({ apiKey: KEY, fetchImpl: answer(429, { "Retry-After": "30" }) }).listCampaigns().catch((e) => e);
  assert.ok(limited instanceof SequencerError && limited.status === 429 && limited.retryAfter === 30);
});

test("campaign ids, instance URLs and history targets follow the registry", () => {
  assert.ok(SEQUENCERS.smartlead.campaignId.test("42") && !SEQUENCERS.smartlead.campaignId.test("42/leads?x"));
  assert.ok(SEQUENCERS.emailbison.campaignId.test("7") && !SEQUENCERS.emailbison.campaignId.test("abc"));
  assert.ok(SEQUENCERS.instantly.campaignId.test("0b9c-11ef") && !SEQUENCERS.instantly.campaignId.test("a/b"));
  assert.equal(normalizeInstanceUrl(" send.acme.com/app "), "https://send.acme.com");
  for (const bad of ["http://send.acme.com", "https://localhost", "https://10.0.0.1", "https://u:p@acme.com", "https://acme.com:8443", "ftp://acme.com"]) assert.equal(normalizeInstanceUrl(bad), null, bad);
  assert.equal(targetLabel("instantly:camp-1"), "Instantly campaign camp-1");
  assert.equal(targetLabel("smartlead:42"), "Smartlead campaign 42");
  assert.equal(targetLabel("csv"), null);
});
