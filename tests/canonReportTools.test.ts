import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { canonReportTools } from "../src/app/mcp/_canonReportTools.ts";

test("Canon report tool aliases preserve arguments and use the authenticated module endpoints", async () => {
  const calls: Array<[string, unknown]> = [];
  let enabled = true;
  let reportsTakeover = true;
  const call = async (ref: Parameters<typeof getFunctionName>[0], args: unknown) => { if (getFunctionName(ref) === "modules:list") return enabled ? [{ moduleId: "@canon/reports", nav: {}, reportsTakeover }] : []; calls.push([getFunctionName(ref), args]); return []; };
  const client = { query: call, mutation: call, action: call } as never;
  const tool = (name: string) => canonReportTools.find((t) => t.name === name)!;
  await tool("canon_reports").run(client, { action: "run", args: { spec: { object: "deal", filter: [], groupBy: [], measures: [{ fn: "count" }], chart: "number" } } });
  await tool("canon_reports").run(client, { action: "create", args: { name: "Mine", shared: false, spec: { object: "custom_project" } } });
  await tool("canon_dashboards").run(client, { action: "pin", args: { reportId: "saved", dashboardId: "board" } });
  await tool("canon_pacing").run(client, { action: "run", args: { measure: "booked", grain: "quarter", compare: 3, filter: [] } });
  reportsTakeover = false;
  await tool("canon_reports").run(client, { action: "list" });
  await tool("canon_dashboards").run(client, { action: "list" });
  await tool("canon_pacing").run(client, { action: "run", args: { measure: "booked" } });
  enabled = false;
  await tool("canon_reports").run(client, { action: "run", args: { reportId: "saved" } });
  assert.deepEqual(calls, [
    ["modules:report", { module: "@canon/reports", spec: { object: "canon.deals", filter: [], groupBy: [], measures: [{ fn: "count" }], chart: "number" } }],
    ["modules:saveReport", { module: "@canon/reports", report: "deals", name: "Mine", shared: false, spec: { object: "canon.custom_project" } }],
    ["modules:pinReport", { module: "@canon/reports", reportId: "saved", dashboardId: "board" }],
    ["modules:pacing", { module: "@canon/reports", id: "pace", source: "booked", grain: "quarter", compare: 3, filter: [] }],
    ["reports:list", {}],
    ["dashboards:list", {}],
    ["reportPacing:run", { measure: "booked" }],
    ["reports:run", { reportId: "saved" }],
  ]);
});
