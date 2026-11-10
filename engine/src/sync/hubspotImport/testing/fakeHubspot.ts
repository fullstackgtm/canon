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
  /**
   * Page the object lists by record id, as HubSpot's cursor appears to: `after` is the lowest id a page holds (the
   * last one's id plus one comes back as the next). Off, a cursor is a position in the list, which a sync that reads
   * id ranges must notice and read in one cursor instead.
   */
  idCursor?: boolean;
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
export function northwindPortal(opts: { forbidden?: readonly string[]; columns?: readonly string[] } = {}): FakePortal {
  const portal: FakePortal = {
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
  const industry = opts.columns?.includes("industry") ? withIndustryColumns(portal) : portal;
  const wide = opts.columns?.includes("industry-wide") ? withMoreIndustryColumns(industry) : industry;
  return opts.columns?.includes("revenue") ? withRevenueColumns(wide) : wide;
}

/**
 * Revenue spread over four company columns, for consolidating a quantity on a local stack
 * (`fixture:northwind?columns=revenue`): HubSpot's own `annualrevenue` (on two companies), a ZoomInfo revenue in
 * thousands, a free-text revenue range and a calculated column that can only be a source.
 */
function withRevenueColumns(portal: FakePortal): FakePortal {
  const values: Record<string, Record<string, string>> = {
    "2001": { zi_revenue: "245000", rev_calc: "250000000" },
    "2002": { zi_revenue: "12000", revenue_range: "$10M - $50M" },
    "2003": { zi_revenue: "880000", revenue_range: "$500M+" },
    "2004": { zi_revenue: "45000", rev_calc: "42000000" },
    "2005": { revenue_range: "50M-100M" },
    "2006": { zi_revenue: "3200000" },
  };
  return {
    ...portal,
    objects: { ...portal.objects, companies: portal.objects.companies!.map((r) => ({ ...r, properties: { ...r.properties, ...(values[r.id] ?? {}) } })) },
    properties: {
      ...portal.properties,
      companies: [
        ...portal.properties.companies!,
        { name: "annualrevenue", label: "Annual Revenue", type: "number", fieldType: "number", hubspotDefined: true },
        { name: "zi_revenue", label: "ZoomInfo Revenue (thousands)", type: "number", fieldType: "number" },
        { name: "revenue_range", label: "Revenue Range", type: "string", fieldType: "text" },
        { name: "rev_calc", label: "Revenue (calculated)", type: "number", fieldType: "calculation_equation", calculated: true },
      ],
    },
  };
}

/**
 * Seven more industry columns on top of `industry` (`fixture:northwind?columns=industry,industry-wide`), as a real
 * portal has them: enrichment tools' text columns, a sector picklist and an override picklist nobody fills.
 */
function withMoreIndustryColumns(portal: FakePortal): FakePortal {
  const text = (name: string, label: string) => ({ name, label, type: "string", fieldType: "text" });
  const values: Record<string, Record<string, string>> = {
    "2001": { apollo_industry: "Logistics", usergems_industry: "Transportation", clearbit_sector: "Industrials", li_industry: "Logistics", crunchbase_vertical: "Supply Chain" },
    "2002": { apollo_industry: "Research", clearbit_sector: "Health Care", li_industry: "Research Services" },
    "2003": { apollo_industry: "Manufacturing", usergems_industry: "Manufacturing", clearbit_sector: "Industrials" },
    "2004": { apollo_industry: "Computer Software", li_industry: "Software Development", crunchbase_vertical: "SaaS" },
  };
  // A person-level copy too, so the concept spans two record types.
  const people: Record<string, Record<string, string>> = {
    "3001": { company_industry: "Logistics" },
    "3003": { company_industry: "Research" },
    "3004": { company_industry: "Software" },
  };
  return {
    ...portal,
    objects: {
      ...portal.objects,
      companies: portal.objects.companies!.map((r) => ({ ...r, properties: { ...r.properties, ...(values[r.id] ?? {}) } })),
      contacts: portal.objects.contacts!.map((r) => ({ ...r, properties: { ...r.properties, ...(people[r.id] ?? {}) } })),
    },
    properties: {
      ...portal.properties,
      contacts: [...portal.properties.contacts!, text("company_industry", "Company industry")],
      companies: [
        ...portal.properties.companies!,
        text("apollo_industry", "Apollo Industry"),
        text("usergems_industry", "UserGems Industry"),
        {
          name: "clearbit_sector", label: "Clearbit Sector", type: "enumeration", fieldType: "select",
          options: ["Industrials", "Health Care", "Information Technology"].map((label) => ({ label, value: label })),
        },
        text("li_industry", "LinkedIn Industry"),
        text("crunchbase_vertical", "Crunchbase Vertical"),
        {
          name: "industry_override", label: "Industry Override", type: "enumeration", fieldType: "select",
          options: ["Technology", "Retail"].map((label) => ({ label, value: label.toLowerCase() })),
        },
        text("sector_notes", "Sector notes"),
      ],
    },
  };
}

/**
 * The industry concept spread over three company columns, for field consolidation on a local stack
 * (`fixture:northwind?columns=industry`): HubSpot's own `industry`, a custom `vm_industry__c` picklist whose internal
 * values differ from its labels, and free-text `zi_industry`. One company is linked to a Salesforce Account.
 */
function withIndustryColumns(portal: FakePortal): FakePortal {
  const vm: Record<string, Record<string, string | null>> = {
    "2001": { vm_industry__c: "logistics", zi_industry: "Transportation & Logistics", salesforceaccountid: "001FIXTURE01" },
    "2002": { zi_industry: "Research Services" },
    "2003": { vm_industry__c: "retail", zi_industry: "Manufacturing" },
    "2004": { zi_industry: "Software" },
    "2005": { vm_industry__c: "other", zi_industry: "Hospitals & Physicians Clinics" },
  };
  const option = (label: string, value = label) => ({ label, value });
  return {
    ...portal,
    objects: { ...portal.objects, companies: portal.objects.companies!.map((r) => ({ ...r, properties: { ...r.properties, ...(vm[r.id] ?? {}) } })) },
    properties: {
      ...portal.properties,
      companies: [
        ...portal.properties.companies!,
        { name: "industry", label: "Industry", type: "enumeration", fieldType: "select", hubspotDefined: true, options: ["Logistics", "Research", "Manufacturing", "Software", "Healthcare", "Internet"].map((l) => option(l)) },
        {
          name: "vm_industry__c", label: "VM Industry", type: "enumeration", fieldType: "select",
          options: [option("Logistics", "logistics"), option("Manufacturing", "manufacturing"), option("Technology", "technology"), option("Healthcare", "healthcare"), option("Retail", "retail"), option("Other", "other")],
        },
        { name: "zi_industry", label: "ZoomInfo Industry", type: "string", fieldType: "text" },
      ],
    },
  };
}

/**
 * Northwind plus `scale` synthetic companies, three people and one deal for each, and half as many of each
 * engagement, all associated, with property history on every tenth record: a portal big enough to time a sync or an
 * import against (`fixture:northwind?scale=500`). The generated ids start at 100000, clear of Northwind's.
 */
export function scaledPortal(scale: number, opts: { forbidden?: readonly string[]; columns?: readonly string[] } = {}): FakePortal {
  const portal = northwindPortal(opts);
  const owners = ["101", "102", "103"];
  const add = (key: string, ...a: Assoc[]) => (portal.associations[key] ??= []).push(...a);
  for (let i = 0; i < scale; i++) {
    const co = String(100000 + i);
    const owner = owners[i % owners.length];
    const history = i % 10 === 0 ? { hubspot_owner_id: [{ value: owner, timestamp: at("2025-01-10"), sourceType: "CRM_UI" }, { value: "103", timestamp: at("2024-01-10"), sourceType: "CRM_UI" }] } : undefined;
    portal.objects.companies.push(rec(co, "2024-01-01", { name: `Synthetic ${i}`, domain: `synthetic-${i}.example`, industry: "Software", numberofemployees: String(10 + i), hubspot_owner_id: owner, ...(i % 7 === 6 ? { hs_parent_company_id: String(100000 + i - 1) } : {}) }, history));
    for (let j = 0; j < 3; j++) {
      const ct = String(200000 + i * 3 + j);
      portal.objects.contacts.push(rec(ct, "2024-02-01", { firstname: `Person${j}`, lastname: `Synthetic${i}`, email: `p${j}@synthetic-${i}.example`, hubspot_owner_id: owner, lifecyclestage: "lead", hs_lead_status: "NEW" },
        history ? { lifecyclestage: [{ value: "lead", timestamp: at("2024-02-01"), sourceType: "CRM_UI" }], hubspot_owner_id: history.hubspot_owner_id } : undefined));
      add("contacts/companies", j === 0 ? primary(ct, co, 1) : plain(ct, co, 279));
    }
    const deal = String(300000 + i);
    portal.objects.deals.push(rec(deal, "2025-06-01", { dealname: `Synthetic deal ${i}`, pipeline: "default", dealstage: i % 2 ? "qualifiedtobuy" : "closedwon", amount: String(1000 * (i + 1)), closedate: at("2026-12-01"), hubspot_owner_id: owner },
      history ? { dealstage: [{ value: "qualifiedtobuy", timestamp: at("2025-07-01"), sourceType: "CRM_UI" }, { value: "appointmentscheduled", timestamp: at("2025-06-01"), sourceType: "CRM_UI" }], amount: [{ value: String(1000 * (i + 1)), timestamp: at("2025-06-01"), sourceType: "CRM_UI" }] } : undefined));
    add("deals/companies", primary(deal, co, 5));
    add("deals/contacts", labelled(deal, String(200000 + i * 3), "Decision maker", 31));
    if (i % 2 === 0) {
      for (const [k, object] of (["calls", "meetings", "notes", "tasks", "emails"] as const).entries()) {
        const id = String(400000 + k * 100000 + i);
        const props: Record<string, Record<string, string>> = {
          calls: { hs_call_title: `Call ${i}`, hs_call_direction: "OUTBOUND", hs_call_duration: "60000" },
          meetings: { hs_meeting_title: `Meeting ${i}`, hs_meeting_start_time: at("2026-09-01"), hs_meeting_end_time: at("2026-09-01") },
          notes: { hs_note_body: `Note ${i}` },
          tasks: { hs_task_subject: `Task ${i}`, hs_task_status: "NOT_STARTED", hs_task_priority: "LOW" },
          emails: { hs_email_subject: `Email ${i}`, hs_email_text: "Hello", hs_email_direction: "EMAIL", hs_email_from_email: "morgan@fullstackgtm.demo", hs_email_to_email: `p0@synthetic-${i}.example` },
        };
        portal.objects[object].push(rec(id, "2026-09-01", { hs_timestamp: at("2026-09-01"), hubspot_owner_id: owner, ...props[object] }));
        add(`${object}/contacts`, plain(id, String(200000 + i * 3), 194));
        add(`${object}/companies`, plain(id, co, 182));
        add(`${object}/deals`, plain(id, deal, 206));
      }
    }
  }
  return portal;
}

const json =(body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** v3's `associations` on a record: each company with HubSpot's v3 type name (`contact_to_company` is the primary). */
function v3Associations(portal: FakePortal, object: string, id: string, to: string) {
  const single = object.replace(/s$/, "").replace(/ie$/, "y");
  const results = (portal.associations[`${object}/${to}`] ?? []).filter((a) => a.from === id).map((a) => ({
    id: a.to, type: a.types.some((t) => t.label === "Primary") ? `${single}_to_company` : `${single}_to_company_unlabeled`,
  }));
  return { [to]: { results } };
}

function idPage<T extends { id: string }>(items: readonly T[], url: URL, max: number) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? max), max);
  const from = Number(url.searchParams.get("after") ?? 0);
  const rest = items.filter((r) => Number(r.id) >= from).sort((a, b) => Number(a.id) - Number(b.id));
  const results = rest.slice(0, limit);
  return { results, paging: rest.length > limit ? { next: { after: String(Number(results.at(-1)!.id) + 1) } } : {} };
}

function page<T>(items: readonly T[], url: URL, max: number) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? max), max);
  const start = Number(url.searchParams.get("after") ?? 0);
  const next = start + limit < items.length ? { next: { after: String(start + limit) } } : {};
  return { results: items.slice(start, start + limit), paging: next };
}

type SearchFilter = { propertyName: string; operator: string; value: string };
type SearchBody = { filterGroups?: Array<{ filters: SearchFilter[] }>; sorts?: Array<{ propertyName: string; direction?: string }>; limit?: number; after?: string };

/** A record's value for a search filter or sort, as a number: ids, epoch milliseconds and ISO times compare alike. */
function searchValue(r: HsRecord, property: string): number {
  if (property === "hs_object_id") return Number(r.id);
  const raw = r.properties[property] ?? (property.endsWith("lastmodifieddate") ? r.updatedAt : undefined);
  if (raw === undefined || raw === null) return NaN;
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw);
}

function passes(r: HsRecord, f: SearchFilter): boolean {
  const a = searchValue(r, f.propertyName);
  const b = /^-?\d+(\.\d+)?$/.test(f.value) ? Number(f.value) : Date.parse(f.value);
  if (f.operator === "GTE") return a >= b;
  if (f.operator === "GT") return a > b;
  if (f.operator === "LT") return a < b;
  if (f.operator === "LTE") return a <= b;
  if (f.operator === "EQ") return a === b;
  throw new Error(`The fake portal does not filter with ${f.operator}`);
}

/** Mark the first `count` companies, people and deals modified at `at`, as edits in HubSpot would (an incremental sync reads them). */
export function touchRecords(portal: FakePortal, count: number, at: Date): FakePortal {
  const iso = at.toISOString();
  for (const object of ["companies", "contacts", "deals"]) {
    const modified = object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
    for (const r of (portal.objects[object] ?? []).slice(0, count)) {
      r.updatedAt = iso;
      r.properties[modified] = iso;
    }
  }
  return portal;
}

export type FakeFetchOptions = {
  /** Each response waits this long, as HubSpot's do (a few hundred ms). */
  latencyMs?: number;
  /** HubSpot's rolling window: at most `max` requests per `intervalMs`, its X-HubSpot-RateLimit headers, a 429 past it. */
  rateLimit?: { max: number; intervalMs: number };
  /** Called with each request's path as it arrives, for tests that count or time requests. */
  onRequest?: (path: string) => void;
};

/** `fetch` against the portal: GET reads, v4 association batch reads and token scopes. Anything else is a 405. */
export function fakeHubspotFetch(portal: FakePortal, opts: FakeFetchOptions = {}): typeof fetch {
  const serve = fakeHubspotServe(portal);
  const sent: number[] = [];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    opts.onRequest?.(path);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const limit = opts.rateLimit;
    if (!limit) return serve(input, init);
    const now = Date.now();
    while (sent.length && sent[0] <= now - limit.intervalMs) sent.shift();
    if (sent.length >= limit.max) return new Response(JSON.stringify({ status: "error", category: "RATE_LIMITS" }), { status: 429, headers: { "Retry-After": "1" } });
    sent.push(now);
    const res = await serve(input, init);
    // As HubSpot, search responses carry no rate-limit headers.
    if (path.endsWith("/search")) return res;
    const headers = new Headers(res.headers);
    headers.set("X-HubSpot-RateLimit-Max", String(limit.max));
    headers.set("X-HubSpot-RateLimit-Remaining", String(limit.max - sent.length));
    headers.set("X-HubSpot-RateLimit-Interval-Milliseconds", String(limit.intervalMs));
    return new Response(await res.text(), { status: res.status, headers });
  }) as typeof fetch;
}

function fakeHubspotServe(portal: FakePortal) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/account-info/v3/details") return json({ portalId: portal.portalId, domain: portal.domain, uiDomain: "app.hubspot.com" });
    if (path === "/oauth/v2/private-apps/get/access-token-info" && method === "POST") {
      const objects = ["owners", "companies", "contacts", "deals"].filter((o) => !portal.forbidden.includes(o));
      return json({ hubId: portal.portalId, scopes: objects.map((o) => `crm.objects.${o}.read`) });
    }
    if (path === "/crm/v3/owners" || path === "/crm/v3/owners/") {
      if (portal.forbidden.includes("owners")) return json({ status: "error", category: "MISSING_SCOPES" }, 403);
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
      // Shaped once paged: only a page's records read their history and associations.
      const shape = (r: HsRecord) => ({
        ...r,
        propertiesWithHistory: history.size ? Object.fromEntries(Object.entries(r.propertiesWithHistory ?? {}).filter(([k]) => history.has(k))) : undefined,
        ...(assoc.length ? { associations: Object.assign({}, ...assoc.map((to) => v3Associations(portal, object, r.id, to))) } : {}),
      });
      const records = portal.objects[object] ?? [];
      const listed = portal.idCursor ? idPage(records, url, history.size ? 50 : 100) : page(records, url, history.size ? 50 : 100);
      return json({ ...listed, results: listed.results.map(shape) });
    }
    const search = /^\/crm\/v3\/objects\/(\w+)\/search$/.exec(path);
    if (search && method === "POST") {
      if (portal.forbidden.includes(search[1])) return json({ status: "error", category: "MISSING_SCOPES" }, 403);
      const body = JSON.parse(String(init?.body ?? "{}")) as SearchBody;
      const rows = (portal.objects[search[1]] ?? []).filter((r) => !body.filterGroups?.length || body.filterGroups.some((g) => g.filters.every((f) => passes(r, f))));
      const sort = body.sorts?.[0];
      if (sort) rows.sort((a, b) => (searchValue(a, sort.propertyName) - searchValue(b, sort.propertyName)) * (sort.direction === "DESCENDING" ? -1 : 1));
      const limit = Math.min(body.limit ?? 10, 200);
      const start = Number(body.after ?? 0);
      // HubSpot's search pages by offset and refuses one past 10,000 results.
      if (start + limit > 10_000) return json({ status: "error", message: "Search results are capped at 10,000" }, 400);
      return json({ total: rows.length, // Like the list endpoint, search never returns history the request did not ask for.
      results: rows.slice(start, start + limit).map(({ propertiesWithHistory: _history, ...row }) => row), ...(start + limit < rows.length ? { paging: { next: { after: String(start + limit) } } } : {}) });
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
  });
}
