#!/usr/bin/env node

type ScoutRow = Record<string, string>;

type SyncOptions = {
  input: string;
  live: boolean;
  allowMissingContacts: boolean;
  output?: string;
};

type HubSpotCompanyPayload = {
  idProperty: "domain";
  id: string;
  properties: Record<string, string>;
};

type HubSpotContactPayload = {
  idProperty: "email";
  id: string;
  companyDomain: string;
  properties: Record<string, string>;
};

type SyncPlan = {
  mode: "dry-run" | "live";
  sourceFile: string;
  proposedProperties: ProposedProperty[];
  lifecycleGuidance: string[];
  summary: {
    companiesRead: number;
    companiesPlanned: number;
    contactsPlanned: number;
    contactsReviewOnly: number;
    liveWritesAttempted: boolean;
  };
  companies: HubSpotCompanyPayload[];
  contacts: HubSpotContactPayload[];
  reviewOnlyPeople: Array<Record<string, string>>;
  warnings: string[];
};

type ProposedProperty = {
  object: "company" | "contact";
  name: string;
  label: string;
  type: "string" | "number" | "enumeration" | "date";
  purpose: string;
  options?: string[];
};

const DEFAULT_INPUT = "/home/ubuntu/.pi/agent/gtm-agent-hud/icp-scout/scored_companies.csv";
const HS_API_URL = "https://api.hubapi.com";

const proposedProperties: ProposedProperty[] = [
  { object: "company", name: "fsgtm_icp_score", label: "FSGTM ICP Score", type: "number", purpose: "Numeric ICP Scout fit score." },
  { object: "company", name: "fsgtm_fit_status", label: "FSGTM Fit Status", type: "enumeration", options: ["high_fit", "medium_fit", "low_fit", "reject", "needs_review"], purpose: "Reviewable account-fit disposition from ICP Scout." },
  { object: "company", name: "fsgtm_icp_source", label: "FSGTM ICP Source", type: "string", purpose: "Source system/run marker; default icp_scout." },
  { object: "company", name: "fsgtm_icp_review_url", label: "FSGTM ICP Review URL", type: "string", purpose: "Link/path to Slack-ready review artifact." },
  { object: "company", name: "fsgtm_icp_evidence_url", label: "FSGTM ICP Evidence URL", type: "string", purpose: "Link/path to detailed evidence artifact." },
  { object: "company", name: "fsgtm_company_profile", label: "FSGTM Company Profile", type: "string", purpose: "Researched summary of what the company does, market, stage, and product motion." },
  { object: "company", name: "fsgtm_category", label: "FSGTM Category", type: "string", purpose: "Prospect category / ICP lane, e.g. vertical workflow SaaS." },
  { object: "company", name: "fsgtm_employee_range", label: "FSGTM Employee Range", type: "string", purpose: "Researched employee-size signal and source wording." },
  { object: "company", name: "fsgtm_funding_stage", label: "FSGTM Funding Stage", type: "string", purpose: "Researched funding/maturity signal." },
  { object: "company", name: "fsgtm_guardrail_status", label: "FSGTM Guardrail Status", type: "string", purpose: "Explicit ICP guardrail pass/fail summary." },
  { object: "company", name: "fsgtm_product_motion", label: "FSGTM Product / GTM Motion", type: "string", purpose: "Product scope, sales motion, customer lifecycle, and implementation complexity." },
  { object: "company", name: "fsgtm_public_signals", label: "FSGTM Public Signals", type: "string", purpose: "Concise source-backed evidence from website, jobs, LinkedIn, funding, and customer stories." },
  { object: "company", name: "fsgtm_pain_hypotheses", label: "FSGTM Pain Hypotheses", type: "string", purpose: "Short newline/semicolon-delimited pain hypotheses for account review." },
  { object: "company", name: "fsgtm_decision_maker_roles", label: "FSGTM Decision-Maker Roles", type: "string", purpose: "Likely buyer/champion/economic-buyer role map." },
  { object: "company", name: "fsgtm_why_now", label: "FSGTM Why Now", type: "string", purpose: "Urgency/trigger evidence such as funding, hiring, leadership, launch, or expansion." },
  { object: "company", name: "fsgtm_wedge", label: "FSGTM Suggested Wedge", type: "string", purpose: "Specific consulting/project wedge recommended by ICP Scout." },
  { object: "company", name: "fsgtm_counterarguments", label: "FSGTM Counterarguments", type: "string", purpose: "Primary reasons the account may be a bad fit or should be handled carefully." },
  { object: "company", name: "fsgtm_source_urls", label: "FSGTM Source URLs", type: "string", purpose: "Public URLs used for the researched account record." },
  { object: "company", name: "fsgtm_icp_last_scored_at", label: "FSGTM ICP Last Scored At", type: "date", purpose: "Date from ICP Scout scored_companies artifact." },
  { object: "contact", name: "fsgtm_persona_role", label: "FSGTM Persona Role", type: "string", purpose: "Decision-maker/champion role archetype for the person." },
  { object: "contact", name: "fsgtm_icp_person_source", label: "FSGTM ICP Person Source", type: "string", purpose: "Source/review artifact path for person hypothesis." },
];

const lifecycleGuidance = [
  "Create/update HubSpot Companies only as target-account review records; do not auto-create Deals.",
  "Set lifecycle stage to lead/opportunity only after human approval; first sync should populate fit/review fields and source evidence.",
  "Use HubSpot static/active lists filtered by fsgtm_fit_status and fsgtm_icp_source for account review queues.",
  "Contacts without verified email stay review-only; do not live-create ambiguous people.",
];

function parseArgs(argv: string[]): SyncOptions {
  const opts: SyncOptions = { input: DEFAULT_INPUT, live: false, allowMissingContacts: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") opts.input = argv[++i];
    else if (arg === "--output") opts.output = argv[++i];
    else if (arg === "--live") opts.live = true;
    else if (arg === "--allow-missing-contacts") opts.allowMissingContacts = true;
    else if (arg === "--help") {
      console.log("Usage: npm run gtm -- ignored; node --experimental-strip-types scripts/icp-scout-hubspot-sync.ts [--input scored.csv] [--output plan.json] [--live]");
      process.exit(0);
    }
  }
  return opts;
}

function parseCsv(text: string): ScoutRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') { field += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { row.push(field); field = ""; continue; }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((v) => v.trim() !== "")) rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()])));
}

function normalizeDomain(domainOrUrl: string): string {
  return domainOrUrl.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

function fitStatus(row: ScoutRow): string {
  const decision = (row.decision || row.fit_status || row.status || "").toLowerCase();
  if (decision.includes("reject") || decision.includes("skip")) return "reject";
  if (decision.includes("high") || decision.includes("approve") || decision.includes("proceed")) return "high_fit";
  if (decision.includes("medium")) return "medium_fit";
  if (decision.includes("low")) return "low_fit";
  const score = Number(row.score || row.icp_score);
  if (Number.isFinite(score)) {
    // Support both the original 35-point scout fixture scale and the current 100-point rubric.
    if (score > 35) {
      if (score >= 80) return "high_fit";
      if (score >= 65) return "medium_fit";
      if (score >= 50) return "low_fit";
      return "reject";
    }
    if (score >= 28) return "high_fit";
    if (score >= 20) return "medium_fit";
    return "low_fit";
  }
  return "needs_review";
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s*\|\s*|\s*;\s*/).map((v) => v.trim()).filter(Boolean);
}

function peopleFromRow(row: ScoutRow): Array<Record<string, string>> {
  const peopleJson = row.people_json || row.key_people_json;
  if (peopleJson) {
    try {
      const parsed = JSON.parse(peopleJson);
      if (Array.isArray(parsed)) return parsed.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v ?? "")])));
    } catch {}
  }
  const names = splitList(row.key_people || row.people || row.contacts);
  return names.map((name) => ({ name, role: row.decision_maker_roles || row.roles || "" }));
}

function coalesce(row: ScoutRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function normalizeHubSpotIndustry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (["software development", "computer software", "software", "saas"].includes(normalized)) return "COMPUTER_SOFTWARE";
  if (normalized.includes("telecommunication")) return "TELECOMMUNICATIONS";
  if (normalized.includes("construction")) return "CONSTRUCTION";
  if (normalized.includes("information technology")) return "INFORMATION_TECHNOLOGY_AND_SERVICES";
  return value;
}

function buildSyncPlan(csvText: string, options: SyncOptions): SyncPlan {
  const rows = parseCsv(csvText);
  const warnings: string[] = [];
  const companies: HubSpotCompanyPayload[] = [];
  const contacts: HubSpotContactPayload[] = [];
  const reviewOnlyPeople: Array<Record<string, string>> = [];
  const seenDomains = new Set<string>();

  for (const row of rows) {
    const domain = normalizeDomain(row.domain || row.website || "");
    if (!domain) { warnings.push(`Skipping ${row.company || "unknown company"}: missing domain dedupe key.`); continue; }
    if (seenDomains.has(domain)) { warnings.push(`Skipping duplicate company domain ${domain}.`); continue; }
    seenDomains.add(domain);

    const pain = coalesce(row, ["pain_hypotheses", "pains", "notes"]);
    const roles = coalesce(row, ["decision_maker_roles", "roles", "personas"]);
    const profile = coalesce(row, ["company_profile", "profile", "description", "summary"]);
    const productMotion = coalesce(row, ["product_motion", "gtm_motion", "motion"]);
    const publicSignals = coalesce(row, ["public_signals", "signals", "evidence_summary"]);
    const sourceUrls = coalesce(row, ["source_urls", "sources", "urls"]);
    companies.push({
      idProperty: "domain",
      id: domain,
      properties: compact({
        name: row.company || row.name || domain,
        domain,
        lifecyclestage: row.lifecycle_stage || "lead",
        description: profile,
        industry: normalizeHubSpotIndustry(coalesce(row, ["industry"])),
        founded_year: coalesce(row, ["founded_year", "founded"]),
        numberofemployees: coalesce(row, ["employee_count", "employees"]),
        city: coalesce(row, ["city"]),
        state: coalesce(row, ["state", "region"]),
        country: coalesce(row, ["country"]),
        linkedin_company_page: coalesce(row, ["linkedin", "linkedin_url", "linkedin_company_page"]),
        fsgtm_icp_score: row.score || row.icp_score || "",
        fsgtm_fit_status: fitStatus(row),
        fsgtm_icp_source: row.source || "icp_scout",
        fsgtm_icp_review_url: row.review_path || row.review_url || "",
        fsgtm_icp_evidence_url: row.evidence_path || row.evidence_url || "",
        fsgtm_company_profile: profile,
        fsgtm_category: coalesce(row, ["category", "icp_category", "segment"]),
        fsgtm_employee_range: coalesce(row, ["employee_range", "employee_signal", "size_signal"]),
        fsgtm_funding_stage: coalesce(row, ["funding_stage", "funding", "stage"]),
        fsgtm_guardrail_status: coalesce(row, ["guardrail_status", "guardrails"]),
        fsgtm_product_motion: productMotion,
        fsgtm_public_signals: publicSignals,
        fsgtm_pain_hypotheses: pain,
        fsgtm_decision_maker_roles: roles,
        fsgtm_why_now: coalesce(row, ["why_now", "triggers", "trigger"]),
        fsgtm_wedge: coalesce(row, ["wedge", "suggested_wedge", "consulting_wedge"]),
        fsgtm_counterarguments: coalesce(row, ["counterarguments", "risks", "disqualifiers"]),
        fsgtm_source_urls: sourceUrls,
        fsgtm_icp_last_scored_at: row.date || new Date().toISOString().slice(0, 10),
      }),
    });

    for (const person of peopleFromRow(row)) {
      const email = (person.email || "").toLowerCase();
      if (!email && !options.allowMissingContacts) {
        reviewOnlyPeople.push({ ...person, company: row.company || domain, companyDomain: domain, reason: "missing email dedupe key" });
        continue;
      }
      if (!email) continue;
      const [firstName, ...lastParts] = (person.name || "").split(/\s+/);
      contacts.push({
        idProperty: "email",
        id: email,
        companyDomain: domain,
        properties: compact({
          email,
          firstname: person.firstName || firstName || "",
          lastname: person.lastName || lastParts.join(" "),
          jobtitle: person.title || person.role || "",
          fsgtm_persona_role: person.role || person.persona || person.title || "",
          fsgtm_icp_person_source: row.review_path || row.review_url || row.source || "icp_scout",
        }),
      });
    }
  }

  return {
    mode: options.live ? "live" : "dry-run",
    sourceFile: options.input,
    proposedProperties,
    lifecycleGuidance,
    summary: {
      companiesRead: rows.length,
      companiesPlanned: companies.length,
      contactsPlanned: contacts.length,
      contactsReviewOnly: reviewOnlyPeople.length,
      liveWritesAttempted: false,
    },
    companies,
    contacts,
    reviewOnlyPeople,
    warnings,
  };
}

function compact(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && String(v) !== ""));
}

async function hubspotJson(path: string, token: string, init: RequestInit) {
  const response = await fetch(`${HS_API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HubSpot API ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function hubspotObjectPath(object: "company" | "contact") {
  return object === "company" ? "companies" : "contacts";
}

function toHubSpotProperty(prop: ProposedProperty) {
  return {
    name: prop.name,
    label: prop.label,
    type: prop.type === "number" ? "number" : prop.type === "date" ? "date" : prop.type === "enumeration" ? "enumeration" : "string",
    fieldType: prop.type === "number" ? "number" : prop.type === "date" ? "date" : prop.type === "enumeration" ? "select" : "textarea",
    groupName: prop.object === "company" ? "companyinformation" : "contactinformation",
    description: prop.purpose,
    options: (prop.options ?? []).map((value) => ({ label: value.replace(/_/g, " "), value, hidden: false })),
  };
}

async function ensureProposedProperties(token: string, plan: SyncPlan) {
  for (const prop of plan.proposedProperties) {
    const objectPath = hubspotObjectPath(prop.object);
    const existing = await fetch(`${HS_API_URL}/crm/v3/properties/${objectPath}/${encodeURIComponent(prop.name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (existing.ok) continue;
    if (existing.status !== 404) {
      const text = await existing.text();
      throw new Error(`HubSpot property check ${existing.status} for ${prop.name}: ${text}`);
    }
    await hubspotJson(`/crm/v3/properties/${objectPath}`, token, {
      method: "POST",
      body: JSON.stringify(toHubSpotProperty(prop)),
    }).catch((error) => {
      // A concurrent/manual property create can produce a conflict; continue if the property now exists.
      if (!String(error.message).includes("409")) throw error;
    });
  }
}

async function applyLive(plan: SyncPlan) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("Refusing live sync: set HUBSPOT_PRIVATE_APP_TOKEN or HUBSPOT_ACCESS_TOKEN and pass --live explicitly.");
  plan.summary.liveWritesAttempted = true;
  await ensureProposedProperties(token, plan);
  for (const company of plan.companies) {
    const search = await hubspotJson("/crm/v3/objects/companies/search", token, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: company.id }] }],
        properties: ["name", "domain"],
        limit: 1,
      }),
    });
    const existingId = search?.results?.[0]?.id;
    if (existingId) {
      await hubspotJson(`/crm/v3/objects/companies/${encodeURIComponent(existingId)}`, token, {
        method: "PATCH",
        body: JSON.stringify({ properties: company.properties }),
      });
    } else {
      await hubspotJson("/crm/v3/objects/companies", token, { method: "POST", body: JSON.stringify({ properties: company.properties }) });
    }
  }
  for (const contact of plan.contacts) {
    await hubspotJson(`/crm/v3/objects/contacts/${encodeURIComponent(contact.id)}?idProperty=email`, token, {
      method: "PATCH",
      body: JSON.stringify({ properties: contact.properties }),
    }).catch(async (error) => {
      if (!String(error.message).includes("404")) throw error;
      await hubspotJson("/crm/v3/objects/contacts", token, { method: "POST", body: JSON.stringify({ properties: contact.properties }) });
    });
  }
}

async function main() {
  const fs = await import("node:fs/promises");
  const options = parseArgs(process.argv.slice(2));
  const csvText = await fs.readFile(options.input, "utf8");
  const plan = buildSyncPlan(csvText, options);
  if (options.live) await applyLive(plan);
  const out = JSON.stringify(plan, null, 2);
  if (options.output) await fs.writeFile(options.output, out + "\n");
  else console.log(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}

export { buildSyncPlan, parseCsv, normalizeDomain, fitStatus };
