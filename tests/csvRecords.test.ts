import assert from "node:assert/strict";
import test from "node:test";
import { autoMap, classify, classifyDeals, matchCompanies, parseCsv, readRows, summarize } from "../convex/lib/objects/csvImport.ts";
import {
  autoMapRecord, classifyRecords, parseDateCell, readRecordRows, recordColumns, recordKeys, type RecordDefs, type RecordLookups,
} from "../convex/lib/objects/csvRecords.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { resolvePipelines } from "../convex/lib/pipelines.ts";

const defs: RecordDefs = Object.fromEntries((["note", "task", "call", "meeting", "lead", "product"] as const).map((o) => [o, resolveObjectDef(STANDARD_OBJECTS[o])]));
const COMPANIES = [{ id: "acc_acme", name: "Acme", domain: "acme.com" }, { id: "acc_globex", name: "Globex", domain: "globex.com" }];

test("an activities file: type picks the object, Date and Owner set when and who, targets resolve per cell, a row matching none fails unless allowed", () => {
  const csv = parseCsv([
    "Type,Subject,Notes,Date,Owner,Company,Email,Deal,Status",
    "Call,Intro call,Wants pricing,2025-03-04 14:30,rep@x.com,acme.com,jane@acme.com,Acme expansion,Completed",
    "note,Met at SaaStr,,3/9/2025,gone@x.com,Globex,,,",
    "Task,Send quote,,2025-04-01,rep@x.com,,ghost@nowhere.com,Nope,Not started",
    "Meeting,Kickoff,,,rep@x.com,Acme,,,",
    "Email,Hello,,,,acme.com,,,",
    "Task,Orphan,,2025-13-01,,,,,",
  ].join("\n"));
  const mapping = autoMapRecord("activity", recordColumns("activity", defs), csv[0]);
  assert.deepEqual(mapping, ["type", "subject", "body", "date", "owner", "company", "person", "deal", "status"]);
  const read = readRecordRows("activity", defs, mapping, csv);
  assert.deepEqual(recordKeys(read), { companies: ["acme.com", "Globex", "Acme"], people: ["jane@acme.com", "ghost@nowhere.com"], deals: ["Acme expansion", "Nope"], owners: ["rep@x.com", "gone@x.com"] });
  const lookups: RecordLookups = {
    members: new Map([["rep@x.com", "user_1"]]), companies: matchCompanies(recordKeys(read).companies, COMPANIES, false),
    people: new Map([["jane@acme.com", "con_jane"]]), deals: new Map([["Acme expansion", [{ streamId: "deal_stream_1", companyId: "acc_acme" }]]]),
  };
  const outcomes = classifyRecords(read, defs, lookups);
  assert.deepEqual(outcomes.map((o) => (o.kind === "error" ? { kind: o.kind, row: o.row, message: o.errors[0].message } : o)), [
    {
      kind: "create", row: 2, object: "call", createdAt: Date.UTC(2025, 2, 4, 14, 30), targets: ["acc_acme", "con_jane", "deal_stream_1"], misses: [], warnings: [],
      values: { subject: "Intro call", notes: "Wants pricing", callAt: Date.UTC(2025, 2, 4, 14, 30), ownerId: "user_1", accountId: "acc_acme", contactId: "con_jane", dealId: "deal_stream_1" },
    },
    {
      kind: "create", row: 3, object: "note", createdAt: Date.UTC(2025, 2, 9, 12), targets: ["acc_globex"], misses: [],
      warnings: ["No member has the email gone@x.com; the row is left without an owner"], values: { body: "Met at SaaStr", accountId: "acc_globex" },
    },
    { kind: "error", row: 4, message: "No target matched: No person has the email ghost@nowhere.com; No deal matches Nope" },
    { kind: "error", row: 5, message: "Start time is required" },
    { kind: "error", row: 6, message: '"Email" is not a note, task, call or meeting' },
    { kind: "error", row: 7, message: "Date must be a date such as 2026-03-04, 2026-03-04 14:30 or 3/4/2026" },
  ]);
  assert.deepEqual(summarize(outcomes).targets, { matched: 4, unmatched: 2 });
  // Allowing untargeted rows keeps row 4, without a timeline to land on.
  const lenient = classifyRecords(read, defs, lookups, { allowUntargeted: true });
  assert.deepEqual([lenient[2].kind, lenient[2].kind === "create" ? lenient[2].targets : null], ["create", []]);
});

test("dates read as ISO, US or epoch and nothing else; plain objects take registry fields, skip a repeated unique value and accept Created date for Date", () => {
  assert.deepEqual(
    ["2026-03-04", "2026-03-04T14:30:00+02:00", "3/4/2026 2:30 PM", "12/31/2025 12:00 AM", "1709562600000", "2026-02-30", "yesterday", "13/1/2026"].map(parseDateCell),
    [Date.UTC(2026, 2, 4, 12), Date.UTC(2026, 2, 4, 12, 30), Date.UTC(2026, 2, 4, 14, 30), Date.UTC(2025, 11, 31, 0), 1709562600000, null, null, null],
  );
  const csv = parseCsv("Product name,SKU,Price,Active,Created date\nWidget,W-1,\"$9.50\",true,2024-01-02\nWidget copy,w-1,1,true,\n,X,1,,");
  const mapping = autoMapRecord("product", recordColumns("product", defs), csv[0]);
  assert.deepEqual(mapping, ["name", "sku", "unitPrice", "active", "date"]);
  const outcomes = classifyRecords(readRecordRows("product", defs, mapping, csv), defs, { members: new Map(), companies: new Map(), people: new Map(), deals: new Map() });
  assert.deepEqual(outcomes.map((o) => (o.kind === "create" ? [o.kind, o.values, o.createdAt] : o.kind === "skip" ? [o.kind, o.reason] : [o.kind, o.errors[0].message])), [
    ["create", { name: "Widget", sku: "W-1", unitPrice: 950, active: true }, Date.UTC(2024, 0, 2, 12)],
    ["skip", "Same SKU as row 2"],
    ["error", "Product name is required"],
  ]);
});

test("association columns: a person's Companies (first primary, repeats once), a deal's Contacts with roles by value or label, unknown people warn, a re-run counts keyless rows as updates", () => {
  const contact = resolveObjectDef(STANDARD_OBJECTS.contact);
  const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
  const people = parseCsv("Email,Name,Companies\njane@x.com,Jane,acme.com; Globex; ACME.com\n,Kim,\nbob@x.com,Bob,Nowhere");
  const rows = readRows("contact", contact, autoMap("contact", contact, people[0]), people);
  const outcomes = classify("contact", contact, rows, new Map(), matchCompanies(["acme.com", "Globex", "ACME.com", "Nowhere"], COMPANIES, false), new Set([3]));
  assert.deepEqual(outcomes.map((o) => (o.kind === "create" ? [o.row, o.links, o.again ?? false] : [o.row, o.kind])), [
    [2, [{ kind: "linked", companyId: "acc_acme" }, { kind: "linked", companyId: "acc_globex" }], false],
    [3, undefined, true],
    [4, "error"],
  ]);
  assert.deepEqual(summarize(outcomes).counts, { create: 1, update: 1, skip: 0, error: 1 });

  const stage = deal.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], []);
  const csv = parseCsv("Deal name,Close date,Stage,Contacts\nBig deal,2026-12-01,Proposal,jane@x.com:N-1; bob@x.com:champion; zed@x.com\nBad role,2026-12-01,Proposal,jane@x.com:boss");
  const dealRows = readRows("deal", deal, autoMap("deal", deal, csv[0]), csv, pipelines);
  const out = classifyDeals(dealRows, new Map(), new Map(), pipelines, false, deal, new Map([["jane@x.com", "con_jane"], ["bob@x.com", "con_bob"]]));
  assert.deepEqual(out[0].kind === "create" ? [out[0].members, out[0].warnings] : null, [
    [{ contactId: "con_jane", role: "n1" }, { contactId: "con_bob", role: "champion" }],
    ["No person has the email zed@x.com; not added to the deal"],
  ]);
  assert.deepEqual(out[1].kind === "error" ? out[1].errors[0].field : null, "contacts");
});

test("a semicolon-separated file reads like a comma one", () => {
  assert.deepEqual(parseCsv('Name;Note\r\nAcme;"a; b"\r\n'), [["Name", "Note"], ["Acme", "a; b"]]);
});

test("a meeting's end time and a task's due date with a time read by the Date rules", () => {
  const csv = parseCsv(["Type,Subject,Date,Meeting end,Due,Company", "Meeting,Kickoff,2026-10-10 14:00,2026-10-10 15:00,,Acme", "Task,Send quote,,,2026-10-12 09:00,Acme"].join("\n"));
  const mapping = autoMapRecord("activity", recordColumns("activity", defs), csv[0]);
  const [meeting, task] = readRecordRows("activity", defs, mapping, csv);
  assert.equal(meeting.kind === "record" && meeting.values.endAt, Date.UTC(2026, 9, 10, 15));
  assert.equal(task.kind === "record" && task.values.dueDate, "2026-10-12");
});
