// Simulated org metadata: standard objects with realistic field lists, any
// number of custom objects, and a deterministic seed.
import { makeId, prng, sfDateTime } from "./util.ts";

/** Same shape as the record-service ObjectDef (contract 1.2.0). */
export type ObjectDef = {
  name: string;
  label: string;
  fields: Array<{ name: string; type: "string" | "number" | "boolean" | "date" | "datetime" | "picklist" | "reference" | "json"; referenceTo?: string[] }>;
};

export type SfField = {
  name: string;
  label: string;
  type: string; // Salesforce field type: id, string, textarea, url, email, phone, picklist, boolean, int, double, currency, date, datetime, reference, address
  updateable: boolean;
  createable: boolean;
  nillable: boolean;
  custom: boolean;
  calculated: boolean;
  externalId: boolean;
  length: number;
  referenceTo: string[];
  relationshipName: string | null;
  picklistValues: Array<{ value: string; label: string; active: boolean; defaultValue: boolean }>;
};

export type SfObject = {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  fields: SfField[];
};

type F = [name: string, type: string, opts?: { ro?: boolean; ref?: string[]; pick?: string[]; custom?: boolean; ext?: boolean }];

const field = ([name, type, o = {}]: F): SfField => ({
  name,
  label: name.replace(/__c$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/Id$/, " ID").trim(),
  type,
  updateable: !o.ro && type !== "id" && type !== "address",
  createable: !o.ro && type !== "id" && type !== "address",
  nillable: !["id", "boolean"].includes(type) && name !== "Name" && name !== "LastName",
  custom: o.custom ?? name.endsWith("__c"),
  calculated: false,
  externalId: o.ext ?? false,
  length: ["string", "url", "email", "phone", "picklist"].includes(type) ? 255 : type === "textarea" ? 32000 : 0,
  referenceTo: o.ref ?? [],
  relationshipName: type === "reference" ? name.replace(/Id$/, "").replace(/__c$/, "__r") : null,
  picklistValues: (o.pick ?? []).map((v, i) => ({ value: v, label: v, active: true, defaultValue: i === 0 && false })),
});

const SYSTEM: F[] = [
  ["Id", "id", { ro: true }],
  ["IsDeleted", "boolean", { ro: true }],
  ["CreatedDate", "datetime", { ro: true }],
  ["CreatedById", "reference", { ro: true, ref: ["User"] }],
  ["LastModifiedDate", "datetime", { ro: true }],
  ["LastModifiedById", "reference", { ro: true, ref: ["User"] }],
  ["SystemModstamp", "datetime", { ro: true }],
];
const OWNER: F = ["OwnerId", "reference", { ref: ["User", "Group"] }];

export const INDUSTRIES = ["Technology", "Finance", "Healthcare", "Manufacturing", "Retail", "Education", "Energy", "Media"];
/** OpportunityContactRole.Role values: Salesforce's standard picklist plus a common custom Champion. */
export const ROLES = ["Business User", "Decision Maker", "Economic Buyer", "Economic Decision Maker", "Evaluator", "Executive Sponsor", "Influencer", "Technical Buyer", "Champion", "Other"];
const COUNTRIES = ["United States", "United Kingdom", "Germany", "Canada", "France", "Australia"];

const STANDARD: Record<string, { label: string; prefix: string; fields: F[] }> = {
  Account: {
    label: "Account", prefix: "001",
    fields: [...SYSTEM, ["MasterRecordId", "reference", { ro: true, ref: ["Account"] }], ["Name", "string"], ["Type", "picklist", { pick: ["Prospect", "Customer - Direct", "Partner"] }],
      ["ParentId", "reference", { ref: ["Account"] }], ["BillingStreet", "textarea"], ["BillingCity", "string"], ["BillingState", "string"], ["BillingPostalCode", "string"],
      ["BillingCountry", "string"], ["BillingAddress", "address", { ro: true }], ["Phone", "phone"], ["Website", "url"], ["Industry", "picklist", { pick: INDUSTRIES }],
      ["AnnualRevenue", "currency"], ["NumberOfEmployees", "int"], ["Description", "textarea"], ["Rating", "picklist", { pick: ["Hot", "Warm", "Cold"] }],
      ["AccountSource", "picklist", { pick: ["Web", "Phone Inquiry", "Partner Referral", "Other"] }], ["LastActivityDate", "date", { ro: true }], OWNER],
  },
  Contact: {
    label: "Contact", prefix: "003",
    fields: [...SYSTEM, ["AccountId", "reference", { ref: ["Account"] }], ["FirstName", "string"], ["LastName", "string"], ["Name", "string", { ro: true }],
      ["Salutation", "picklist", { pick: ["Mr.", "Ms.", "Dr."] }], ["Title", "string"], ["Department", "string"], ["Email", "email"], ["Phone", "phone"],
      ["MobilePhone", "phone"], ["MailingCity", "string"], ["MailingCountry", "string"], ["LeadSource", "picklist", { pick: ["Web", "Phone Inquiry", "Partner Referral", "Other"] }],
      ["Description", "textarea"], ["HasOptedOutOfEmail", "boolean"], ["LastActivityDate", "date", { ro: true }], OWNER],
  },
  Lead: {
    label: "Lead", prefix: "00Q",
    fields: [...SYSTEM, ["FirstName", "string"], ["LastName", "string"], ["Name", "string", { ro: true }], ["Company", "string"], ["Title", "string"], ["Email", "email"],
      ["Phone", "phone"], ["Website", "url"], ["Industry", "picklist", { pick: INDUSTRIES }], ["NumberOfEmployees", "int"], ["Country", "string"],
      ["Status", "picklist", { pick: ["Open - Not Contacted", "Working - Contacted", "Closed - Converted", "Closed - Not Converted"] }],
      ["LeadSource", "picklist", { pick: ["Web", "Phone Inquiry", "Partner Referral", "Other"] }], ["IsConverted", "boolean", { ro: true }],
      ["ConvertedAccountId", "reference", { ro: true, ref: ["Account"] }], ["ConvertedContactId", "reference", { ro: true, ref: ["Contact"] }], ["Description", "textarea"], OWNER],
  },
  Opportunity: {
    label: "Opportunity", prefix: "006",
    fields: [...SYSTEM, ["AccountId", "reference", { ref: ["Account"] }], ["Name", "string"], ["StageName", "picklist", { pick: ["Prospecting", "Qualification", "Proposal", "Closed Won", "Closed Lost"] }],
      ["Amount", "currency"], ["Probability", "percent"], ["CloseDate", "date"], ["Type", "picklist", { pick: ["New Business", "Existing Business", "Renewal"] }], ["NextStep", "string"],
      ["IsClosed", "boolean", { ro: true }], ["IsWon", "boolean", { ro: true }], ["ForecastCategoryName", "picklist", { pick: ["Omitted", "Pipeline", "Best Case", "Commit", "Closed"] }],
      ["RecordTypeId", "reference", { ref: ["RecordType"] }], ["CurrencyIsoCode", "picklist", { pick: ["USD", "EUR", "GBP"] }],
      ["Description", "textarea"], OWNER,
      ["Region__c", "picklist", { pick: ["AMER", "EMEA", "APAC"] }], ["Seats__c", "double"], ["Contract_Value__c", "currency"], ["Renewal_Date__c", "date"],
      ["Strategic__c", "boolean"], ["Competitor__c", "string"]],
  },
  OpportunityHistory: {
    label: "Opportunity History", prefix: "008",
    fields: [...SYSTEM, ["OpportunityId", "reference", { ref: ["Opportunity"] }], ["StageName", "picklist"], ["Amount", "currency"], ["CloseDate", "date"],
      ["Probability", "percent"], ["ForecastCategory", "picklist", { pick: ["Omitted", "Pipeline", "BestCase", "Commit", "Closed"] }]],
  },
  OpportunityFieldHistory: {
    label: "Opportunity Field History", prefix: "017",
    fields: [...SYSTEM, ["OpportunityId", "reference", { ref: ["Opportunity"] }], ["Field", "string"], ["DataType", "string"], ["OldValue", "string"], ["NewValue", "string"]],
  },
  User: {
    label: "User", prefix: "005",
    fields: [...SYSTEM, ["Username", "string"], ["FirstName", "string"], ["LastName", "string"], ["Name", "string", { ro: true }], ["Email", "email"], ["IsActive", "boolean"],
      ["Title", "string"], ["UserRoleId", "reference", { ref: ["UserRole"] }], ["ProfileId", "reference", { ref: ["Profile"] }]],
  },
  Task: {
    label: "Task", prefix: "00T",
    fields: [...SYSTEM, ["WhoId", "reference", { ref: ["Contact", "Lead"] }], ["WhatId", "reference", { ref: ["Account", "Opportunity"] }], ["Subject", "string"], ["ActivityDate", "date"],
      ["Status", "picklist", { pick: ["Not Started", "In Progress", "Completed", "Waiting on someone else", "Deferred"] }], ["Priority", "picklist", { pick: ["High", "Normal", "Low"] }],
      ["TaskSubtype", "picklist", { pick: ["Task", "Call", "Email"] }], ["CallType", "picklist", { pick: ["Inbound", "Outbound", "Internal"] }], ["CallDurationInSeconds", "int"],
      ["CallDisposition", "string"], ["Description", "textarea"], OWNER],
  },
  Event: {
    label: "Event", prefix: "00U",
    fields: [...SYSTEM, ["WhoId", "reference", { ref: ["Contact", "Lead"] }], ["WhatId", "reference", { ref: ["Account", "Opportunity"] }], ["Subject", "string"],
      ["StartDateTime", "datetime"], ["EndDateTime", "datetime"], ["Location", "string"], ["Description", "textarea"], OWNER],
  },
  Note: { label: "Note", prefix: "002", fields: [...SYSTEM, ["ParentId", "reference", { ref: ["Account", "Contact", "Opportunity"] }], ["Title", "string"], ["Body", "textarea"], OWNER] },
  ContentDocument: {
    label: "Content Document", prefix: "069",
    fields: [...SYSTEM, ["Title", "string"], ["FileType", "string"], ["FileExtension", "string"], ["ContentSize", "int"], OWNER],
  },
  ContentNote: { label: "Note", prefix: "069", fields: [...SYSTEM, ["Title", "string"], ["TextPreview", "string"], ["Content", "base64"], OWNER] },
  ContentDocumentLink: {
    label: "Content Document Link", prefix: "06A",
    fields: [...SYSTEM, ["ContentDocumentId", "reference", { ref: ["ContentDocument"] }], ["LinkedEntityId", "reference", { ref: ["Account", "Contact", "Opportunity", "User"] }], ["ShareType", "string"]],
  },

  Campaign: { label: "Campaign", prefix: "701", fields: [...SYSTEM, ["Name", "string"], ["Status", "picklist", { pick: ["Planned", "In Progress", "Completed"] }], ["StartDate", "date"], OWNER] },
  Case: { label: "Case", prefix: "500", fields: [...SYSTEM, ["AccountId", "reference", { ref: ["Account"] }], ["Subject", "string"], ["Status", "picklist", { pick: ["New", "Working", "Closed"] }], OWNER] },
  UserRole: { label: "Role", prefix: "00E", fields: [...SYSTEM, ["Name", "string"], ["ParentRoleId", "reference", { ref: ["UserRole"] }]] },
  Profile: { label: "Profile", prefix: "00e", fields: [...SYSTEM, ["Name", "string"]] },
  RecordType: {
    label: "Record Type", prefix: "012",
    fields: [...SYSTEM, ["Name", "string"], ["DeveloperName", "string"], ["SobjectType", "picklist", { pick: ["Account", "Contact", "Opportunity"] }], ["IsActive", "boolean"],
      ["BusinessProcessId", "reference", { ref: ["BusinessProcess"] }]],
  },
  BusinessProcess: { label: "Business Process", prefix: "019", fields: [...SYSTEM, ["Name", "string"], ["TableEnumOrId", "string"], ["IsActive", "boolean"]] },
  OpportunityStage: {
    label: "Opportunity Stage", prefix: "01J",
    fields: [...SYSTEM, ["MasterLabel", "string"], ["ApiName", "string"], ["IsActive", "boolean"], ["IsClosed", "boolean"], ["IsWon", "boolean"],
      ["ForecastCategoryName", "picklist", { pick: ["Omitted", "Pipeline", "Best Case", "Commit", "Closed"] }], ["DefaultProbability", "percent"], ["SortOrder", "int"]],
  },
  OpportunityContactRole: {
    label: "Opportunity Contact Role", prefix: "00K",
    fields: [...SYSTEM, ["OpportunityId", "reference", { ref: ["Opportunity"] }], ["ContactId", "reference", { ref: ["Contact"] }],
      ["Role", "picklist", { pick: ROLES }], ["IsPrimary", "boolean"]],
  },
};

/** Non-queryable entities that describeGlobal lists (as a real org does). */
const NON_QUERYABLE = ["AccountChangeEvent", "ContactChangeEvent", "LeadChangeEvent", "OpportunityChangeEvent"];

const TYPE_MAP: Record<ObjectDef["fields"][number]["type"], string> = {
  string: "string", number: "double", boolean: "boolean", date: "date", datetime: "datetime", picklist: "picklist", reference: "reference", json: "textarea",
};

export function buildSchema(customObjects: ObjectDef[]): Map<string, SfObject> {
  const out = new Map<string, SfObject>();
  for (const [name, s] of Object.entries(STANDARD)) {
    out.set(name, {
      name, label: s.label, labelPlural: `${s.label}s`, keyPrefix: s.prefix, custom: false, queryable: true,
      createable: name !== "User", updateable: true, deletable: name !== "User", fields: s.fields.map(field),
    });
  }
  for (const name of NON_QUERYABLE) {
    out.set(name, { name, label: name, labelPlural: name, keyPrefix: null, custom: false, queryable: false, createable: false, updateable: false, deletable: false, fields: [] });
  }
  customObjects.forEach((o, k) => {
    const fields: F[] = [...SYSTEM, ["Name", "string"], OWNER];
    for (const f of o.fields) {
      if (fields.some(([n]) => n === f.name)) continue;
      fields.push([f.name, TYPE_MAP[f.type], { custom: true, ref: f.referenceTo, ...(f.type === "picklist" ? { pick: ["Alpha", "Beta", "Gamma"] } : {}) }]);
    }
    out.set(o.name, {
      name: o.name, label: o.label, labelPlural: `${o.label}s`, keyPrefix: `a0${"0123456789ABCDEFGHIJ"[k % 20]}`, custom: true, queryable: true,
      createable: true, updateable: true, deletable: true, fields: fields.map(field),
    });
  });
  return out;
}

export type SeedOptions = {
  seed: number;
  accounts: number;
  contacts: number;
  leads: number;
  opportunities: number;
  users: number;
  customRecords: number;
  /** Emails for the first users, in order (the rest keep sim.user<i>@sim.example). */
  userEmails?: string[];
};

type Stage = { name: string; probability: number; forecast: string; closed: boolean; won: boolean };
const STAGES: Stage[] = [
  { name: "Prospecting", probability: 10, forecast: "Pipeline", closed: false, won: false },
  { name: "Qualification", probability: 20, forecast: "Pipeline", closed: false, won: false },
  { name: "Proposal", probability: 50, forecast: "Best Case", closed: false, won: false },
  { name: "Negotiation", probability: 75, forecast: "Commit", closed: false, won: false },
  { name: "Closed Won", probability: 100, forecast: "Closed", closed: true, won: true },
  { name: "Closed Lost", probability: 0, forecast: "Omitted", closed: true, won: false },
  { name: "Renewal Review", probability: 40, forecast: "Pipeline", closed: false, won: false },
  { name: "Renewal Signed", probability: 100, forecast: "Closed", closed: true, won: true },
  { name: "Renewal Lost", probability: 0, forecast: "Omitted", closed: true, won: false },
];

/**
 * Two Opportunity sales processes, each behind one record type. They share
 * Prospecting and Negotiation, as real orgs' processes often do.
 */
export const SALES_PROCESSES = [
  {
    recordTypeId: makeId("012", 1), developerName: "New_Business", recordTypeName: "New Business", name: "New Business", processId: makeId("019", 0),
    stages: ["Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"],
  },
  {
    recordTypeId: makeId("012", 2), developerName: "Renewal", recordTypeName: "Renewal", name: "Renewals", processId: makeId("019", 1),
    stages: ["Prospecting", "Renewal Review", "Negotiation", "Renewal Signed", "Renewal Lost"],
  },
];

/** Deterministic records for every queryable object. */
export function seedRecords(schema: Map<string, SfObject>, o: SeedOptions, now: number): Map<string, Map<string, Record<string, unknown>>> {
  const rnd = prng(o.seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  for (const name of schema.keys()) if (schema.get(name)!.queryable) data.set(name, new Map());
  const base = now - 400 * 86_400_000;
  const sys = (obj: string, n: number, owner?: string) => {
    const created = base + Math.floor(rnd() * 300 * 86_400_000);
    const modified = created + Math.floor(rnd() * 60 * 86_400_000);
    return {
      Id: makeId(schema.get(obj)!.keyPrefix!, n), IsDeleted: false, CreatedDate: sfDateTime(created), LastModifiedDate: sfDateTime(modified),
      SystemModstamp: sfDateTime(modified), CreatedById: users[0] ?? null, LastModifiedById: users[0] ?? null, ...(owner !== undefined ? { OwnerId: owner } : {}),
    };
  };
  const users: string[] = [];
  for (let i = 0; i < o.users; i++) {
    const id = makeId("005", i);
    users.push(id);
  }
  for (let i = 0; i < o.users; i++) {
    const email = o.userEmails?.[i] ?? `sim.user${i}@sim.example`;
    const r = { ...sys("User", i), Username: `sim.user${i}@sim.example`, FirstName: "Sim", LastName: `User ${i}`, Name: `Sim User ${i}`, Email: email, IsActive: true, Title: "AE" };
    data.get("User")!.set(r.Id, r);
  }
  const accountIds: string[] = [];
  for (let i = 0; i < o.accounts; i++) {
    // ~3% of accounts have no website; ~1% reuse an earlier account's website (duplicate domain).
    const roll = rnd();
    const website = roll < 0.03 ? null : roll < 0.04 && i > 0 ? `https://www.sim${Math.floor(rnd() * i)}.example.com` : `https://www.sim${i}.example.com`;
    const r = {
      ...sys("Account", i, pick(users)), Name: `Sim Account ${i}`, Website: website, Industry: pick(INDUSTRIES), NumberOfEmployees: 5 + Math.floor(rnd() * 20000),
      BillingCountry: pick(COUNTRIES), BillingCity: "Springfield", AnnualRevenue: Math.floor(rnd() * 1e8), Phone: `+1 555 ${String(i).padStart(7, "0")}`,
      Type: pick(["Prospect", "Customer - Direct", "Partner"]), Rating: pick(["Hot", "Warm", "Cold"]), Description: null, ParentId: null,
    };
    data.get("Account")!.set(r.Id, r);
    accountIds.push(r.Id);
  }
  for (let i = 0; i < o.contacts; i++) {
    const k = accountIds.length ? Math.floor(rnd() * accountIds.length) : -1;
    const acct = k >= 0 ? accountIds[k] : null;
    const first = pick(["Ada", "Grace", "Alan", "Linus", "Barbara", "Ken", "Margaret", "Dennis"]);
    const last = `Sim${i}`;
    const r = {
      ...sys("Contact", i, pick(users)), AccountId: acct, FirstName: first, LastName: last, Name: `${first} ${last}`,
      Email: rnd() < 0.02 ? null : `${first.toLowerCase()}.${last.toLowerCase()}@sim${Math.max(k, 0)}.example.com`,
      Title: pick(["VP Sales", "CTO", "RevOps Manager", "SDR", "CFO", "Head of Marketing"]), Phone: null, MailingCountry: pick(COUNTRIES),
      LeadSource: pick(["Web", "Other"]), HasOptedOutOfEmail: rnd() < 0.1, Department: null, Description: null,
    };
    data.get("Contact")!.set(r.Id, r);
  }
  for (let i = 0; i < o.leads; i++) {
    const r = {
      ...sys("Lead", i, pick(users)), FirstName: "Lead", LastName: `Sim${i}`, Name: `Lead Sim${i}`, Company: `Lead Co ${i}`, Email: `lead${i}@leadco${i}.example.com`,
      Website: `leadco${i}.example.com`, Industry: pick(INDUSTRIES), Status: "Open - Not Contacted", LeadSource: "Web", IsConverted: false, Title: "Manager",
    };
    data.get("Lead")!.set(r.Id, r);
  }
  for (let i = 0; i < o.opportunities; i++) {
    const r = {
      ...sys("Opportunity", i, pick(users)), AccountId: accountIds.length ? pick(accountIds) : null, Name: `Sim Opp ${i}`, StageName: pick(["Prospecting", "Proposal", "Closed Won"]),
      Amount: Math.floor(rnd() * 200000), CloseDate: sfDateTime(now + Math.floor(rnd() * 90) * 86_400_000).slice(0, 10), IsClosed: false, IsWon: false,
    };
    data.get("Opportunity")!.set(r.Id, r);
  }
  for (const obj of schema.values()) {
    if (!obj.custom) continue;
    for (let i = 0; i < o.customRecords; i++) {
      const r: Record<string, unknown> = { ...sys(obj.name, i, pick(users)), Name: `${obj.label} ${i}` };
      for (const f of obj.fields) {
        if (!f.custom) continue;
        r[f.name] = f.type === "double" ? Math.round(rnd() * 10000) / 100
          : f.type === "boolean" ? rnd() < 0.5
          : f.type === "date" ? sfDateTime(base + Math.floor(rnd() * 400) * 86_400_000).slice(0, 10)
          : f.type === "datetime" ? sfDateTime(base + Math.floor(rnd() * 400) * 86_400_000)
          : f.type === "picklist" ? pick(["Alpha", "Beta", "Gamma"])
          : f.type === "reference" ? (f.referenceTo.includes("Account") && accountIds.length ? pick(accountIds) : null)
          : `${f.name} value ${i}`;
      }
      data.get(obj.name)!.set(String(r.Id), r);
    }
  }
  seedSalesProcesses(data, o.seed, users, now);
  seedActivities(data, o.seed, users, now);
  seedOpportunityHistory(data, o.seed, users);
  return data;
}

/**
 * Custom field values and history for each opportunity, from their own PRNG:
 * OpportunityHistory walks it through the stages of its process up to its
 * current one, and OpportunityFieldHistory records a NextStep and a Seats__c
 * change. Every history row predates the opportunity's SystemModstamp, as in
 * a real org, so the current values are the newest.
 */
function seedOpportunityHistory(data: Map<string, Map<string, Record<string, unknown>>>, seed: number, users: string[]) {
  const rnd = prng(seed ^ 0x415d);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const ms = (v: unknown) => Date.parse(String(v).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  let h = 0;
  let f = 0;
  for (const opp of data.get("Opportunity")!.values()) {
    Object.assign(opp, {
      Region__c: pick(["AMER", "EMEA", "APAC"]), Seats__c: 5 + Math.floor(rnd() * 200), Contract_Value__c: Math.floor(rnd() * 50_000_000) / 100,
      Renewal_Date__c: rnd() < 0.7 ? sfDateTime(ms(opp.CreatedDate) + 365 * 86_400_000).slice(0, 10) : null, Strategic__c: rnd() < 0.3,
      Competitor__c: rnd() < 0.5 ? pick(["Salesforce", "HubSpot", "Pipedrive"]) : null,
    });
    const process = SALES_PROCESSES.find((p) => p.recordTypeId === opp.RecordTypeId) ?? SALES_PROCESSES[0];
    const current = Math.max(0, process.stages.indexOf(String(opp.StageName)));
    const start = Math.floor(rnd() * (current + 1));
    const from = ms(opp.CreatedDate);
    const to = ms(opp.SystemModstamp) - 60_000;
    const steps = process.stages.slice(start, current + 1);
    steps.forEach((name, k) => {
      const stage = STAGES.find((s) => s.name === name)!;
      const at = from + Math.floor(((k + 1) / (steps.length + 1)) * (to - from));
      const Id = makeId("008", h++);
      const last = k === steps.length - 1;
      data.get("OpportunityHistory")!.set(Id, {
        Id, IsDeleted: false, CreatedDate: sfDateTime(at), CreatedById: users[0] ?? null, LastModifiedDate: sfDateTime(at), SystemModstamp: sfDateTime(at), OpportunityId: opp.Id,
        StageName: name, Amount: last ? opp.Amount : Math.round(Number(opp.Amount) * 0.8), CloseDate: opp.CloseDate, Probability: stage.probability,
        ForecastCategory: stage.forecast === "Best Case" ? "BestCase" : stage.forecast,
      });
    });
    const at = from + Math.floor(0.5 * (to - from));
    const fieldRow = (Field: string, DataType: string, OldValue: unknown, NewValue: unknown) => {
      const Id = makeId("017", f++);
      data.get("OpportunityFieldHistory")!.set(Id, {
        Id, IsDeleted: false, CreatedDate: sfDateTime(at), CreatedById: users[0] ?? null, LastModifiedDate: sfDateTime(at), SystemModstamp: sfDateTime(at),
        OpportunityId: opp.Id, Field, DataType, OldValue, NewValue,
      });
    };
    if (rnd() < 0.5) {
      fieldRow("NextStep", "Text", null, "Send the order form");
      opp.NextStep = "Send the order form";
    }
    if (rnd() < 0.5) fieldRow("Seats__c", "Double", Math.max(1, Number(opp.Seats__c) - 10), opp.Seats__c);
  }
}

/**
 * Tasks, calls, events, notes and files on the seeded opportunities and
 * their people, from their own PRNG. Each opportunity with people gets a
 * few; files are linked to the opportunity and its account.
 */
function seedActivities(data: Map<string, Map<string, Record<string, unknown>>>, seed: number, users: string[], now: number) {
  const rnd = prng(seed ^ 0xac71);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const counters: Record<string, number> = {};
  const add = (object: string, prefix: string, fields: Record<string, unknown>) => {
    const n = (counters[prefix] = (counters[prefix] ?? 0) + 1);
    const created = now - Math.floor(rnd() * 300) * 86_400_000;
    const Id = makeId(prefix, n);
    const row = { Id, IsDeleted: false, CreatedDate: sfDateTime(created), LastModifiedDate: sfDateTime(created), SystemModstamp: sfDateTime(created), CreatedById: users[0] ?? null, LastModifiedById: users[0] ?? null, OwnerId: pick(users), ...fields };
    data.get(object)!.set(Id, row);
    return row;
  };
  const rolesByOpp = new Map<string, string[]>();
  for (const r of data.get("OpportunityContactRole")!.values()) rolesByOpp.set(String(r.OpportunityId), [...(rolesByOpp.get(String(r.OpportunityId)) ?? []), String(r.ContactId)]);
  for (const opp of data.get("Opportunity")!.values()) {
    const people = rolesByOpp.get(String(opp.Id)) ?? [];
    if (!people.length || rnd() < 0.3) continue;
    const day = (offset: number) => sfDateTime(now + offset * 86_400_000).slice(0, 10);
    add("Task", "00T", {
      WhoId: pick(people), WhatId: opp.Id, Subject: pick(["Send proposal", "Follow up on pricing", "Book security review"]), ActivityDate: day(Math.floor(rnd() * 30) - 10),
      Status: pick(["Not Started", "In Progress", "Completed", "Waiting on someone else", "Deferred"]), Priority: pick(["High", "Normal", "Low"]), TaskSubtype: "Task",
      Description: rnd() < 0.5 ? "Asked for the security questionnaire." : null,
    });
    if (rnd() < 0.6) {
      add("Task", "00T", {
        WhoId: pick(people), WhatId: opp.Id, Subject: "Call", ActivityDate: day(-Math.floor(rnd() * 60)), Status: "Completed", Priority: "Normal", TaskSubtype: "Call",
        CallType: pick(["Inbound", "Outbound"]), CallDurationInSeconds: 60 + Math.floor(rnd() * 1800), CallDisposition: pick(["Connected", "Left voicemail", "No answer"]),
        Description: "Discussed the rollout timeline.",
      });
    }
    if (rnd() < 0.5) {
      const start = now + (Math.floor(rnd() * 40) - 20) * 86_400_000;
      add("Event", "00U", {
        WhoId: pick(people), WhatId: opp.Id, Subject: pick(["Discovery call", "Demo", "Pricing review"]), StartDateTime: sfDateTime(start), EndDateTime: sfDateTime(start + 1_800_000),
        Location: rnd() < 0.5 ? "Zoom" : null, Description: rnd() < 0.5 ? "Agenda: goals, timeline, next steps." : null,
      });
    }
    if (rnd() < 0.4) {
      const title = pick(["Call notes", "Champion map", "Objections"]);
      const body = `${title}: they want SSO before signing.`;
      const doc = add("ContentDocument", "069", { Title: title, FileType: "SNOTE", FileExtension: "snote", ContentSize: body.length });
      data.get("ContentNote")!.set(String(doc.Id), { ...doc, TextPreview: body.slice(0, 255), Content: Buffer.from(`<p>${body}</p>`).toString("base64") });
      add("ContentDocumentLink", "06A", { ContentDocumentId: doc.Id, LinkedEntityId: opp.Id, ShareType: "V", OwnerId: undefined });
    }
    if (rnd() < 0.3) {
      const doc = add("ContentDocument", "069", { Title: pick(["Order form", "Security questionnaire", "Pricing"]), FileType: "PDF", FileExtension: "pdf", ContentSize: 10_000 + Math.floor(rnd() * 900_000) });
      add("ContentDocumentLink", "06A", { ContentDocumentId: doc.Id, LinkedEntityId: opp.Id, ShareType: "V", OwnerId: undefined });
      if (opp.AccountId) add("ContentDocumentLink", "06A", { ContentDocumentId: doc.Id, LinkedEntityId: opp.AccountId, ShareType: "V", OwnerId: undefined });
    }
    if (rnd() < 0.2 && opp.AccountId) add("Note", "002", { ParentId: opp.AccountId, Title: "Account note", Body: "Renewal owner changed in Q2." });
  }
}

/**
 * Record types, sales processes, stages and contact roles, from their own
 * PRNG so the records seeded above stay as they were. Every opportunity gets
 * a record type and a stage of its process, with Salesforce's derived fields
 * (IsClosed, IsWon, Probability, ForecastCategoryName) consistent with it.
 */
function seedSalesProcesses(data: Map<string, Map<string, Record<string, unknown>>>, seed: number, users: string[], now: number) {
  const rnd = prng(seed ^ 0x0c11);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const created = sfDateTime(now - 500 * 86_400_000);
  const system = (Id: string) => ({
    Id, IsDeleted: false, CreatedDate: created, LastModifiedDate: created, SystemModstamp: created, CreatedById: users[0] ?? null, LastModifiedById: users[0] ?? null,
  });
  STAGES.forEach((s, i) => {
    const Id = makeId("01J", i);
    data.get("OpportunityStage")!.set(Id, {
      ...system(Id), MasterLabel: s.name, ApiName: s.name, IsActive: true, IsClosed: s.closed, IsWon: s.won, ForecastCategoryName: s.forecast,
      DefaultProbability: s.probability, SortOrder: i + 1,
    });
  });
  for (const p of SALES_PROCESSES) {
    data.get("BusinessProcess")!.set(p.processId, { ...system(p.processId), Name: p.name, TableEnumOrId: "Opportunity", IsActive: true });
    data.get("RecordType")!.set(p.recordTypeId, {
      ...system(p.recordTypeId), Name: p.recordTypeName, DeveloperName: p.developerName, SobjectType: "Opportunity", IsActive: true, BusinessProcessId: p.processId,
    });
  }
  const contactsByAccount = new Map<string, string[]>();
  for (const c of data.get("Contact")!.values()) {
    if (c.AccountId) contactsByAccount.set(String(c.AccountId), [...(contactsByAccount.get(String(c.AccountId)) ?? []), String(c.Id)]);
  }
  const roles = ["Decision Maker", "Economic Buyer", "Champion", "Technical Buyer", "Evaluator", "Influencer", "Business User", "Executive Sponsor", "Other"];
  let roleN = 0;
  for (const opp of data.get("Opportunity")!.values()) {
    const process = rnd() < 0.6 ? SALES_PROCESSES[0] : SALES_PROCESSES[1];
    const stageName = pick(process.stages);
    const stage = STAGES.find((s) => s.name === stageName)!;
    Object.assign(opp, {
      RecordTypeId: process.recordTypeId, StageName: stage.name, IsClosed: stage.closed, IsWon: stage.won, Probability: stage.probability,
      ForecastCategoryName: stage.forecast, CurrencyIsoCode: rnd() < 0.8 ? "USD" : pick(["EUR", "GBP"]),
      Type: process === SALES_PROCESSES[1] ? "Renewal" : pick(["New Business", "Existing Business"]),
    });
    const people = contactsByAccount.get(String(opp.AccountId ?? "")) ?? [];
    const count = Math.min(people.length, Math.floor(rnd() * 4));
    for (let k = 0; k < count; k++) {
      const Id = makeId("00K", roleN++);
      // About one opportunity in five with two people names both of them Decision Makers.
      const role = k === 1 && rnd() < 0.2 ? "Decision Maker" : pick(roles);
      data.get("OpportunityContactRole")!.set(Id, { ...system(Id), OpportunityId: opp.Id, ContactId: people[k], Role: role, IsPrimary: k === 0 });
    }
  }
}
