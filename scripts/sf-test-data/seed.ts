/**
 * Seed the shared Salesforce test org with tagged import fixtures.
 *
 *   node --experimental-strip-types scripts/sf-test-data/seed.ts [--accounts 300 --contacts 900 --leads 300]
 *
 * Every record: Name/LastName starts with "FSGTMSYNC B " and Description
 * contains "fsgtm-sync-test b-import". Total is capped at MAX_RECORDS (1800)
 * including anything already tagged. Domains use the reserved .example TLD.
 * Shapes exercised by the import: 5% of accounts without Website (rejected),
 * 2% sharing another account's domain (rejected as duplicate domain), 3% of
 * contacts without Account (company-email fallback), 1% with free mail and no
 * Account (rejected), 7% of leads with free mail and no Website (rejected).
 */
import { MAX_RECORDS, NAME_PREFIX, DESCRIPTION_TAG, bulkInsert, connFromSfCli, taggedCounts } from "./lib.ts";

function arg(name: string, dflt: number) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
}

export const seedDomain = (i: number) => `fsgtmsync-b-${i}.example`;

async function main() {
  const nA = arg("accounts", 300);
  const nC = arg("contacts", 900);
  const nL = arg("leads", 300);
  const c = connFromSfCli();
  const before = await taggedCounts(c);
  const existing = before.Account + before.Contact + before.Lead;
  if (existing + nA + nC + nL > MAX_RECORDS) throw new Error(`refusing: ${existing} tagged already + ${nA + nC + nL} new > ${MAX_RECORDS}`);
  if (existing) throw new Error(`refusing: ${existing} tagged records already exist; run cleanup.ts first`);

  const accounts = Array.from({ length: nA }, (_, i) => ({
    Name: `${NAME_PREFIX}Account ${i}`,
    Website: i % 20 === 7 ? "" : i % 50 === 11 ? `https://${seedDomain(i - 1)}` : `https://www.${seedDomain(i)}/home`,
    Industry: ["Technology", "Retail", "Banking"][i % 3],
    NumberOfEmployees: 10 + i,
    BillingCountry: i % 2 ? "United States" : "Canada",
    Description: DESCRIPTION_TAG,
  }));
  const accountIds = await bulkInsert(c, "Account", ["Name", "Website", "Industry", "NumberOfEmployees", "BillingCountry", "Description"], accounts);

  const contacts = Array.from({ length: nC }, (_, i) => {
    const a = i % nA;
    const orphan = i % 33 === 5;
    const freeMail = i % 100 === 17;
    return {
      FirstName: `Fn${i}`,
      LastName: `${NAME_PREFIX}Contact ${i}`,
      AccountId: orphan || freeMail ? "" : accountIds[a],
      Email: freeMail ? `fsgtmsync.b.${i}@gmail.com` : orphan ? `p${i}@fsgtmsync-b-orphan-${i % 10}.example` : `p${i}@${seedDomain(a)}`,
      Title: i % 3 ? "VP Sales" : "",
      Description: DESCRIPTION_TAG,
    };
  });
  await bulkInsert(c, "Contact", ["FirstName", "LastName", "AccountId", "Email", "Title", "Description"], contacts);

  const leads = Array.from({ length: nL }, (_, i) => {
    const freeMail = i % 15 === 4;
    return {
      FirstName: `Ln${i}`,
      LastName: `${NAME_PREFIX}Lead ${i}`,
      Company: `${NAME_PREFIX}LeadCo ${i % 60}`,
      Website: freeMail || i % 3 === 0 ? "" : `fsgtmsync-b-lead-${i % 60}.example`,
      Email: freeMail ? `fsgtmsync.b.lead${i}@yahoo.com` : `l${i}@fsgtmsync-b-lead-${i % 60}.example`,
      Description: DESCRIPTION_TAG,
    };
  });
  await bulkInsert(c, "Lead", ["FirstName", "LastName", "Company", "Website", "Email", "Description"], leads);

  const after = await taggedCounts(c);
  console.log(JSON.stringify({ created: { Account: nA, Contact: nC, Lead: nL }, taggedNow: after }));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
