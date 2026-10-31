/**
 * A fake HubSpot portal behind `fetch`, in the v3 and v4 response shapes the import client and the connector read
 * (CP12). Tests pass `fakeHubspotFetch(portal)` as `fetchImpl`; a local stack connects it with a `fixture:` token
 * (hubspotFixture.ts), so an import runs end to end without a real portal. Writes are refused: nothing here
 * accepts a PATCH, PUT or DELETE.
 *
 * The fixture is written by hand in HubSpot's shapes (paging by `after`, `propertiesWithHistory`, v4 association
 * types with labels), not captured from a live portal.
 */
import type { HsAssociation, HsOwner, HsPipeline, HsProperty, HsRecord } from "../client.ts";

type Assoc = { from: string; to: string; types: Array<{ category: string; typeId: number; label: string | null }> };

export type FakePortal = {
  portalId: number;
  domain: string;
  owners: HsOwner[];
  pipelines: HsPipeline[];
  objects: Record<string, HsRecord[]>;
  /** Associations by `<from>/<to>` object pair (v4 names). */
  associations: Record<string, Assoc[]>;
  files: Record<string, { name: string; extension: string; url: string }>;
  /** Property definitions by object: a few of HubSpot's own and the portal's custom ones. */
  properties: Record<string, HsProperty[]>;
  /** Objects the token cannot read (403); `files` is the Files API. */
  forbidden: readonly string[];
};

const at = (iso: string) => `${iso}T15:00:00.000Z`;
const rec = (id: string, created: string, properties: Record<string, string | null>, history?: HsRecord["propertiesWithHistory"]): HsRecord => ({
  id, createdAt: at(created), updatedAt: at("2026-09-01"), properties: { hs_object_id: id, createdate: at(created), ...properties },
  ...(history ? { propertiesWithHistory: history } : {}),
});
const primary = (from: string, to: string, typeId: number): Assoc => ({ from, to, types: [{ category: "HUBSPOT_DEFINED", typeId, label: "Primary" }, { category: "HUBSPOT_DEFINED", typeId: typeId === 1 ? 279 : 341, label: null }] });
const plain = (from: string, to: string, typeId: number): Assoc => ({ from, to, types: [{ category: "HUBSPOT_DEFINED", typeId, label: null }] });
const labelled = (from: string, to: string, label: string, typeId: number): Assoc => ({ from, to, types: [{ category: "HUBSPOT_DEFINED", typeId: 3, label: null }, { category: "USER_DEFINED", typeId, label }] });

const stage = (id: string, label: string, displayOrder: number, probability: string, isClosed = false) => ({ id, label, displayOrder, metadata: { probability, isClosed: String(isClosed) } });

/**
 * Two pipelines, six companies (one a child of another), eight people (one at two companies), six deals with
 * labelled people, and engagements of each type: calls, meetings, notes (one with an attachment), tasks, emails.
 */
export function northwindPortal(opts: { forbidden?: readonly string[] } = {}): FakePortal {
  return {
    portalId: 990001,
    domain: "northwind-fixture.example",
    owners: [
      { id: "101", email: "morgan@fullstackgtm.demo", firstName: "Morgan", lastName: "Lee" },
      { id: "102", email: "avery@fullstackgtm.demo", firstName: "Avery", lastName: "Kim" },
      { id: "103", email: "casey@oldco.example", firstName: "Casey", lastName: "Ortiz" },
      { id: "104", email: "pat@oldco.example", firstName: "Pat", lastName: "Doe", archived: true },
    ],
    pipelines: [
      {
        id: "default", label: "Sales Pipeline", displayOrder: 0, stages: [
          stage("appointmentscheduled", "Appointment scheduled", 0, "0.2"),
          stage("qualifiedtobuy", "Qualified to buy", 1, "0.4"),
          stage("presentationscheduled", "Presentation scheduled", 2, "0.6"),
          stage("contractsent", "Contract sent", 3, "0.9"),
          stage("closedwon", "Closed won", 4, "1.0", true),
          stage("closedlost", "Closed lost", 5, "0.0", true),
        ],
      },
      {
        id: "7001", label: "Renewals", displayOrder: 1, stages: [
          stage("7001001", "Renewal due", 0, "0.5"),
          stage("7001002", "Renewal negotiating", 1, "0.7"),
          stage("7001003", "Renewed", 2, "1.0", true),
          stage("7001004", "Churned", 3, "0.0", true),
        ],
      },
    ],
    objects: {
      companies: [
        rec("2001", "2021-03-04", { name: "Northwind Holdings", domain: "northwind.example", industry: "Logistics", numberofemployees: "1200", annualrevenue: "250000000", hubspot_owner_id: "101", tier: "gold", contract_end: "2027-03-31" }, { hubspot_owner_id: [{ value: "101", timestamp: at("2022-01-10"), sourceType: "CRM_UI" }, { value: "103", timestamp: at("2021-03-04"), sourceType: "CRM_UI" }] }),
        rec("2002", "2022-06-10", { name: "Northwind Labs", domain: "nwlabs.example", industry: "Research", numberofemployees: "80", hubspot_owner_id: "102", hs_parent_company_id: "2001", tier: "silver" }),
        rec("2003", "2023-01-15", { name: "Globex", domain: "globex.example", industry: "Manufacturing", numberofemployees: "5400", hubspot_owner_id: "103" }),
        rec("2004", "2020-11-02", { name: "Initech", domain: "initech.example", industry: "Software", numberofemployees: "300", annualrevenue: "42000000", hubspot_owner_id: "101" }),
        rec("2005", "2024-02-20", { name: "Umbrella Health", domain: "umbrella.example", industry: "Healthcare" }),
        rec("2006", "2025-05-05", { name: "Hooli", industry: "Internet", hubspot_owner_id: "104" }),
      ],
      contacts: [
        rec("3001", "2021-03-05", { firstname: "Ada", lastname: "Lovelace", email: "ada@northwind.example", hs_additional_emails: "ada.lovelace@gmail.example;ada@northwind-labs.example", jobtitle: "VP Engineering", phone: "+1 555 0101", mobilephone: "+1 555 0199", hubspot_owner_id: "101", lifecyclestage: "customer", hs_lead_status: "OPEN_DEAL", nps_score: "9", newsletter: "true", interests: "api;sso" }, {
          lifecyclestage: [{ value: "customer", timestamp: at("2024-03-01"), sourceType: "CRM_UI" }, { value: "opportunity", timestamp: at("2023-05-01"), sourceType: "CRM_UI" }, { value: "lead", timestamp: at("2021-03-05"), sourceType: "CRM_UI" }],
          hubspot_owner_id: [{ value: "101", timestamp: at("2022-01-10"), sourceType: "CRM_UI" }, { value: "102", timestamp: at("2021-03-05"), sourceType: "CRM_UI" }],
        }),
        rec("3002", "2021-04-12", { firstname: "Grace", lastname: "Hopper", email: "grace@northwind.example", jobtitle: "CTO", hubspot_owner_id: "102", lifecyclestage: "opportunity", hs_lead_status: "IN_PROGRESS", nps_score: "6", newsletter: "false" }),
        rec("3003", "2023-01-16", { firstname: "Alan", lastname: "Turing", email: "alan@globex.example", jobtitle: "Head of Data", hubspot_owner_id: "103", lifecyclestage: "salesqualifiedlead", hs_lead_status: "CONNECTED" }),
        rec("3004", "2022-08-30", { firstname: "Katherine", lastname: "Johnson", email: "kj@initech.example", jobtitle: "Analyst", lifecyclestage: "marketingqualifiedlead", hs_lead_status: "NEW" }),
        rec("3005", "2024-02-21", { firstname: "Linus", lastname: "Torvalds", email: "linus@umbrella.example", lifecyclestage: "lead", hs_lead_status: "ATTEMPTED_TO_CONTACT" }),
        rec("3006", "2020-11-03", { firstname: "Margaret", lastname: "Hamilton", email: "margaret@initech.example", jobtitle: "COO", hubspot_owner_id: "101", lifecyclestage: "customer", hs_lead_status: "UNQUALIFIED" }),
        rec("3007", "2022-06-11", { firstname: "Dennis", lastname: "Ritchie", email: "dennis@nwlabs.example", lifecyclestage: "subscriber" }),
        rec("3008", "2025-01-09", { firstname: "Barbara", lastname: "Liskov", email: "barbara@personal.example", lifecyclestage: "evangelist", hs_lead_status: "BAD_TIMING" }),
      ],
      deals: [
        rec("4001", "2026-04-01", { dealname: "Northwind platform", pipeline: "default", dealstage: "contractsent", amount: "120000", closedate: at("2026-11-30"), hubspot_owner_id: "101", dealtype: "newbusiness", competitor: "Initrode", deal_source: "partner" }, {
          dealstage: [{ value: "contractsent", timestamp: at("2026-08-01"), sourceType: "CRM_UI" }, { value: "presentationscheduled", timestamp: at("2026-06-01"), sourceType: "CRM_UI" }, { value: "appointmentscheduled", timestamp: at("2026-04-01"), sourceType: "CRM_UI" }],
          amount: [{ value: "120000", timestamp: at("2026-08-01"), sourceType: "CRM_UI" }, { value: "90000", timestamp: at("2026-04-01"), sourceType: "CRM_UI" }],
          hubspot_owner_id: [{ value: "101", timestamp: at("2026-04-01"), sourceType: "CRM_UI" }],
        }),
        rec("4002", "2025-12-01", { dealname: "Northwind Labs pilot", pipeline: "default", dealstage: "closedwon", amount: "15000", closedate: at("2026-02-15"), hubspot_owner_id: "102" }),
        rec("4003", "2026-06-20", { dealname: "Globex expansion", pipeline: "default", dealstage: "qualifiedtobuy", amount: "48000", closedate: at("2026-12-15"), hubspot_owner_id: "103", dealtype: "existingbusiness" }),
        rec("4004", "2026-07-01", { dealname: "Initech renewal 2026", pipeline: "7001", dealstage: "7001002", amount: "60000", closedate: at("2026-10-31"), hubspot_owner_id: "101", dealtype: "renewal" }),
        rec("4005", "2025-07-01", { dealname: "Initech renewal 2025", pipeline: "7001", dealstage: "7001003", amount: "55000", closedate: at("2025-09-30"), hubspot_owner_id: "101", dealtype: "renewal" }),
        rec("4006", "2025-03-03", { dealname: "Umbrella renewal", pipeline: "7001", dealstage: "7001004", amount: "10000", closedate: at("2025-06-30"), dealtype: "renewal" }),
      ],
      calls: [
        rec("5001", "2026-09-10", { hs_timestamp: "2026-09-10T16:30:00.000Z", hubspot_owner_id: "101", hs_call_title: "Pricing walkthrough", hs_call_body: "<p>Walked Ada through pricing.</p><p>Next: send the MSA.</p>", hs_call_direction: "OUTBOUND", hs_call_duration: "1260000", hs_call_disposition: "f240bbac-87c9-4f6e-bf70-924b57d47db7" }),
        rec("5002", "2026-08-02", { hs_timestamp: "2026-08-02T14:00:00.000Z", hubspot_owner_id: "103", hs_call_title: "Intro call", hs_call_direction: "OUTBOUND", hs_call_duration: "45000", hs_call_disposition: "b2cf5968-551e-4856-9783-52b3da59a7d0" }),
      ],
      meetings: [
        rec("5101", "2026-09-01", { hs_timestamp: "2026-09-15T17:00:00.000Z", hubspot_owner_id: "101", hs_meeting_title: "Northwind platform demo", hs_meeting_body: "Demo for the platform team", hs_meeting_start_time: "2026-09-15T17:00:00.000Z", hs_meeting_end_time: "2026-09-15T18:00:00.000Z", hs_meeting_location: "Zoom", hs_meeting_outcome: "COMPLETED" }),
        rec("5102", "2026-09-20", { hs_timestamp: "2026-10-20T15:00:00.000Z", hubspot_owner_id: "101", hs_meeting_title: "Initech renewal review", hs_meeting_start_time: "2026-10-20T15:00:00.000Z", hs_meeting_end_time: "2026-10-20T15:30:00.000Z", hs_meeting_outcome: "SCHEDULED" }),
      ],
      notes: [
        rec("5201", "2026-09-11", { hs_timestamp: "2026-09-11T09:00:00.000Z", hubspot_owner_id: "101", hs_note_body: "<div>Ada wants SSO before signing.<br>Security review booked.</div>", hs_attachment_ids: "9001" }),
        rec("5202", "2026-07-02", { hs_timestamp: "2026-07-02T10:00:00.000Z", hubspot_owner_id: "104", hs_note_body: "Renewal at risk: budget freeze until Q4." }),
      ],
      tasks: [
        rec("5301", "2026-09-25", { hs_timestamp: "2026-10-05T17:00:00.000Z", hubspot_owner_id: "101", hs_task_subject: "Send renewal quote", hs_task_body: "Include the 3-year option", hs_task_status: "NOT_STARTED", hs_task_priority: "HIGH" }),
        rec("5302", "2026-08-15", { hs_timestamp: "2026-08-20T17:00:00.000Z", hubspot_owner_id: "102", hs_task_subject: "Share onboarding guide", hs_task_status: "COMPLETED", hs_task_priority: "MEDIUM" }),
      ],
      emails: [
        rec("5401", "2026-09-12", { hs_timestamp: "2026-09-12T13:05:00.000Z", hubspot_owner_id: "101", hs_email_subject: "Northwind MSA", hs_email_text: "Hi Ada, the MSA is attached. Morgan", hs_email_direction: "EMAIL", hs_email_from_email: "morgan@fullstackgtm.demo", hs_email_to_email: "ada@northwind.example" }),
        rec("5402", "2026-09-13", { hs_timestamp: "2026-09-13T08:40:00.000Z", hs_email_subject: "Re: Northwind MSA", hs_email_text: "Thanks Morgan, legal is reviewing it this week.", hs_email_direction: "INCOMING_EMAIL", hs_email_from_email: "ada@northwind.example", hs_email_to_email: "morgan@fullstackgtm.demo" }),
        rec("5403", "2026-08-03", { hs_timestamp: "2026-08-03T12:00:00.000Z", hubspot_owner_id: "103", hs_email_subject: "Following up", hs_email_html: "<p>Hi Alan,</p><p>Following up on my voicemail.</p>", hs_email_direction: "EMAIL", hs_email_from_email: "casey@oldco.example", hs_email_to_email: "alan@globex.example" }),
      ],
    },
    properties: {
      companies: [
        { name: "name", label: "Company name", type: "string", fieldType: "text", hubspotDefined: true },
        { name: "tier", label: "Customer tier", type: "enumeration", fieldType: "select", options: [{ label: "Gold", value: "gold" }, { label: "Silver", value: "silver" }] },
        { name: "contract_end", label: "Contract end", type: "date", fieldType: "date" },
        { name: "health_formula", label: "Health formula", type: "number", fieldType: "calculation_equation", calculated: true },
      ],
      contacts: [
        { name: "email", label: "Email", type: "string", fieldType: "text", hubspotDefined: true },
        { name: "nps_score", label: "NPS score", type: "number", fieldType: "number" },
        { name: "newsletter", label: "Newsletter", type: "enumeration", fieldType: "booleancheckbox", options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] },
        { name: "interests", label: "Interests", type: "enumeration", fieldType: "checkbox", options: [{ label: "API", value: "api" }, { label: "SSO", value: "sso" }, { label: "SLA", value: "sla" }] },
      ],
      deals: [
        { name: "dealname", label: "Deal name", type: "string", fieldType: "text", hubspotDefined: true },
        { name: "competitor", label: "Main competitor", type: "string", fieldType: "text" },
        { name: "deal_source", label: "Deal source", type: "enumeration", fieldType: "radio", options: [{ label: "Partner", value: "partner" }, { label: "Inbound", value: "inbound" }] },
      ],
    },
    files: { "9001": { name: "Northwind MSA", extension: "pdf", url: "https://files.example/northwind-msa.pdf" } },
    associations: {
      "calls/contacts": [plain("5001", "3001", 194), plain("5002", "3003", 194)],
      "calls/companies": [plain("5001", "2001", 182), plain("5002", "2003", 182)],
      "calls/deals": [plain("5001", "4001", 206)],
      "meetings/contacts": [plain("5101", "3001", 200), plain("5101", "3002", 200), plain("5102", "3006", 200)],
      "meetings/companies": [plain("5101", "2001", 188), plain("5102", "2004", 188)],
      "meetings/deals": [plain("5101", "4001", 212), plain("5102", "4004", 212)],
      "notes/contacts": [plain("5201", "3001", 202)],
      "notes/companies": [plain("5201", "2001", 190), plain("5202", "2004", 190)],
      "notes/deals": [plain("5202", "4004", 214)],
      "tasks/contacts": [plain("5301", "3006", 204), plain("5302", "3004", 204)],
      "tasks/companies": [plain("5301", "2004", 192)],
      "tasks/deals": [plain("5301", "4004", 216)],
      "emails/contacts": [plain("5401", "3001", 198), plain("5402", "3001", 198), plain("5403", "3003", 198)],
      "emails/companies": [plain("5401", "2001", 186), plain("5403", "2003", 186)],
      "emails/deals": [plain("5401", "4001", 210)],
      "contacts/companies": [
        primary("3001", "2001", 1), plain("3001", "2002", 279),
        primary("3002", "2001", 1), primary("3003", "2003", 1), primary("3004", "2004", 1),
        primary("3005", "2005", 1), primary("3006", "2004", 1), primary("3007", "2002", 1),
      ],
      "deals/companies": [
        primary("4001", "2001", 5), primary("4002", "2002", 5), primary("4003", "2003", 5),
        primary("4004", "2004", 5), plain("4004", "2002", 341), primary("4005", "2004", 5), primary("4006", "2005", 5),
      ],
      "deals/contacts": [
        labelled("4001", "3001", "Decision maker", 31), labelled("4001", "3002", "Champion", 33),
        plain("4002", "3007", 3), labelled("4003", "3003", "Technical evaluator", 35),
        labelled("4004", "3006", "Signer", 37), labelled("4004", "3004", "End user", 39),
      ],
    },
    forbidden: opts.forbidden ?? [],
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** v3's `associations` on a record: each company with HubSpot's v3 type name (`contact_to_company` is the primary). */
function v3Associations(portal: FakePortal, object: string, id: string, to: string) {
  const single = object.replace(/s$/, "").replace(/ie$/, "y");
  const results = (portal.associations[`${object}/${to}`] ?? []).filter((a) => a.from === id).map((a) => ({
    id: a.to, type: a.types.some((t) => t.label === "Primary") ? `${single}_to_company` : `${single}_to_company_unlabeled`,
  }));
  return { [to]: { results } };
}

function page<T>(items: readonly T[], url: URL, max: number) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? max), max);
  const start = Number(url.searchParams.get("after") ?? 0);
  const next = start + limit < items.length ? { next: { after: String(start + limit) } } : {};
  return { results: items.slice(start, start + limit), paging: next };
}

/** `fetch` against the portal: GET reads and v4 association batch reads. Anything else is a 405. */
export function fakeHubspotFetch(portal: FakePortal): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/account-info/v3/details") return json({ portalId: portal.portalId, domain: portal.domain, uiDomain: "app.hubspot.com" });
    if (path === "/crm/v3/owners" || path === "/crm/v3/owners/") {
      const archived = url.searchParams.get("archived") === "true";
      return json(page(portal.owners.filter((o) => Boolean(o.archived) === archived).map(({ archived: _, ...o }) => o), url, 100));
    }
    if (path === "/crm/v3/pipelines/deals") return json({ results: portal.pipelines });
    const props = /^\/crm\/v3\/properties\/(\w+)$/.exec(path);
    if (props) return json({ results: portal.properties[props[1]] ?? [] });
    const file = /^\/files\/v3\/files\/(\w+)$/.exec(path);
    if (file) {
      if (portal.forbidden.includes("files")) return json({ status: "error", category: "MISSING_SCOPES" }, 403);
      const f = portal.files[file[1]];
      return f ? json({ id: file[1], ...f }) : json({ status: "error" }, 404);
    }
    const objects = /^\/crm\/v3\/objects\/(\w+)$/.exec(path);
    if (objects && method === "GET") {
      const object = objects[1];
      if (portal.forbidden.includes(object)) return json({ status: "error", category: "MISSING_SCOPES" }, 403);
      const history = new Set((url.searchParams.get("propertiesWithHistory") ?? "").split(",").filter(Boolean));
      const assoc = (url.searchParams.get("associations") ?? "").split(",").filter(Boolean);
      const records = (portal.objects[object] ?? []).map((r) => ({
        ...r,
        propertiesWithHistory: history.size ? Object.fromEntries(Object.entries(r.propertiesWithHistory ?? {}).filter(([k]) => history.has(k))) : undefined,
        ...(assoc.length ? { associations: Object.assign({}, ...assoc.map((to) => v3Associations(portal, object, r.id, to))) } : {}),
      }));
      return json(page(records, url, history.size ? 50 : 100));
    }
    const search = /^\/crm\/v3\/objects\/(\w+)\/search$/.exec(path);
    if (search && method === "POST") {
      if (portal.forbidden.includes(search[1])) return json({ status: "error", category: "MISSING_SCOPES" }, 403);
      return json({ total: (portal.objects[search[1]] ?? []).length, results: [] });
    }
    const batch = /^\/crm\/v4\/associations\/(\w+)\/(\w+)\/batch\/read$/.exec(path);
    if (batch && method === "POST") {
      const [, from, to] = batch;
      if (portal.forbidden.includes(from)) return json({ status: "error", category: "MISSING_SCOPES" }, 403);
      const ids = (JSON.parse(String(init?.body ?? "{}")) as { inputs?: Array<{ id: string }> }).inputs?.map((i) => String(i.id)) ?? [];
      const all = portal.associations[`${from}/${to}`] ?? [];
      const results = ids.flatMap((id) => {
        const to: HsAssociation[] = all.filter((a) => a.from === id).map((a) => ({ toObjectId: a.to, associationTypes: a.types }));
        return to.length ? [{ from: { id }, to }] : [];
      });
      return json({ status: "COMPLETE", results });
    }
    return json({ status: "error", message: `The fake portal does not serve ${method} ${path}` }, method === "GET" ? 404 : 405);
  }) as typeof fetch;
}
