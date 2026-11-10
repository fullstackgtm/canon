import { DuckDBInstance } from "@duckdb/node-api";
import { classifyCompanies, classifyCompaniesFast } from "../src/jev/classifyCompanies.ts";
import { usage, costUsd } from "../src/jev/client.ts";
import { writeFileSync } from "node:fs";
const N = Number(process.argv[2] ?? 1000);
const db = await DuckDBInstance.create(process.env.HOME + "/.fullstackgtm/data/pdl_companies.duckdb", { access_mode: "READ_ONLY" });
const c = await db.connect();
// Deterministic sample across the whole corpus (stable hash), incl. companies with no industry.
const rows = (await c.runAndReadAll(`SELECT domain, name, industry, sizeBand, country, locality FROM companies ORDER BY hash(domain || 'jev-sample-v1') LIMIT ${N}`)).getRowObjects() as any[];
const t0 = performance.now();
const tags = await (process.env.MODE === "two-stage" ? classifyCompanies(rows) : classifyCompaniesFast(rows));
const secs = (performance.now() - t0) / 1000;
writeFileSync(process.env.OUT ?? "/tmp/cls-sample.json", JSON.stringify(rows.map((r, i) => ({ ...r, ...tags[i] }))));
const perCo = usage.inputTokens / N;
console.log(JSON.stringify({ companies: N, requests: usage.requests, retries: usage.retries, inputTokens: usage.inputTokens, tokensPerCompany: Math.round(perCo), costUsd: Number(costUsd(usage.inputTokens).toFixed(4)), secs: Math.round(secs * 10) / 10, companiesPerSec: Math.round(N / secs) }));
console.log(JSON.stringify({ projectedFullCorpus: { companies: 23829494, costUsd: Math.round(costUsd(perCo * 23829494)), hoursAt90kTps: Math.round((perCo * 23829494) / 90000 / 3600 * 10) / 10 } }));
