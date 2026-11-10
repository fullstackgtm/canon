/**
 * Prototype: read a Salesforce org through the `sf` CLI into a canonical snapshot for the account hierarchy manager.
 * Read-only: SELECTs and describes only. The hosted app reads through the org's own connection with the same
 * reader (engine/src/accountHierarchy/salesforceSnapshot.ts).
 *
 *   node --experimental-strip-types scripts/account-hierarchy/sf-snapshot.ts --org vidmob --policy <policy.json> --out .hierarchy/vidmob.json [--routes]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolvePolicy } from "../../engine/src/accountHierarchy/policy.ts";
import { readSalesforceSnapshot, stripAttributes, type SoqlRow } from "../../engine/src/accountHierarchy/salesforceSnapshot.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const org = arg("--org");
const out = arg("--out");
if (!org || !out) throw new Error("usage: sf-snapshot.ts --org <alias> --out <path> [--policy <path>] [--routes]");
const outPath = resolve(process.cwd(), out);
const policyPath = arg("--policy");
const policy = resolvePolicy(policyPath ? JSON.parse(readFileSync(resolve(process.cwd(), policyPath), "utf8")) : {});

function sf(args: string[]): unknown {
  const text = execFileSync("sf", [...args, "-o", org!, "--json"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(text) as { status: number; result?: unknown; message?: string };
  if (parsed.status !== 0) throw new Error(`sf ${args[0]} failed: ${parsed.message ?? "unknown error"}`);
  return parsed.result;
}

/** Only SELECT is ever sent. */
const query = async (soql: string): Promise<SoqlRow[]> => {
  if (!/^\s*select\s/i.test(soql)) throw new Error("read-only: only SELECT queries are allowed");
  return ((sf(["data", "query", "-q", soql]) as { records: SoqlRow[] }).records).map(stripAttributes);
};
const describe = async (sobject: string) => new Set(((sf(["sobject", "describe", "-s", sobject]) as { fields: Array<{ name: string }> }).fields).map((f) => f.name));

const started = Date.now();
const snapshot = await readSalesforceSnapshot(query, describe, policy);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`);
console.error(
  `${org}: ${snapshot.accounts.length} accounts, ${snapshot.contacts.length} contacts, ${snapshot.deals.length} opportunities, ` +
    `${snapshot.users.length} users in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${outPath}`,
);

// Vidmob routes leads by domain through Customer_Domain__c; other orgs don't have it.
if (process.argv.includes("--routes")) {
  const routes = await query("SELECT Domain__c, Account__c, Route_To__r.Name FROM Customer_Domain__c WHERE Account__c != null");
  const routesPath = outPath.replace(/\.json$/, ".routes.json");
  writeFileSync(routesPath, `${JSON.stringify(routes.map((r) => ({ domain: r.Domain__c, accountId: r.Account__c, routesTo: (r.Route_To__r as SoqlRow | null)?.Name ?? null })))}\n`);
  console.error(`${routes.length} domain routes -> ${routesPath}`);
}
