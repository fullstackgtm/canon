import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHubspotConnector, type HubspotSyncObject } from "../engine/src/connectors/hubspot.ts";
import { fakeHubspotFetch, scaledPortal, touchRecords } from "../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";
import { mappingsKey, planHubspotSync } from "../convex/lib/hubspotSyncPlan.ts";
import { mirrorAccount, mirrorContact, mirrorDeal } from "../convex/lib/hubspotMirror.ts";
import { accountSyncValue, contactSyncValue, dealSyncHash, dealSyncValue, accountUnchanged, contactUnchanged, dealUnchanged } from "../convex/lib/hubspotSyncValue.ts";
import { planSlices, sliceRanks, readSlicePage } from "../convex/lib/hubspotSlices.ts";
import type { Id } from "../convex/_generated/dataModel";
import { prefetchPages, writeInOrder } from "../convex/lib/pagePrefetch.ts";
import { generateDataset, startFakeSalesforce } from "../engine/src/sync/salesforceImport/testing/fakeSalesforce.ts";
import { soql } from "../engine/src/sync/salesforceImport/sfClient.ts";


export type Metrics = Record<string, number>;
export const BASELINE = new URL("../perf/baseline.json", import.meta.url);


function meteredFetch(fetchImpl: typeof fetch, metrics: Metrics, prefix: string): typeof fetch {
  return async (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const response = await fetchImpl(input, init);
    const responseBytes = (await response.clone().arrayBuffer()).byteLength;
    for (const name of [prefix, `${prefix}.endpoint.${endpoint}`]) {
      metrics[`${name}.httpCalls`] = (metrics[`${name}.httpCalls`] ?? 0) + 1;
      metrics[`${name}.responseBytes`] = (metrics[`${name}.responseBytes`] ?? 0) + responseBytes;
    }
    if (!response.ok) throw new Error(`${prefix} ${endpoint} returned ${response.status}`);
    return response;
  };
}

export async function measureImpact(): Promise<Metrics> {
  const metrics: Metrics = {};
  const portal = scaledPortal(300); // 1,520 core CRM records, plus unused engagement fixtures.
  const stored = new Map<string, Record<string, unknown>>();
  const key = mappingsKey({});
  const start = Date.parse("2026-10-01T12:00:00Z");
  let cursors: { modifiedSince: number; fullSyncAt: number; mappingsKey: string } | null = null;
  for (const [scenario, now] of [["full", start], ["fullRepeat", start + 15_000], ["incremental", start + 60_000], ["noChange", start + 120_000]] as const) {
    if (scenario === "incremental") {
      // touchRecords touches the same count per type; trim each type to exactly floor(1%).
      for (const object of ["companies", "contacts", "deals"] as const) {
        touchRecords({ ...portal, objects: { [object]: portal.objects[object] } }, Math.floor(portal.objects[object].length / 100), new Date(start + 30_000));
      }
    }
    const prefix = `sync.hubspot.${scenario}`;
    const connector = createHubspotConnector({ getAccessToken: () => "fixture", fetchImpl: meteredFetch(fakeHubspotFetch(portal), metrics, prefix), sleep: async () => {} });
    const plan = planHubspotSync(cursors, { hasCounts: cursors !== null, mappingsKey: key, now, full: scenario === "fullRepeat" });
    const owners = (await connector.fetchUsers()).filter((user) => user.crmId && user.email);
    const ownerMap = Object.fromEntries(owners.map((user) => [user.crmId!, `users:${user.crmId}` as Id<"users">]));
    const accountMap: Record<string, Id<"crmAccounts">> = {};
    const objects = ["companies", "contacts", "deals"] as const satisfies readonly HubspotSyncObject[];
    const window = plan.mode === "incremental" ? { since: plan.since, until: now } : undefined;
    const totals = await Promise.all(objects.map((object) => connector.countRecords(object, window)));
    const bounds = plan.mode === "full"
      ? await Promise.all(objects.map((object, i) => connector.idsAtRanks(object, sliceRanks(totals[i]))))
      : [];
    metrics[`${prefix}.rowsRead`] = 0;
    metrics[`${prefix}.rowsWritten`] = 0;
    for (const [i, object] of objects.entries()) {
      const slices = plan.mode === "full" ? planSlices(bounds[i] ?? []) : [{ after: null, done: false, read: 0 }];
      for (const slice of slices) {
        let previousId: number | undefined;
        const pages = prefetchPages(slice.after, async (after) => {
          if (plan.mode === "incremental") return connector.readModifiedPage(object, { since: plan.since, until: now }, after);
          const page = await readSlicePage(slice, after, {
            list: (cursor) => connector.readPage(object, cursor),
            firstIdFrom: (from) => connector.firstIdFrom(object, from),
            previousId,
          });
          previousId = page.lastId;
          return page;
        }, { max: 3, until: Infinity });
        await writeInOrder({ next: pages.next, more: () => true, max: 3, commit: () => {}, write: async (page) => {
          for (const row of page.rows) {
            metrics[`${prefix}.rowsRead`]++;
            const id = `${object}:${row.crmId}`;
            const previous = stored.get(id) ?? null;
            const accountId = "accountId" in row && row.accountId && stored.has(`companies:${row.accountId}`)
              ? `crmAccounts:${row.accountId}` as Id<"crmAccounts"> : undefined;
            let value: Record<string, unknown>;
            let unchanged: boolean;
            if (object === "companies") {
              const mapped = mirrorAccount(row as Parameters<typeof mirrorAccount>[0], ownerMap);
              const next = accountSyncValue(previous, mapped, now);
              unchanged = accountUnchanged(previous, next);
              value = next;
            } else if (object === "contacts") {
              const mapped = mirrorContact(row as Parameters<typeof mirrorContact>[0], ownerMap, accountMap);
              const next = contactSyncValue(mapped, accountId, now);
              unchanged = contactUnchanged(previous, next);
              value = next;
            } else {
              const mapped = mirrorDeal(row as Parameters<typeof mirrorDeal>[0], ownerMap, accountMap, new Date(now).toISOString().split("T")[0]);
              const next = dealSyncValue(mapped, accountId, now);
              unchanged = dealUnchanged(previous, mapped, next);
              value = { ...next, syncHash: dealSyncHash(mapped, next) };
            }
            if (!unchanged) {
              metrics[`${prefix}.rowsWritten`]++;
              // Convex patches remove undefined fields and retain fields absent from the patch.
              stored.set(id, JSON.parse(JSON.stringify({ ...previous, crmId: row.crmId, createdAt: previous?.createdAt ?? now, ...value })));
            }
          }
        } });
      }
    }
    cursors = { modifiedSince: now, fullSyncAt: start, mappingsKey: key };
  }
  const sf = await startFakeSalesforce(generateDataset({ accounts: 400, contacts: 1200 }));
  try {
    const prefix = "sync.salesforce.full";
    const conn = { instanceUrl: sf.baseUrl, apiVersion: "60.0", getToken: async () => sf.token, fetchImpl: meteredFetch(fetch, metrics, prefix) };
    metrics[`${prefix}.rowsRead`] = 0;
    for (const [object, fields] of [["Account", "Id,Name,Website,Industry,NumberOfEmployees,BillingCountry"], ["Contact", "Id,AccountId,FirstName,LastName,Name,Title,Email"]]) {
      const result = await soql(conn, `SELECT ${fields} FROM ${object}`);
      metrics[`${prefix}.rowsRead`] += result.records.length;
    }
  } finally { await sf.stop(); }

  return Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b)));
}

export function compareImpact(metrics: Metrics, baseline: Metrics = {}) {
  return [...new Set([...Object.keys(metrics), ...Object.keys(baseline)])].sort().map((name) => {
    const value = metrics[name];
    const before = baseline[name];
    const missing = value === undefined || before === undefined;
    const delta = missing ? undefined : value - before;
    const percent = missing ? undefined : before === 0 ? value === 0 ? 0 : Infinity : (value - before) / before * 100;
    return { name, value, before, delta, percent, marker: missing || (percent !== undefined && (percent > 25 || percent < -10)) ? "FAIL" : percent !== undefined && percent > 10 ? "WARN" : "" };
  });
}

export function markdownReport(metrics: Metrics, baseline?: Metrics): string {
  return ["| Metric | Count | Baseline | Delta | Change | Status |", "| --- | ---: | ---: | ---: | ---: | --- |", ...compareImpact(metrics, baseline).map((r) => `| ${r.name} | ${r.value ?? "removed"} | ${r.before ?? "new"} | ${r.delta ?? ""} | ${r.percent === undefined ? "" : Number.isFinite(r.percent) ? `${r.percent.toFixed(2)}%` : "+∞%"} | ${r.marker} |`)].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  let baselinePath: string | URL | undefined;
  let output: string | undefined;
  let writeBaseline = false;
  let stack = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stack") stack = true;
    else if (args[i] === "--write-baseline") writeBaseline = true;
    else if (args[i] === "--baseline" || args[i] === "--output") {
      const flag = args[i], value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--baseline") baselinePath = value;
      else output = value;
    } else throw new Error(`Unknown option ${args[i]}`);
  }
  const metrics = await measureImpact();
  if (stack) Object.assign(metrics, await (await import("./perf-impact-stack.ts")).measurePages());
  const baseline: Metrics | undefined = baselinePath || writeBaseline || stack ? JSON.parse(await readFile(baselinePath ?? BASELINE, "utf8")) : undefined;
  const comparableBaseline = baseline && !stack ? Object.fromEntries(Object.entries(baseline).filter(([key]) => !key.startsWith("page."))) : baseline;
  const json = JSON.stringify(metrics, null, 2) + "\n";
  const markdown = markdownReport(metrics, comparableBaseline) + "\n";
  if (writeBaseline) {
    await mkdir(new URL("../perf/", import.meta.url), { recursive: true });
    const previous: Metrics = JSON.parse(await readFile(BASELINE, "utf8"));
    // Without --stack, keep the committed page metrics; the stack-free run cannot measure them.
    const retained = Object.fromEntries(Object.entries(previous).filter(([key]) => key.startsWith("page.") && !stack));
    const measured = metrics;
    await writeFile(BASELINE, JSON.stringify({ ...retained, ...measured }, null, 2) + "\n");
  }
  if (output) {
    await writeFile(`${output}.json`, json);
    await writeFile(`${output}.md`, markdown);
  }
  console.log(json + "\n" + markdown);
  if ((!writeBaseline && comparableBaseline && compareImpact(metrics, comparableBaseline).some((r) => r.marker === "FAIL")) || metrics["sync.hubspot.noChange.rowsWritten"] !== 0 || metrics["sync.hubspot.fullRepeat.rowsWritten"] !== 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
