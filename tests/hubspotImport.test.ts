import assert from "node:assert/strict";
import test from "node:test";
import { createHubspotImportClient, HubspotScopeError } from "../engine/src/sync/hubspotImport/client.ts";
import { fakeHubspotFetch, northwindPortal } from "../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";
import { hubspotContact } from "../engine/src/connectors/hubspot.ts";
import { attachmentText, customSpecs, customValues, historyFacts, companiesOf, compareRecord, contactExtras, dealRoleOf, engagementOf, lanesFor, matchOwners, nextPhase, planHubspotPipelines, sampleOf, stageOf } from "../convex/lib/hubspotImport.ts";
import { chunkKeeping } from "../convex/lib/batchWrites.ts";

const client = (forbidden: string[] = []) =>
  createHubspotImportClient({ getAccessToken: () => "t", fetchImpl: fakeHubspotFetch(northwindPortal({ forbidden })), sleep: async () => {} });

test("the client pages a portal and reads v4 associations with their labels", async () => {
  const hs = client();
  const first = await hs.page("contacts", { after: null, properties: ["email"] });
  assert.equal(first.results.length, 8);
  assert.equal(first.after, null);
  const deals = await hs.associations("deals", "contacts", ["4001", "4002"]);
  assert.deepEqual(deals.get("4001")!.map(dealRoleOf), ["executive", "champion"]);
  assert.deepEqual(deals.get("4002")!.map(dealRoleOf), ["involved"]);
  assert.equal(await hs.count("deals"), 6);
});

test("an object the token cannot read is a scope error, not a failure", async () => {
  await assert.rejects(client(["calls"]).page("calls", { after: null, properties: [] }), (e) => e instanceof HubspotScopeError && e.object === "calls");
});

test("a person's primary company comes first, from v4 types and from v3 list associations", async () => {
  const hs = client();
  const assocs = await hs.associations("contacts", "companies", ["3001"]);
  assert.deepEqual(companiesOf(assocs.get("3001")!), { primary: "2001", companies: ["2001", "2002"] });
  const page = await hs.page("contacts", { after: null, properties: ["email"], associations: ["companies"] });
  assert.equal(hubspotContact(page.results[0]).accountId, "2001");
});

test("deal labels map to roles by the words they contain", () => {
  const role = (label: string) => dealRoleOf({ toObjectId: "1", associationTypes: [{ category: "USER_DEFINED", typeId: 9, label }] });
  assert.deepEqual(
    ["Decision maker", "Champion", "Economic Buyer", "End user", "Signer", "Legal", "IT Security", "N-1", "Technical evaluator"].map(role),
    ["executive", "champion", "executive", "user", "signer", "procurement", "security", "n1", "involved"],
  );
});

test("lifecycle stage and lead status become Canon values, other emails and the mobile the person's lists; a portal's own status is reported", () => {
  const none = { additionalEmails: null, additionalPhones: null };
  assert.deepEqual(contactExtras({ lifecyclestage: "marketingqualifiedlead", hs_lead_status: "OPEN_DEAL" }), { values: { lifecycleStage: "mql", leadStatus: "qualified", ...none }, unmapped: [] });
  assert.deepEqual(contactExtras({ lifecyclestage: "1234567", hs_lead_status: "CUSTOM_X" }), { values: { lifecycleStage: "other", leadStatus: null, ...none }, unmapped: ["lead status CUSTOM_X"] });
  assert.deepEqual(contactExtras({}), { values: { lifecycleStage: null, leadStatus: null, ...none }, unmapped: [] });
  // HubSpot's list is semicolon-separated and can repeat the primary.
  assert.deepEqual(contactExtras({ email: "ada@northwind.example", hs_additional_emails: "ada@gmail.example; ADA@northwind.example;", mobilephone: "+1 555 0199" }).values,
    { lifecycleStage: null, leadStatus: null, additionalEmails: ["ada@gmail.example"], additionalPhones: ["+1 555 0199"] });
});

test("HubSpot pipelines become Canon pipelines by stage id, and a re-run replaces them", () => {
  const portal = northwindPortal();
  const stock = [{ value: "prospecting", label: "Prospecting", active: true }, { value: "closedwon", label: "closedwon", active: true }];
  const first = planHubspotPipelines(stock, [], portal.pipelines);
  assert.deepEqual(first.writes.map((w) => [w.kind, w.name, w.stages.map((s) => `${s.value}:${s.probability}:${s.forecastCategory}`).join(" ")]), [
    ["insert", "Sales pipeline", "prospecting:50:pipeline"],
    ["insert", "Sales Pipeline", "appointmentscheduled:20:pipeline qualifiedtobuy:40:pipeline presentationscheduled:60:pipeline contractsent:90:pipeline closedwon:100:closed_won closedlost:0:closed_lost"],
    ["insert", "Renewals", "7001001:50:pipeline 7001002:70:pipeline 7001003:100:closed_won 7001004:0:closed_lost"],
  ]);
  assert.equal(first.options.find((o) => o.value === "closedwon")!.label, "Closed won");
  const stored = first.writes.map((w, i) => ({ id: `p${i}`, name: w.name, stages: w.stages, createdAt: i }));
  const again = planHubspotPipelines(first.options, stored, portal.pipelines);
  assert.deepEqual(again.writes.map((w) => [w.kind, w.kind === "replace" ? w.id : null, w.name]), [["replace", "p1", "Sales Pipeline"], ["replace", "p2", "Renewals"]]);
});

test("owners match members by email; a placeholder or a deactivated owner is not a member", () => {
  const members = new Map([["morgan@fullstackgtm.demo", { userId: "u1", placeholder: false }], ["casey@oldco.example", { userId: "u3", placeholder: true }]]);
  const out = matchOwners(northwindPortal().owners, members, { 101: "u1", 102: "u2", 103: "u3" });
  assert.deepEqual(out.map((o) => [o.crmOwnerId, o.userId, o.member, o.archived]), [["101", "u1", true, false], ["102", "u2", false, false], ["103", "u3", false, false], ["104", null, false, true]]);
});

test("links run after records, and only for what was picked", () => {
  assert.equal(nextPhase("owners", ["contacts"]), "contacts");
  assert.equal(nextPhase("contacts", ["contacts"]), "done");
  assert.equal(nextPhase("deals", ["deals", "links"]), "parents");
});

test("links and engagements run as lanes; a run that reached them one phase at a time keeps its place", () => {
  assert.deepEqual(stageOf("contactCompanies"), ["parents", "contactCompanies", "dealContacts"]);
  assert.equal(stageOf("deals"), undefined);
  // Fresh at the engagements: a lane per type, each from the start.
  assert.deepEqual(lanesFor({ phase: "calls", cursor: null, objects: ["engagements"] }, stageOf("calls")!).map((l) => [l.phase, l.cursor, l.done]),
    [["calls", null, false], ["meetings", null, false], ["notes", null, false], ["tasks", null, false], ["emails", null, false]]);
  // Stopped mid-notes before lanes: calls and meetings are done, notes resumes from its page, the rest start.
  assert.deepEqual(lanesFor({ phase: "notes", cursor: "200", objects: ["engagements"] }, stageOf("notes")!).map((l) => [l.phase, l.cursor, l.done]),
    [["calls", null, true], ["meetings", null, true], ["notes", "200", false], ["tasks", null, false], ["emails", null, false]]);
  // A run's own lanes win, copied so the step can advance them.
  const lanes = [{ phase: "parents", cursor: null, done: true }, { phase: "contactCompanies", cursor: "300", done: false }];
  const out = lanesFor({ phase: "contactCompanies", cursor: "300", objects: ["links"], lanes }, stageOf("parents")!);
  assert.deepEqual(out, lanes);
  assert.notEqual(out[0], lanes[0]);
});

test("history batches never part one record's facts", () => {
  const facts = ["a", "a", "a", "b", "c", "c", "c", "c", "d"].map((crmId, i) => ({ crmId, i }));
  assert.deepEqual(chunkKeeping(facts, 3, (f) => f.crmId).map((c) => c.map((f) => f.crmId).join("")), ["aaa", "bcccc", "d"]);
});

test("the spot check samples the same records for a seed and names each wrong field", () => {
  const items = Array.from({ length: 200 }, (_, i) => i);
  assert.deepEqual(sampleOf(items, 5, 42), sampleOf(items, 5, 42));
  assert.equal(new Set(sampleOf(items, 50, 7)).size, 50);
  assert.deepEqual(compareRecord("1", "Ada", { name: "Ada", amount: 100, people: ["b", "a"] }, { name: "Ada", amount: 90, people: ["a", "b"] }), [
    { id: "1", name: "Ada", field: "amount", hubspot: "100", canon: "90" },
  ]);
  assert.deepEqual(compareRecord("2", "Bo", { name: "Bo" }, null), [{ id: "2", name: "Bo", field: "record", hubspot: "2", canon: null }]);
});

test("engagements map to Canon activities and logged emails with HubSpot's dates", () => {
  const portal = northwindPortal();
  const files = new Map([["9001", { name: "Northwind MSA.pdf", url: "https://files.example/msa.pdf" }]]);
  const one = (object: "calls" | "meetings" | "notes" | "tasks" | "emails", i = 0) =>
    engagementOf(object, portal.objects[object][i], object === "notes" && i === 0 ? attachmentText(["9001", "77"], files)! : "");
  const values = (m: ReturnType<typeof one>) => (m.kind === "activity" ? m.values : null);
  assert.deepEqual(one("calls"), {
    kind: "activity", object: "call", createdAt: Date.parse("2026-09-10T16:30:00.000Z"), ownerCrmId: "101",
    values: { subject: "Pricing walkthrough", notes: "Walked Ada through pricing.\nNext: send the MSA.", callAt: Date.parse("2026-09-10T16:30:00.000Z"), direction: "outbound", durationSeconds: 1260, outcome: "connected" },
  });
  assert.equal(values(one("calls", 1))?.outcome, "left_voicemail");
  assert.deepEqual(values(one("meetings")), {
    title: "Northwind platform demo", startAt: Date.parse("2026-09-15T17:00:00.000Z"), endAt: Date.parse("2026-09-15T18:00:00.000Z"), location: "Zoom", outcome: "completed", notes: "Demo for the platform team",
  });
  assert.deepEqual(values(one("notes")), { body: "Ada wants SSO before signing.\nSecurity review booked.\n\nAttachments: Northwind MSA.pdf (https://files.example/msa.pdf); HubSpot file 77" });
  assert.deepEqual(values(one("tasks")), { subject: "Send renewal quote", description: "Include the 3-year option", status: "not_started", priority: "high", dueDate: "2026-10-05" });
  assert.deepEqual(one("emails", 1), {
    kind: "email", ownerCrmId: null,
    email: { direction: "inbound", from: "ada@northwind.example", to: "morgan@fullstackgtm.demo", subject: "Re: Northwind MSA", body: "Thanks Morgan, legal is reviewing it this week.", at: Date.parse("2026-09-13T08:40:00.000Z") },
  });
  const html = one("emails", 2);
  assert.equal(html.kind === "email" ? html.email.body : null, "Hi Alan,\nFollowing up on my voicemail.");
});

test("a portal's own properties become typed custom fields, and their values fit them", () => {
  const props = northwindPortal().properties;
  assert.deepEqual(customSpecs("contact", props.contacts).map((s) => [s.property, s.type, s.options.map((o) => o.value).join(",")]), [
    ["nps_score", "number", ""], ["newsletter", "checkbox", ""], ["interests", "multipicklist", "api,sso,sla"],
  ]);
  assert.deepEqual(customSpecs("account", props.companies).map((s) => [s.property, s.type]), [["tier", "picklist"], ["contract_end", "date"]]);
  assert.deepEqual(customSpecs("deal", [{ name: "tags", label: "Tags", type: "enumeration", fieldType: "checkbox", options: [] }]), []);
  const fields = [
    { object: "contact" as const, property: "nps_score", apiName: "custom.nps", type: "number" as const, options: [] },
    { object: "contact" as const, property: "newsletter", apiName: "custom.news", type: "checkbox" as const, options: [] },
    { object: "contact" as const, property: "interests", apiName: "custom.int", type: "multipicklist" as const, options: [{ hubspot: "api", canon: "api" }, { hubspot: "sso", canon: "sso_2" }] },
    { object: "contact" as const, property: "renewal", apiName: "custom.ren", type: "date" as const, options: [] },
  ];
  assert.deepEqual(customValues("contact", fields, { nps_score: "9", newsletter: "true", interests: "api;sso", renewal: "1798761600000" }), {
    "custom.nps": 9, "custom.news": true, "custom.int": ["api", "sso_2"], "custom.ren": "2027-01-01",
  });
  assert.deepEqual(customValues("contact", fields, { nps_score: "n/a", interests: "api;gone", renewal: "" }), { "custom.ren": null });
});

test("property history becomes dated facts, each its own source record", () => {
  const ada = northwindPortal().objects.contacts[0];
  const owners: Record<string, string> = { 101: "u1" };
  const facts = historyFacts("contacts", ada.id, ada.propertiesWithHistory, (id) => owners[id]);
  assert.deepEqual(facts.map((f) => [f.field, f.value, new Date(f.at).toISOString().slice(0, 10)]), [
    ["lifecycleStage", "customer", "2024-03-01"], ["lifecycleStage", "opportunity", "2023-05-01"], ["lifecycleStage", "lead", "2021-03-05"],
    ["ownerId", "u1", "2022-01-10"],
  ]);
  assert.equal(facts[0].ref, `hubspot-history:contacts:3001:lifecyclestage:${Date.parse("2024-03-01T15:00:00.000Z")}`);
  const deal = northwindPortal().objects.deals[0];
  assert.deepEqual(historyFacts("deals", deal.id, deal.propertiesWithHistory, (id) => id).filter((f) => f.field === "amount").map((f) => f.value), [12000000, 9000000]);
});
