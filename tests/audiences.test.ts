import assert from "node:assert/strict";
import test from "node:test";
import { csvOf, readAll, runsOf } from "../convex/lib/outbound/audience.ts";
import { SequencerError } from "../convex/lib/outbound/client.ts";
import { createInstantlyClient } from "../convex/lib/outbound/instantly.ts";
import { previewPush, pushTo, type MemberRow, type PushPorts } from "../convex/lib/outbound/push.ts";
import { targetOf } from "../convex/lib/outbound/sequencers.ts";
import { resolveContacts } from "../convex/lib/outbound/resolve.ts";
import { accountNamesByList, createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

const KEY = "inst_test_key_123";

/** A workspace with an account, four contacts (one without email, two sharing one) and a custom deep link on Ada's stream. */
async function workspace() {
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await client.upsertAccounts("ws", { records: [{ domain: "acme.example", name: "Acme, Inc." }, { domain: "beta.example", name: "Beta" }], source: "pdl", idempotencyKey: "a" });
  await client.upsertContacts("ws", {
    records: [
      { accountDomain: "acme.example", fullName: "Ada Lovelace", title: "CRO", email: "Ada@acme.example" },
      { accountDomain: "acme.example", fullName: "Bo Nogood", title: "=HYPERLINK(\"x\")" },
      { accountDomain: "beta.example", fullName: "Cy Twin", email: "twin@example.com" },
      { accountDomain: "acme.example", fullName: "Di Twin", email: "twin@example.com" },
    ],
    source: "pipe0",
    idempotencyKey: "c",
  });
  const rows = (await client.listRegister("ws", "contact", {})).rows;
  const ada = rows.find((r) => r.title === "Ada Lovelace")!;
  const ports = {
    // Ada is worked: her row carries a stream and a phone. The list pages are all the resolver reads.
    listContacts: async (req: Parameters<typeof client.listRegister>[2]) => {
      const page = await client.listRegister("ws", "contact", req);
      return { ...page, rows: page.rows.map((r) => (r.id === ada.id ? { ...r, stream: "stream-ada", values: { ...r.values, phone: "+1 555 0100" } } : r)) };
    },
    getContact: async (): Promise<null> => assert.fail("listed contacts are not read one by one"),
    accountNames: (ids: string[]) => accountNamesByList(client, "ws", ids),
    customValues: async () => ({ "stream-ada": { "custom.deep_link": "https://app.example/ada?x=1&y=2" } }),
  };
  return { ports };
}

/** An Instantly that remembers what it was sent and created a lead for every email it had not seen. */
function fakeInstantly() {
  const calls: Array<{ path: string; auth: string | null; body: any }> = [];
  const inCampaign = new Set<string>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: new URL(url).pathname, auth: new Headers(init.headers).get("Authorization"), body });
    const created = (body?.leads ?? []).filter((l: { email: string }) => !inCampaign.has(l.email.toLowerCase()));
    for (const l of created) inCampaign.add(l.email.toLowerCase());
    return new Response(JSON.stringify({ status: "success", leads_uploaded: created.length, created_leads: created.map((l: { email: string }) => ({ email: l.email })) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function memoryPorts() {
  const rows: Array<MemberRow & { target: string }> = [];
  const ports: PushPorts = {
    suppressed: async () => new Map(),
    sentEmails: async (target) => new Set(rows.filter((r) => r.target === target && r.outcome === "sent" && r.email).map((r) => r.email!)),
    record: async (target, added) => void rows.push(...added.map((r) => ({ ...r, target }))),
  };
  return { rows, ports };
}

test("an audience pushes to Instantly with custom variables, skips what cannot go, and a re-push adds nothing twice", async () => {
  const { ports: source } = await workspace();
  const { contacts, tooLarge } = await resolveContacts(source, []);
  assert.equal(tooLarge, false);
  assert.equal(contacts.length, 4);
  assert.equal(contacts.find((c) => c.fullName === "Ada Lovelace")!.company, "Acme, Inc.");

  const { calls, fetchImpl } = fakeInstantly();
  const client = createInstantlyClient({ apiKey: KEY, fetchImpl });
  const store = memoryPorts();
  const preview = await previewPush("instantly", contacts, "camp-1", store.ports);
  assert.deepEqual(preview, { total: 4, toSend: 2, skippedNoEmail: 1, skippedDuplicate: 1, alreadySent: 0, skippedUnfit: 0, skippedSuppressed: 0 });

  const first = await pushTo({ provider: "instantly", contacts, campaignId: "camp-1", client, ports: store.ports });
  assert.equal(first.sent, 2);
  const [call] = calls;
  assert.equal(call.path, "/api/v2/leads/add");
  assert.equal(call.auth, `Bearer ${KEY}`);
  assert.equal(call.body.campaign_id, "camp-1");
  assert.equal(call.body.skip_if_in_campaign, true);
  assert.deepEqual(call.body.leads.find((l: { first_name: string }) => l.first_name === "Ada"), {
    email: "Ada@acme.example", first_name: "Ada", last_name: "Lovelace", company_name: "Acme, Inc.", job_title: "CRO", phone: "+1 555 0100",
    custom_variables: { deep_link: "https://app.example/ada?x=1&y=2" },
  });
  assert.deepEqual(store.rows.filter((r) => r.outcome === "skipped").map((r) => r.reason).sort(), ["no email", "same email as another contact"]);

  // Same audience, same campaign: nothing goes. A new contact is the only one that does.
  const again = await pushTo({ provider: "instantly", contacts, campaignId: "camp-1", client, ports: store.ports });
  assert.equal(again.alreadySent, 2);
  assert.equal(calls.length, 1);
  const newcomer = { ...contacts[0], id: "new", email: "new@acme.example", fullName: "New Person", custom: {} };
  await pushTo({ provider: "instantly", contacts: [...contacts, newcomer], campaignId: "camp-1", client, ports: store.ports });
  assert.deepEqual(calls[1].body.leads.map((l: { email: string }) => l.email), ["new@acme.example"]);
  // Another campaign has its own history.
  assert.equal((await previewPush("instantly", contacts, "camp-2", store.ports)).toSend, 2);
  assert.equal(targetOf("instantly", "camp-1"), "instantly:camp-1");
  assert.ok(store.rows.some((r) => r.target === "instantly:camp-1" && r.outcome === "sent"));
});

test("the CSV carries custom fields as columns, quotes cells, and keeps spreadsheets from running formulas", async () => {
  const { ports } = await workspace();
  const { contacts } = await resolveContacts(ports, []);
  const lines = csvOf(contacts).trim().split("\r\n");
  assert.equal(lines[0], "email,first_name,last_name,company,title,phone,linkedin_url,deep_link");
  const ada = lines.find((l) => l.startsWith("Ada@"))!;
  assert.ok(ada.includes('"Acme, Inc."') && ada.includes("+1 555 0100") && ada.endsWith("https://app.example/ada?x=1&y=2"));
  assert.ok(csvOf(contacts).includes(`"'=HYPERLINK(""x"")"`));
});

test("an Instantly refusal says so without the key or the response", async () => {
  const fetchImpl = (async () => new Response(`bad key ${KEY}`, { status: 401 })) as unknown as typeof fetch;
  const err = await createInstantlyClient({ apiKey: KEY, fetchImpl }).validate().catch((e) => e);
  assert.ok(err instanceof SequencerError && err.status === 401);
  assert.ok(!err.message.includes(KEY));
});

test("the sent-email dedupe reads every page, and a history cut short leaves out the run it may have split", async () => {
  const pages = [["a@x.io", "b@x.io"], ["c@x.io"]];
  assert.deepEqual(await readAll(async (cursor) => ({ items: pages[Number(cursor ?? 0)], next: cursor === null ? "1" : null })), ["a@x.io", "b@x.io", "c@x.io"]);
  const rows = [{ target: "csv", at: 2, outcome: "exported" as const }, { target: "csv", at: 2, outcome: "exported" as const }, { target: "csv", at: 1, outcome: "exported" as const }];
  assert.deepEqual(runsOf(rows, true).map((r) => [r.at, r.exported]), [[2, 2]]);
  assert.equal(runsOf(rows, false).length, 2);
});
