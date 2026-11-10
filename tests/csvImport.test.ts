import assert from "node:assert/strict";
import test from "node:test";
import { autoMap, classify, classifyDeals, cleanCell, companyCells, dayFirstColumn, matchCompanies, normalizeDay, parseCsv, readRows, summarize, type ImportMatch } from "../convex/lib/objects/csvImport.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { resolvePipelines } from "../convex/lib/pipelines.ts";

const account = resolveObjectDef(STANDARD_OBJECTS.account);
const contact = resolveObjectDef(STANDARD_OBJECTS.contact);
const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
const COMPANIES = [
  { id: "acc_acme", name: "Acme", domain: "acme.com" },
  { id: "acc_globex", name: "Globex", domain: "globex.com" },
  { id: "acc_hooli1", name: "Hooli", domain: "hooli.com" },
  { id: "acc_hooli2", name: "Hooli", domain: "hooli.xyz" },
];

test("headers map to registry fields by apiName, label or a common synonym; first and last name share the full name", () => {
  assert.deepEqual(
    autoMap("account", account, ["Company", "Website", "Employees", "Annual revenue", "Notes", "company name"]),
    ["name", "domain", "employees", "annualRevenue", null, null],
  );
  assert.deepEqual(autoMap("contact", contact, ["First Name", "Last Name", "Email Address", "Job Title", "Company"]), ["fullName", "fullName", "email", "title", "company"]);
});

test("a dry run sorts rows into create, update by domain, skip and error, with row numbers and reasons", () => {
  const csv = [
    "Company,Website,Employees,Status,Annual revenue",
    "Acme,https://www.acme.com/,\"1,200\",Working,\"$1,200.50\"",
    "Globex,globex.com,50,,",
    "Acme again,ACME.com,,,",
    ",,,,",
    "Initech,initech.com,lots,,",
    ",nameless.com,10,,",
    "Umbrella,umbrella.com,10,Sleeping,",
  ].join("\r\n");
  const records = parseCsv(csv);
  const mapping = autoMap("account", account, records[0]);
  const match: ImportMatch = { recordId: "acc_globex", stream: null, snapshot: { id: "acc_globex", domain: "globex.com", name: "Globex Corp", updatedAt: 1 } };
  const outcomes = classify("account", account, readRows("account", account, mapping, records), new Map([["globex.com", match]]))
    .map((o) => (o.kind === "error" ? { ...o, errors: o.errors.map((e) => ({ field: e.field })) } : o));
  assert.deepEqual(outcomes, [
    { kind: "create", row: 2, key: "acme.com", values: { name: "Acme", domain: "acme.com", employees: 1200, status: "working", annualRevenue: 120050 }, company: null },
    { kind: "update", row: 3, key: "globex.com", values: { name: "Globex", domain: "globex.com", employees: 50 }, match, company: null },
    { kind: "skip", row: 4, reason: "Same domain as row 2" },
    { kind: "skip", row: 5, reason: "Empty row" },
    { kind: "error", row: 6, errors: [{ field: "employees" }] },
    { kind: "error", row: 7, errors: [{ field: "name" }] },
    { kind: "error", row: 8, errors: [{ field: "status" }] },
  ]);
});

test("a Company cell links by domain first, then by exact name; several names are ambiguous; none is unmatched or created", () => {
  const cells = ["https://www.ACME.com/", "Globex", "Hooli", "Umbrella", "globex.io"];
  assert.deepEqual([...matchCompanies(cells, COMPANIES, false).values()], [
    { kind: "linked", companyId: "acc_acme" },
    { kind: "linked", companyId: "acc_globex" },
    { kind: "ambiguous", cell: "Hooli", count: 2 },
    { kind: "unmatched", cell: "Umbrella" },
    { kind: "unmatched", cell: "globex.io" },
  ]);

  const csv = parseCsv("Email,Name,Company\njane@acme.com,Jane,acme.com\n,Bob,Globex\nkim@x.com,Kim,Hooli\nlee@x.com,Lee,Umbrella\n");
  const rows = readRows("contact", contact, autoMap("contact", contact, csv[0]), csv);
  const outcomes = classify("contact", contact, rows, new Map(), matchCompanies(companyCells(rows), COMPANIES, true));
  assert.deepEqual(outcomes.map((o) => [o.row, o.kind, o.kind === "create" ? o.company : o.kind === "error" ? o.errors[0].field : null]), [
    [2, "create", { kind: "linked", companyId: "acc_acme" }],
    [3, "error", "company"],
    [4, "error", "company"],
    [5, "create", { kind: "created", cell: "Umbrella" }],
  ]);
  assert.deepEqual(summarize(outcomes).companies, { linked: 1, created: 1, unmatched: 0, ambiguous: 1 });
});

test("a deals dry run: stage by label in its pipeline, money in cents, duplicates by name and company, matches, and row errors, never a duplicate of a CRM deal", () => {
  const stage = deal.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], [
    { id: "p1", name: "Sales", stages: [{ value: "prospecting", probability: 10, forecastCategory: "pipeline" }, { value: "proposal", probability: 50, forecastCategory: "pipeline" }], createdAt: 1 },
    { id: "p2", name: "Renewals", stages: [{ value: "negotiation", probability: 70, forecastCategory: "commit" }], createdAt: 2 },
  ]);
  const csv = parseCsv([
    "Deal name,Company,Amount,Close date,Stage,Pipeline",
    'Acme expansion,acme.com,"$12,500.50",2026-12-01,Proposal,Sales',
    "Acme expansion,Acme,1000,2026-12-01,Prospecting,sales",
    "Acme expansion,Globex,,2026-12-15,prospecting,",
    "Initech renewal,acme.com,,2026-11-01,Negotiation,Sales",
    "Hooli deal,Hooli,,2026-11-01,Proposal,",
    "Pied Piper,acme.com,,,Proposal,",
    "Umbrella,Umbrella,,2026-11-01,Proposal,Enterprise",
    "Globex renewal,Globex,,2026-11-01,Proposal,",
  ].join("\n"));
  const mapping = autoMap("deal", deal, csv[0]);
  assert.deepEqual(mapping, ["name", "company", "amount", "closeDate", "stage", "pipeline"]);
  const rows = readRows("deal", deal, mapping, csv, pipelines);
  const existing = new Map([["Acme expansion", [{ dealId: "d1", companyId: "acc_globex", crmAccount: false }, { dealId: "d2", companyId: null, crmAccount: false }]],
    ["Globex renewal", [{ dealId: "d3", companyId: null, crmAccount: true }]]]);
  const outcomes = classifyDeals(rows, existing, matchCompanies(["acme.com", "Acme", "Globex", "Hooli", "Umbrella"], COMPANIES, false), pipelines, true);
  assert.deepEqual(outcomes.map((o) => (o.kind === "error" ? { kind: o.kind, row: o.row, fields: o.errors.map((e) => e.field) } : o.kind === "skip" ? { kind: o.kind, row: o.row } : o)), [
    { kind: "create", row: 2, key: "Acme expansion", values: { name: "Acme expansion", amount: 1250050, closeDate: "2026-12-01", stage: "proposal" }, company: { kind: "linked", companyId: "acc_acme" } },
    { kind: "skip", row: 3 },
    { kind: "update", row: 4, key: "Acme expansion", values: { name: "Acme expansion", closeDate: "2026-12-15", stage: "prospecting" }, match: { dealId: "d1", companyId: "acc_globex", crmAccount: false }, company: { kind: "linked", companyId: "acc_globex" } },
    { kind: "error", row: 5, fields: ["stage"] },
    { kind: "error", row: 6, fields: ["company"] },
    { kind: "error", row: 7, fields: ["deal"] },
    { kind: "error", row: 8, fields: ["pipeline"] },
    { kind: "error", row: 9, fields: ["name"] },
  ]);
  // A figure written short reads as its number: 7.5k dollars is 750,000 cents.
  assert.deepEqual(["7.5k", "$1.2M", "48,000"].map((c) => cleanCell("deal", deal.byApiName.get("amount")!, c)), ["750000", "120000000", "4800000"]);
});

test("a deal's Owner column names a member by email: a known one owns the deal, an unknown one is listed and the row still imports", () => {
  const stage = deal.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], [{ id: "p1", name: "Sales", stages: [{ value: "proposal", probability: 50, forecastCategory: "pipeline" }], createdAt: 1 }]);
  const csv = parseCsv(["Deal name,Close date,Stage,Deal owner", "A,2026-12-01,Proposal,Rep@Co.com", "B,2026-12-01,Proposal,nobody@co.com", "C,2026-12-01,Proposal,not an email"].join("\n"));
  const mapping = autoMap("deal", deal, csv[0]);
  assert.equal(mapping[3], "owner");
  const outcomes = classifyDeals(readRows("deal", deal, mapping, csv, pipelines), new Map(), new Map(), pipelines, false, deal, new Map(), new Map([["rep@co.com", "user_rep"]]));
  assert.deepEqual(outcomes.map((o) => [o.kind, "ownerId" in o ? o.ownerId : null]), [["create", "user_rep"], ["create", null], ["error", null]]);
  assert.deepEqual(summarize(outcomes).owners, { matched: 1, unknown: ["nobody@co.com"] });
});

test("a deal file's revenue type, contract length and products are typed for the row; an unknown owner's rows can be skipped", () => {
  const stage = deal.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], [{ id: "p1", name: "Sales", stages: [{ value: "proposal", probability: 50, forecastCategory: "pipeline" }], createdAt: 1 }]);
  const csv = parseCsv(["Deal name,Close date,Stage,Owner,Revenue type,Contract length,Products", "A,2026-12-01,Proposal,rep@co.com,One time,12 months,Core; Seats", "B,2026-12-01,Proposal,nobody@co.com,recurring,24,", "C,2026-12-01,Proposal,rep@co.com,weekly,,"].join("\n"));
  const mapping = autoMap("deal", deal, csv[0]);
  assert.deepEqual(mapping.slice(4), ["revenueType", "contractLength", "products"]);
  const outcomes = classifyDeals(readRows("deal", deal, mapping, csv, pipelines), new Map(), new Map(), pipelines, false, deal, new Map(), new Map([["rep@co.com", "user_rep"]]), true);
  assert.deepEqual(outcomes.map((o) => [o.kind, "columns" in o ? o.columns : null]), [
    ["create", { revenueType: "one_time", contractLengthMonths: 12, products: ["Core", "Seats"] }], ["skip", null], ["error", null],
  ]);
});

test("a stage no pipeline has fails its rows and is counted once; a stage map imports them as a stage the pipeline has", () => {
  const stage = deal.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], [{ id: "p1", name: "Sales", stages: [{ value: "proposal", probability: 50, forecastCategory: "pipeline" }], createdAt: 1 }]);
  const csv = parseCsv(["Deal name,Close date,Stage", "A,2026-12-01,Discovery", "B,2026-12-01,discovery", "C,2026-12-01,Proposal", "D,2026-12-01,Demo"].join("\n"));
  const mapping = autoMap("deal", deal, csv[0]);
  const before = summarize(classifyDeals(readRows("deal", deal, mapping, csv, pipelines), new Map(), new Map(), pipelines, false, deal));
  assert.equal(before.counts.error, 3);
  // Cells differing only in case are one stage, with all of its rows.
  assert.deepEqual(before.unknownStages, [{ value: "Discovery", rows: 2 }, { value: "Demo", rows: 1 }]);
  const after = summarize(classifyDeals(readRows("deal", deal, mapping, csv, pipelines, { discovery: "Proposal" }), new Map(), new Map(), pipelines, false, deal));
  assert.deepEqual(after.counts, { create: 3, update: 0, skip: 0, error: 1 });
  assert.deepEqual(after.unknownStages, [{ value: "Demo", rows: 1 }]);
});

test("date cells read in the shapes spreadsheets save them", () => {
  const cases: [string, string | null][] = [
    ["2027-01-11", "2027-01-11"], ["2027/1/11", "2027-01-11"], ["2027-01-11T00:00:00Z", "2027-01-11"],
    ["1/11/27", "2027-01-11"], ["01/11/2027", "2027-01-11"], ["1/11/2027 0:00", "2027-01-11"], ["10/24/26", "2026-10-24"],
    ["11-Jan-2027", "2027-01-11"], ["11 Jan 27", "2027-01-11"], ["Jan 11, 2027", "2027-01-11"], ["January 11th 2027", "2027-01-11"], ["Sept 3 2026", "2026-09-03"],
    ["46398", "2027-01-11"], ["12/31/99", "1999-12-31"],
    // Not dates, or not real days: left for the registry to refuse.
    ["2/30/2027", null], ["13/13/2027", null], ["next week", null], ["123", null], ["Foo 3 2026", null],
  ];
  for (const [cell, want] of cases) assert.equal(normalizeDay(cell), want, cell);
  // A first part over 12 can only be a day.
  assert.equal(normalizeDay("24/10/2026"), "2026-10-24");
  assert.equal(normalizeDay("03/04/2026", true), "2026-04-03");
});

test("a column is day first only when some first part is over 12 and no second part is", () => {
  assert.equal(dayFirstColumn(["03/04/2026", "25/04/2026"]), true);
  assert.equal(dayFirstColumn(["03/04/2026", "04/25/2026"]), false);
  assert.equal(dayFirstColumn(["2026-04-03", "Jan 4 2026"]), false);
});

test("a deal's close date imports from an Excel-saved file, and a day-first column reads as one", () => {
  const stage = deal.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], [{ id: "p1", name: "Sales", stages: [{ value: "proposal", probability: 50, forecastCategory: "pipeline" }], createdAt: 1 }]);
  const us = parseCsv(["Deal name,Close date,Stage", "A,1/11/27,Proposal", "B,46398,Proposal"].join("\n"));
  const rows = readRows("deal", deal, autoMap("deal", deal, us[0]), us, pipelines);
  assert.deepEqual(rows.map((r) => (r.kind === "read" ? r.values.closeDate : r.kind)), ["2027-01-11", "2027-01-11"]);
  // 03/04 reads as 3 April here, because 25/04 in the same column can only be day first.
  const eu = parseCsv(["Deal name,Close date,Stage", "A,03/04/2026,Proposal", "B,25/04/2026,Proposal"].join("\n"));
  const euRows = readRows("deal", deal, autoMap("deal", deal, eu[0]), eu, pipelines);
  assert.deepEqual(euRows.map((r) => (r.kind === "read" ? r.values.closeDate : r.kind)), ["2026-04-03", "2026-04-25"]);
  assert.equal(cleanCell("deal", deal.byApiName.get("closeDate")!, "not a date"), "not a date");
});
