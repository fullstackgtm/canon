import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api.js";
import type { Metrics } from "./perf-impact.ts";

const run = promisify(execFile);
type Ref<P extends string> = P extends `${infer M}:${infer F}` ? M extends keyof typeof api ? F extends keyof typeof api[M] ? typeof api[M][F] : never : never : never;
type Result<P extends string> = Ref<P> extends FunctionReference<"query" | "action"> ? FunctionReturnType<Ref<P>> : never;
type Json = Record<string, unknown>;
type Fixture = { accountId: string; contactId: string; accountStream: string; contactStream: string; dealId: string; domain: string };

export async function measurePages(): Promise<Metrics> {
  const ports = Object.fromEntries((await readFile(".devstack/ports.env", "utf8")).trim().split("\n").map((line) => line.split("=")));
  const backend = `http://127.0.0.1:${Number(ports.CONVEX_PORT)}`;
  const service = `http://127.0.0.1:${Number(ports.RECORD_SERVICE_PORT)}`;
  if (!ports.DEVSTACK_SANDBOX_HOME || !Number(ports.CONVEX_PORT) || !Number(ports.RECORD_SERVICE_PORT)) throw new Error("Start this worktree's local stack first");
  const { stdout } = await run("env", ["-u", "CONVEX_DEPLOYMENT", `HOME=${ports.DEVSTACK_SANDBOX_HOME}`, "CONVEX_AGENT_MODE=anonymous", "./node_modules/.bin/convex", "run", "devPerfSeed:seed", "{}"], { maxBuffer: 1024 * 1024 });
  const fixture: Fixture = JSON.parse(stdout);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${backend}/api/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "activityTargets:forRecord", args: { object: "account", id: fixture.accountId }, format: "json" }) });
    const result = await response.json();
    if (!response.ok || result.status !== "success") throw new Error("Perf projection warmup failed");
    if (result.value.activities.length === 40) break;
    if (attempt >= 120) throw new Error("Perf fixture must project all 40 activities before measuring");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const config = JSON.parse(await readFile(".convex/local/default/config.json", "utf8"));
  if (config.ports.cloud !== Number(ports.CONVEX_PORT)) throw new Error("Local backend port mismatch");
  const adminHeaders = { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" };
  const envResponse = await fetch(`${backend}/api/query`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ path: "_system/cli/queryEnvironmentVariables:get", args: { name: "RECORD_SERVICE_URL" }, format: "json" }) });
  const original = await envResponse.json();
  if (!envResponse.ok || original.value?.value !== service) throw new Error("Record service must point at this worktree's local service");
  const metrics: Metrics = {};
  const calls: Array<{ page: string; kind: string; path: string; args: Json; jsonBytes: number }> = [];
  let active = "";
  const proxy = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const response = await fetch(`${service}${req.url}`, { method: req.method, headers: { authorization: String(req.headers.authorization ?? ""), "content-type": "application/json", "x-workspace-id": String(req.headers["x-workspace-id"] ?? "") }, body: Buffer.concat(parts) });
      const body = Buffer.from(await response.arrayBuffer());
      if (active) {
        const key = `${active}.recordService.${req.url?.replace(/\/v1\/workspaces\/[^/]+/, "")}.jsonBytes`;
        metrics[key] = (metrics[key] ?? 0) + body.length;
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(body);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Proxy not listening");
  async function serviceUrl(value: string) {
    const response = await fetch(`${backend}/api/update_environment_variables`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ changes: [{ name: "RECORD_SERVICE_URL", value }] }) });
    if (!response.ok) throw new Error(`Local environment update failed (${response.status})`);
  }
  async function call<P extends string>(page: string, kind: "query" | "action", path: P, args: Json = {}): Promise<Result<P>> {
    active = `page.${page}`;
    const response = await fetch(`${backend}/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, args, format: "json" }) });
    const envelope = await response.json();
    if (!response.ok || envelope.status !== "success") throw new Error(`${path}: ${JSON.stringify(envelope)}`);
    const jsonBytes = Buffer.byteLength(JSON.stringify(envelope.value));
    const key = `page.${page}.convex.${path}.jsonBytes`;
    metrics[key] = (metrics[key] ?? 0) + jsonBytes;
    calls.push({ page, kind, path, args, jsonBytes });
    return envelope.value;
  }
  const { accountId, contactId, accountStream, contactStream, dealId, domain } = fixture;
  const byId = (object: string, id: string) => ({ object, filter: [{ field: "id", op: "eq", value: id }], limit: 1 });
  try {
    await serviceUrl(`http://127.0.0.1:${address.port}`);
    for (const [page, object, id, streamId] of [["account", "account", accountId, accountStream], ["person", "contact", contactId, contactStream], ["deal", "deal", dealId, dealId]]) {
      const q = <P extends string>(path: P, args: Json = {}) => call(page, "query", path, args);
      const a = <P extends string>(path: P, args: Json = {}) => call(page, "action", path, args);
      async function panels(modules: Result<"modules:contributions">) {
        for (const m of modules ?? []) for (const panel of m.panels ?? []) {
          const view = await q("modules:page", { module: m.module, path: panel.path.split("/"), query: { record: m.record ?? id }, limits: {} });
          if (!view || !("loads" in view)) throw new Error("Perf module panel must be ready");
          if (object !== "deal") await q("objects:describe", { object: "deal" });
          for (const load of Object.values(view.loads)) await a("modules:call", { module: m.module, call: load.call, args: load.args });
          if (view.recordRefs.companies.length || view.recordRefs.people.length) throw new Error("Extend perf manifest for new module record references");
        }
      }
      const desc = await q("objects:describe", { object });
      if (!desc) throw new Error(`Missing object definition ${object}`);
      await q("users:list");
      if (object !== "deal") {
        await q("permissions:mine");
        await q("recipes:recordPage", { object });
        const modules = await q("modules:contributions", { page: object === "account" ? "company" : "person", record: id });
        await panels(modules);
        const row = await a("objects:list", byId(object, id));
        if (!row.rows.length) throw new Error(`Missing perf ${object}`);
      } else {
        if (!await q("objects:get", { streamId })) throw new Error("Perf deal must exist");
        const recipe = await q("recipes:forOrg");
        if (recipe?.canEdit) await q("workspaceRecipes:markdown", { recipeId: recipe.dealPage.id });
        if (desc.fields.some((f: { type: string }) => f.type === "splits")) await q("objects:splitMembers", { streamId });
        const plane = await a("dealPlays:get", { streamId });
        if (plane) {
          await a("dealPlays:list");
          await q("dealChats:list", { streamId });
          await q("dataModel:objects");
          await q("chatgptAuth:status");
          await q("credits:summary");
          await q("icpsInterface:list");
          await a("dealPlays:rankProspects", { streamId });
        }
        await q("dealGaps:forDeal", { streamId });
        await q("dealLineItems:forDeal", { deal: streamId });
        const modules = await q("modules:contributions", { page: "deal", record: id });
        await panels(modules);
        await a("dealCommittee:forDeal", { streamId });
        await a("objects:list", byId("account", accountId));
      }
      await q("objects:history", { streamId, paginationOpts: { numItems: 25, cursor: null } });
      await q("automations:labels");
      await a("activityTargets:forRecord", { object, id });
      await a("conversationView:forRecord", { object, id });
      if (object !== "deal") {
        await a("associations:related", { object, id });
        await q("customObjects:list");
      }
      if (object === "account") {
        const detail = await a("records:get", { id });
        if (!detail || detail.contacts.length !== 20) throw new Error("Perf fixture must contain 20 contacts");
        await a("companyWebFacts:forAccount", { accountId: id });
        await q("icpVersions:list");
        await q("icpsInterface:list");
        await q("canonEntities:fitCitations", { recordId: id });
        await q("signals:log", { domain });
        await q("signals:forAccount", { domain });
        await q("observations:firstLinkedin", { contactIds: detail.contacts.map((c: { id: string }) => c.id) });
        const deals = await q("deals:forCompany", { companyId: id, domain, stream: accountStream });
        if (deals?.length !== 12) throw new Error("Perf fixture must contain 12 related deals");
        await q("objects:describe", { object: "deal" });
        await a("dealCommittee:forCompany", { companyId: id, domain, stream: accountStream });
      } else {
        const fields = await q("researchAgents:list");
        const agents = (fields?.agents ?? []).filter((f: { entityType: string }) => f.entityType === "contact");
        if (agents.length && object === "contact") await q("researchAgents:contactAnswers", { slugs: agents.map((f: { slug: string }) => f.slug), recordIds: [contactId] });
        if (object === "contact") {
          await q("observations:forContact", { contactId });
          await q("dialer:overview");
          await q("dialer:contactCalls", { contactId });
          await q("emailAccounts:mine");
          await a("objects:list", byId("account", accountId));
        } else await a("associations:related", { object: "account", id: accountId });
      }
      const entries = Object.entries(metrics).filter(([key]) => key.startsWith(`page.${page}.`));
      metrics[`page.${page}.total.jsonBytes`] = entries.filter(([key]) => key.includes(".convex.")).reduce((n, [, bytes]) => n + bytes, 0);
      metrics[`page.${page}.recordServiceTotal.jsonBytes`] = entries.filter(([key]) => key.includes(".recordService.")).reduce((n, [, bytes]) => n + bytes, 0);
    }
    await writeFile(".devstack/perf-impact-calls.json", JSON.stringify(calls, null, 2) + "\n");
    return metrics;
  } finally {
    active = "";
    try { await serviceUrl(service); } finally {
      await new Promise<void>((resolve, reject) => proxy.close((err) => err ? reject(err) : resolve()));
    }
  }
}
