/**
 * The 50-record spot check (docs/core-crm-parity.md, CP11): sample random
 * records per object from Salesforce, find each in Canon, and compare them
 * field by field. Prints a pass/fail table and exits 1 on any mismatch.
 *
 *   node --experimental-strip-types scripts/sf-spot-check.ts --sf <file> [--canon <url>] [--n 50] [--seed 1] [--out <file.json>]
 *
 * `--sf` names a JSON file with the org's `instanceUrl` (or `baseUrl`) and an
 * access `token`, so no secret is in argv. Canon is read through
 * POST /api/v1/salesforce/spot-check; set CANON_TOKEN to a paired CLI token
 * for a deployed workspace (a local stack needs none).
 *
 * The expected values here are written from Salesforce's own fields, not
 * from the importer's mapping code, so a mapping bug shows as a mismatch.
 * A record the import reported as a failure counts as reported, not missing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { bulkQuery, soql } from "../engine/src/sync/salesforceImport/sfClient.ts";
import type { SfConn } from "../engine/src/sync/salesforceImport/contracts.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

type Row = Record<string, string>;
type Mismatch = { object: string; sfId: string; field: string; salesforce: unknown; canon: unknown };
type Tally = { object: string; sampled: number; found: number; reported: number; missing: number; fieldsChecked: number; mismatches: number };

const sfFile = arg("sf");
if (!sfFile) throw new Error("Pass --sf <file> with the org's instanceUrl and token");
const sfInfo = JSON.parse(readFileSync(sfFile, "utf8")) as { instanceUrl?: string; baseUrl?: string; token?: string; accessToken?: string; apiVersion?: string };
const conn: SfConn = {
  instanceUrl: (sfInfo.instanceUrl ?? sfInfo.baseUrl)!,
  apiVersion: (sfInfo.apiVersion ?? "60.0").replace(/^v/, ""),
  getToken: async () => (sfInfo.token ?? sfInfo.accessToken)!,
};
const canonBase = (arg("canon") ?? `http://localhost:${process.env.NEXT_PORT ?? "3000"}`).replace(/\/$/, "");
const N = Number(arg("n", "50"));
const OBJECTS = (arg("objects", "Account,Contact,Opportunity,OpportunityContactRole,Task,Event,ContentDocument") ?? "").split(",");

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(Number(arg("seed", "1")));

async function sample(object: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of bulkQuery(conn, `SELECT Id FROM ${object}`)) ids.push(...page.map((r) => r.Id));
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, N);
}

async function rows(object: string, fields: string[], ids: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await soql<Record<string, unknown>>(conn, `SELECT ${fields.join(", ")} FROM ${object} WHERE Id IN (${ids.slice(i, i + 100).map((id) => `'${id}'`).join(",")})`);
    for (const r of res.records) out.set(String(r.Id), Object.fromEntries(fields.map((f) => [f, r[f] === null || r[f] === undefined ? "" : String(r[f])])));
  }
  return out;
}

async function canon(object: string, sfIds: string[]) {
  const res = await fetch(`${canonBase}/api/v1/salesforce/spot-check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.CANON_TOKEN ? { authorization: `Bearer ${process.env.CANON_TOKEN}` } : {}) },
    body: JSON.stringify({ object, sfIds }),
  });
  if (!res.ok) throw new Error(`Canon spot-check ${object}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { data: { records: Array<Record<string, any>>; unmappedOwners: string[]; reportedFailures: string[] } }).data;
}

/** A website's host, lowercased, without scheme, path, port or a leading www. */
function host(website: string): string | null {
  const s = website.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].split(":")[0].replace(/^www\d?\./, "");
  return s.includes(".") ? s : null;
}
const emailDomain = (email: string) => (email.includes("@") ? email.split("@")[1].toLowerCase() : null);
const blank = (v: string) => (v === "" ? null : v);
const sfTime = (v: string) => Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

/** Salesforce OpportunityContactRole.Role to the Canon role the PR's table names. */
const ROLES: Record<string, string> = {
  "Decision Maker": "executive", "Economic Decision Maker": "executive", "Executive Sponsor": "executive", "Economic Buyer": "signer",
  Champion: "champion", "Technical Buyer": "security", Evaluator: "user", "Business User": "user", Influencer: "involved", Other: "involved",
};
const SINGLE = new Set(["executive", "n1", "champion", "signer"]);
const ACTIVITY_OBJECTS = new Set(["Task", "Event", "Note", "ContentDocument"]);

const mismatches: Mismatch[] = [];
const tallies: Tally[] = [];

function check(t: Tally, object: string, sfId: string, field: string, salesforce: unknown, canonValue: unknown) {
  t.fieldsChecked++;
  if (JSON.stringify(salesforce ?? null) === JSON.stringify(canonValue ?? null)) return;
  t.mismatches++;
  mismatches.push({ object, sfId, field, salesforce, canon: canonValue });
}

const ownerOk = (sfOwnerEmail: string, ownerId: string, canonEmail: string | null, unmapped: Set<string>) =>
  canonEmail ? canonEmail === sfOwnerEmail.toLowerCase() : unmapped.has(ownerId);

async function main() {
  const users = new Map((await soql<Record<string, string>>(conn, "SELECT Id, Email FROM User")).records.map((u) => [u.Id, (u.Email ?? "").toLowerCase()]));
  const accountHost = async (ids: string[]) => {
    const found = await rows("Account", ["Id", "Website"], [...new Set(ids.filter(Boolean))]);
    return (id: string) => (id ? host(found.get(id)?.Website ?? "") : null);
  };
  // Opportunity custom fields, with their labels and types, to compare with the Canon fields of the same label.
  const described = (await (await fetch(`${conn.instanceUrl.replace(/\/$/, "")}/services/data/v${conn.apiVersion}/sobjects/Opportunity/describe`, { headers: { authorization: `Bearer ${await conn.getToken()}` } })).json()) as { fields: Array<{ name: string; label: string; type: string; custom: boolean; calculated: boolean }> };
  const customDefs = described.fields.filter((f) => f.custom && !f.calculated && !["address", "location", "base64"].includes(f.type));
  const customFields = customDefs.map((f) => f.name);
  for (const object of OBJECTS) {
    const t: Tally = { object, sampled: 0, found: 0, reported: 0, missing: 0, fieldsChecked: 0, mismatches: 0 };
    tallies.push(t);
    const ids = await sample(object);
    t.sampled = ids.length;
    if (object === "OpportunityContactRole") {
      const roleRows = await rows(object, ["Id", "OpportunityId", "ContactId", "Role", "IsPrimary"], ids);
      const oppIds = [...new Set([...roleRows.values()].map((r) => r.OpportunityId))];
      const allRoles = await soql<Record<string, unknown>>(conn, `SELECT Id, OpportunityId, ContactId, Role, IsPrimary FROM OpportunityContactRole WHERE OpportunityId IN (${oppIds.map((id) => `'${id}'`).join(",")})`);
      // Role ids ride along so the response says which roles the import reported as failures.
      const got = await canon("Opportunity", [...oppIds, ...roleRows.keys()]);
      const reported = new Set(got.reportedFailures);
      const deals = new Map(got.records.map((r) => [r.sfId, r]));
      for (const [id, r] of roleRows) {
        const deal = deals.get(r.OpportunityId);
        const held = deal?.roles?.find((x: { contactSfId: string | null }) => x.contactSfId === r.ContactId);
        if (!held && reported.has(id)) { t.reported++; continue; }
        if (!held) { t.missing++; mismatches.push({ object, sfId: id, field: "(record)", salesforce: `${r.ContactId} on ${r.OpportunityId}`, canon: null }); continue; }
        t.found++;
        const expected = ROLES[r.Role] ?? "involved";
        const sharesRole = allRoles.records.some((o) => o.OpportunityId === r.OpportunityId && o.ContactId !== r.ContactId && (ROLES[String(o.Role ?? "")] ?? "involved") === expected);
        check(t, object, id, "role", SINGLE.has(expected) && sharesRole && held.label === "involved" ? "involved" : expected, held.label);
      }
      continue;
    }
    const fields = {
      Account: ["Id", "Name", "Website", "Industry", "NumberOfEmployees", "BillingCountry", "OwnerId"],
      Contact: ["Id", "Name", "Email", "Title", "AccountId"],
      Lead: ["Id", "Name", "Email", "Title", "Website", "IsConverted"],
      Opportunity: [
        "Id", "Name", "Amount", "CurrencyIsoCode", "CloseDate", "StageName", "RecordTypeId", "Probability", "ForecastCategoryName", "IsClosed", "IsWon", "OwnerId", "AccountId",
        "CreatedDate", "SystemModstamp", ...customFields,
      ],
      Task: ["Id", "WhoId", "WhatId", "Subject", "ActivityDate", "Status", "TaskSubtype", "CallDurationInSeconds", "OwnerId", "CreatedDate"],
      Event: ["Id", "WhoId", "WhatId", "Subject", "StartDateTime", "EndDateTime", "Location", "OwnerId", "CreatedDate"],
      Note: ["Id", "ParentId", "Title", "Body", "OwnerId", "CreatedDate"],
      ContentDocument: ["Id", "Title", "FileType", "FileExtension", "OwnerId", "CreatedDate"],
    }[object]!;
    const source = await rows(object, fields, ids);
    const got = await canon(object, ids);
    const unmapped = new Set(got.unmappedOwners);
    const reported = new Set(got.reportedFailures);
    const byId = new Map(got.records.map((r) => [r.sfId, r]));
    const hostOf = await accountHost([...source.values()].map((r) => r.AccountId ?? ""));
    const processOf = new Map<string, string>();
    const stageHistoryOf = new Map<string, Array<[number, string]>>();
    if (object === "Opportunity" && ids.length) {
      const rowsOf = await soql<Record<string, string>>(conn, `SELECT OpportunityId, StageName, CreatedDate FROM OpportunityHistory WHERE OpportunityId IN (${ids.map((x) => `'${x}'`).join(",")})`);
      for (const h of rowsOf.records) {
        const modstamp = sfTime(source.get(h.OpportunityId)?.SystemModstamp ?? "");
        const at = sfTime(h.CreatedDate);
        if (Number.isFinite(modstamp) && at >= modstamp) continue;
        stageHistoryOf.set(h.OpportunityId, [...(stageHistoryOf.get(h.OpportunityId) ?? []), [at, h.StageName] as [number, string]].sort((a, b) => a[0] - b[0]));
      }
    }
    if (object === "Opportunity") {
      const types = await soql<Record<string, string>>(conn, "SELECT Id, BusinessProcessId FROM RecordType WHERE SobjectType = 'Opportunity'");
      const names = new Map((await soql<Record<string, string>>(conn, "SELECT Id, Name FROM BusinessProcess")).records.map((p) => [p.Id, p.Name]));
      for (const rt of types.records) processOf.set(rt.Id, names.get(rt.BusinessProcessId) ?? "");
    }
    const docLinks = new Map<string, string[]>();
    if (object === "ContentDocument" && ids.length) {
      const links = await soql<Record<string, string>>(conn, `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE ContentDocumentId IN (${ids.map((id) => `'${id}'`).join(",")})`);
      for (const l of links.records) if (!l.LinkedEntityId.startsWith("005")) docLinks.set(l.ContentDocumentId, [...(docLinks.get(l.ContentDocumentId) ?? []), l.LinkedEntityId]);
    }
    // An activity's targets compare as Canon sees them: an account by its domain (two Salesforce accounts with one domain are one
    // company), and a person the import reported as failed is not expected.
    const expectedTargets = new Map<string, string[]>();
    let targetKey = (sfId: string) => sfId;
    if (ACTIVITY_OBJECTS.has(object)) {
      for (const [id, r] of source) {
        expectedTargets.set(id, [...new Set(object === "ContentDocument" ? docLinks.get(id) ?? [] : [r.WhoId, r.WhatId, r.ParentId].filter(Boolean))]);
      }
      const canonTargets = got.records.flatMap((c) => (c.found ? (c.targetSfIds as Array<string | null>) : [])).filter((x): x is string => Boolean(x));
      const all = [...new Set([...[...expectedTargets.values()].flat(), ...canonTargets])];
      const hosts = await accountHost(all.filter((x) => x.startsWith("001")));
      targetKey = (sfId) => (sfId.startsWith("001") ? `domain:${hosts(sfId)}` : sfId);
      const people = all.filter((x) => x.startsWith("003") || x.startsWith("00Q"));
      const failed = new Set<string>();
      for (let i = 0; i < people.length; i += 100) for (const f of (await canon("Contact", people.slice(i, i + 100))).reportedFailures) failed.add(f);
      for (const [id, list] of expectedTargets) expectedTargets.set(id, list.filter((x) => !failed.has(x)));
    }
    for (const [id, r] of source) {
      const c = byId.get(id);
      if (!c?.found) {
        if (reported.has(id)) t.reported++;
        else { t.missing++; mismatches.push({ object, sfId: id, field: "(record)", salesforce: r.Name, canon: null }); }
        continue;
      }
      t.found++;
      if (object === "Account") {
        const a = c.account;
        check(t, object, id, "name", r.Name, a.name);
        check(t, object, id, "domain", host(r.Website), a.domain);
        check(t, object, id, "industry", blank(r.Industry), a.industry);
        check(t, object, id, "employees", r.NumberOfEmployees ? Number(r.NumberOfEmployees) : null, a.employees);
        check(t, object, id, "country", blank(r.BillingCountry), a.country);
        check(t, object, id, "owner", true, ownerOk(users.get(r.OwnerId) ?? "", r.OwnerId, a.ownerEmail, unmapped));
      } else if (ACTIVITY_OBJECTS.has(object)) {
        const v = c.values;
        const keys = (list: Array<string | null>) => [...new Set(list.filter((x): x is string => Boolean(x)).map(targetKey))].sort();
        check(t, object, id, "about", keys(expectedTargets.get(id) ?? []), keys(c.targetSfIds));
        check(t, object, id, "createdAt", sfTime(r.CreatedDate), c.createdAt);
        check(t, object, id, "owner", true, ownerOk(users.get(r.OwnerId) ?? "", r.OwnerId, c.ownerEmail, unmapped));
        if (object === "Task") {
          const isCall = r.TaskSubtype === "Call";
          check(t, object, id, "kind", isCall ? "call" : "task", c.object);
          check(t, object, id, "subject", blank(r.Subject) ?? (isCall ? null : "Task"), v.subject);
          if (isCall) check(t, object, id, "duration", r.CallDurationInSeconds ? Number(r.CallDurationInSeconds) : null, v.durationSeconds);
          else check(t, object, id, "status", ({ "Not Started": "not_started", "In Progress": "in_progress", Completed: "completed", "Waiting on someone else": "waiting", Deferred: "deferred" } as Record<string, string>)[r.Status] ?? null, v.status);
          if (!isCall) check(t, object, id, "dueDate", blank(r.ActivityDate), v.dueDate);
        } else if (object === "Event") {
          check(t, object, id, "kind", "meeting", c.object);
          check(t, object, id, "title", blank(r.Subject) ?? "Meeting", v.title);
          check(t, object, id, "startAt", sfTime(r.StartDateTime), v.startAt);
          check(t, object, id, "endAt", r.EndDateTime ? sfTime(r.EndDateTime) : null, v.endAt);
          check(t, object, id, "location", blank(r.Location), v.location);
        } else {
          const body = String(v.body ?? "");
          check(t, object, id, "kind", "note", c.object);
          check(t, object, id, "title in body", true, body.includes(r.Title));
          if (object === "Note") check(t, object, id, "body", true, body.includes(r.Body));
          if (object === "ContentDocument" && r.FileType !== "SNOTE") check(t, object, id, "file link", true, body.includes(`${r.Title}.${r.FileExtension}`) && body.includes(id));
        }
      } else if (object === "Contact" || object === "Lead") {
        const p = c.contact;
        check(t, object, id, "name", r.Name, p.fullName);
        check(t, object, id, "email", blank(r.Email.toLowerCase()), p.email);
        check(t, object, id, "title", blank(r.Title), p.title);
        check(t, object, id, "company", object === "Lead" ? host(r.Website) ?? emailDomain(r.Email) : r.AccountId ? hostOf(r.AccountId) : emailDomain(r.Email), p.companyDomain);
      } else {
        const d = c.deal;
        const closed = r.IsClosed === "true";
        const won = closed && r.IsWon === "true";
        const forecast = closed ? (won ? "closed_won" : "closed_lost") : ({ Omitted: "omit", "Best Case": "best_case", Commit: "commit" } as Record<string, string>)[r.ForecastCategoryName] ?? "pipeline";
        check(t, object, id, "name", r.Name, d.name);
        check(t, object, id, "amount", r.Amount ? Math.round(Number(r.Amount) * 100) : null, d.amount);
        check(t, object, id, "currency", r.CurrencyIsoCode || "USD", d.currency);
        check(t, object, id, "closeDate", r.CloseDate, d.closeDate);
        check(t, object, id, "stage", r.StageName, d.stageLabel);
        if (r.RecordTypeId) check(t, object, id, "pipeline", processOf.get(r.RecordTypeId), d.pipeline);
        check(t, object, id, "probability", r.Probability ? Number(r.Probability) / 100 : null, d.probability);
        check(t, object, id, "forecastCategory", forecast, d.forecastCategory);
        check(t, object, id, "closed/won", [closed, won], [d.isClosed, d.isWon]);
        check(t, object, id, "owner", true, ownerOk(users.get(r.OwnerId) ?? "", r.OwnerId, d.ownerEmail, unmapped));
        check(t, object, id, "salesforceOwnerId", r.OwnerId, d.crmOwnerId);
        check(t, object, id, "company", r.AccountId ? hostOf(r.AccountId) : null, d.companyDomain);
        check(t, object, id, "createdAt", sfTime(r.CreatedDate), d.createdAt);
        for (const f of customDefs) {
          const raw = r[f.name];
          const expected = raw === "" ? null
            : ["double", "int", "percent"].includes(f.type) ? Number(raw)
            : f.type === "currency" ? Math.round(Number(raw) * 100)
            : f.type === "boolean" ? raw === "true"
            : f.type === "multipicklist" ? raw.split(";")
            : ["email", "phone", "url"].includes(f.type) ? [raw]
            : raw;
          check(t, object, id, f.name, expected, c.custom?.[f.label] ?? null);
        }
        const stages = stageHistoryOf.get(id) ?? [];
        check(t, object, id, "stage history", stages, (c.stageHistory ?? []).map((h: { at: number; stage: string }) => [h.at, h.stage]));
      }
    }
  }
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(`${pad("object", 24)}${pad("sampled", 9)}${pad("found", 7)}${pad("reported", 10)}${pad("missing", 9)}${pad("fields", 8)}${pad("wrong", 7)}result`);
  for (const t of tallies) {
    const ok = t.missing === 0 && t.mismatches === 0;
    console.log(`${pad(t.object, 24)}${pad(t.sampled, 9)}${pad(t.found, 7)}${pad(t.reported, 10)}${pad(t.missing, 9)}${pad(t.fieldsChecked, 8)}${pad(t.mismatches, 7)}${ok ? "PASS" : "FAIL"}`);
  }
  for (const m of mismatches.slice(0, 20)) console.log(`  ${m.object} ${m.sfId} ${m.field}: Salesforce ${JSON.stringify(m.salesforce)}, Canon ${JSON.stringify(m.canon)}`);
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), n: N, tallies, mismatches }, null, 2));
  process.exit(tallies.every((t) => t.missing === 0 && t.mismatches === 0) ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
