import assert from "node:assert/strict";
import test from "node:test";
import { buildSyncPlan, normalizeDomain, parseCsv } from "../scripts/icp-scout-hubspot-sync.ts";

const regalCsv = `date,company,domain,score,decision,review_path,evidence_path,notes,decision_maker_roles,key_people_json
2026-05-19,Regal.io,https://www.regal.ai,30,High-fit,/home/ubuntu/.pi/agent/gtm-agent-hud/jobs/ab-8c8e359615/review.md,/home/ubuntu/.pi/agent/gtm-agent-hud/jobs/ab-8c8e359615/evidence.md,"Customer deployment data plumbing tax; Sales-to-implementation handoff risk; GTM reporting and attribution complexity","CEO/founders; Director GTM; CS/Implementation; Product Data; RevOps","[{""name"":""Alex Levin"",""role"":""Co-founder & CEO"",""email"":""alex@example.com""},{""name"":""Rebecca Greene"",""role"":""Co-founder""}]"
`;

test("normalizes HubSpot company dedupe domains", () => {
  assert.equal(normalizeDomain("https://www.regal.ai/product"), "regal.ai");
  assert.equal(normalizeDomain("REGAL.IO"), "regal.io");
});

test("parses quoted ICP Scout CSV fields", () => {
  const rows = parseCsv(regalCsv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, "Regal.io");
  assert.match(rows[0].notes, /Sales-to-implementation/);
});

test("builds dry-run HubSpot sync payload for Regal with safe dedupe and review-only person", () => {
  const plan = buildSyncPlan(regalCsv, {
    input: "regal.csv",
    live: false,
    allowMissingContacts: false,
  });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.summary.liveWritesAttempted, false);
  assert.equal(plan.summary.companiesRead, 1);
  assert.equal(plan.summary.companiesPlanned, 1);
  assert.equal(plan.companies[0].idProperty, "domain");
  assert.equal(plan.companies[0].id, "regal.ai");
  assert.equal(plan.companies[0].properties.fsgtm_icp_score, "30");
  assert.equal(plan.companies[0].properties.fsgtm_fit_status, "high_fit");
  assert.match(plan.companies[0].properties.fsgtm_pain_hypotheses, /deployment data plumbing/);
  assert.match(plan.companies[0].properties.fsgtm_decision_maker_roles, /Director GTM/);
  assert.match(plan.companies[0].properties.fsgtm_icp_review_url, /review.md/);

  const enrichedPlan = buildSyncPlan(`${regalCsv.trim()}\n`, {
    input: "regal.csv",
    live: false,
    allowMissingContacts: false,
  });
  assert.equal(enrichedPlan.companies[0].properties.fsgtm_fit_status, "high_fit");

  assert.equal(plan.summary.contactsPlanned, 1);
  assert.equal(plan.contacts[0].idProperty, "email");
  assert.equal(plan.contacts[0].id, "alex@example.com");
  assert.equal(plan.contacts[0].companyDomain, "regal.ai");
  assert.equal(plan.contacts[0].properties.fsgtm_persona_role, "Co-founder & CEO");

  assert.equal(plan.summary.contactsReviewOnly, 1);
  assert.equal(plan.reviewOnlyPeople[0].reason, "missing email dedupe key");
});

test("maps enriched researched fields into HubSpot standard and FSGTM properties", () => {
  const csv = `date,company,domain,linkedin,score,decision,description,industry,employee_count,founded_year,company_profile,category,employee_range,funding_stage,guardrail_status,product_motion,public_signals,pain_hypotheses,decision_maker_roles,why_now,wedge,counterarguments,source_urls\n2026-05-20,BuildOps,https://buildops.com,https://www.linkedin.com/company/buildops/,88,high_fit,"Vertical workflow SaaS for commercial contractors",Software Development,643,2018,"Private vertical SaaS / AI-native ops platform",Vertical SaaS,"201-500 / 643 visible employees",Series C,"Pass with caution","Sales-led demo motion across dispatch invoices payments reporting","Careers show Data Architects and Salesforce Admin","Implementation-data bottleneck","CRO; CPO; CS; PS; Salesforce owner","Series C and OpsAI launch","Implementation readiness scorecard","May be too mature","https://buildops.com/; https://www.linkedin.com/company/buildops/"\n`;
  const plan = buildSyncPlan(csv, { input: "buildops.csv", live: false, allowMissingContacts: false });
  const props = plan.companies[0].properties;
  assert.equal(props.industry, "COMPUTER_SOFTWARE");
  assert.equal(props.numberofemployees, "643");
  assert.match(props.description, /AI-native/);
  assert.match(props.fsgtm_company_profile, /AI-native/);
  assert.match(props.fsgtm_product_motion, /Sales-led/);
  assert.match(props.fsgtm_public_signals, /Data Architects/);
  assert.match(props.fsgtm_why_now, /Series C/);
  assert.match(props.fsgtm_wedge, /readiness/);
  assert.match(props.fsgtm_counterarguments, /too mature/);
  assert.match(props.fsgtm_source_urls, /buildops/);
});

test("refuses to plan ambiguous companies without domain", () => {
  const plan = buildSyncPlan("company,score\nNo Domain Inc,31\n", {
    input: "missing-domain.csv",
    live: false,
    allowMissingContacts: false,
  });
  assert.equal(plan.summary.companiesRead, 1);
  assert.equal(plan.summary.companiesPlanned, 0);
  assert.match(plan.warnings[0], /missing domain dedupe key/);
});
