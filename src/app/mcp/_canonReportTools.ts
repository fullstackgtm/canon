/**
 * Canon tools for reports (CP9): run an aggregate over any object, and save,
 * share and run saved reports, as the Reports page does. Same Convex
 * functions, run as the caller.
 */
import { api } from "../../../convex/_generated/api.js";
import type { CanonTool } from "./_canonTools.ts";
import { recordObjectName, reportSource } from "../../../modules/kernel/reports.ts";
import { a, groupTool, m, q } from "./_canonJobTools.ts";

const SPEC = "spec: { object (\"deal\", \"account\", \"contact\", \"task\", a custom_<slug>...), filter: [{ field, op, value? }] (canon_list_records' filter grammar), groupBy: [{ field, via? (a lookup apiName such as \"companyId\", or \"accountId\" for a contact's company: the key is the related record's field), bucket? (\"day\" | \"week\" | \"month\" | \"quarter\", for dates; month by default) }] (0 to 2), measures: [{ fn: \"count\" } | { fn: \"sum\" | \"avg\" | \"min\" | \"max\", field (a number or currency field) }] (1 to 4), chart: \"table\" | \"bar\" | \"line\" | \"pie\" | \"number\" }";

const tools: CanonTool[] = [
  groupTool(
    "canon_reports",
    "Reports: group and measure any object's records, for example pipeline by stage (deal, groupBy stage, sum of amount) or companies by industry. Values come back per group, per first key (subtotals) and in total, one per measure; currency is in cents. A saved report is private until shared with the workspace.",
    {
      run: a(api.modules.report, `{ ${SPEC} } or { reportId } -> { groups: [{ keys, values }], subtotals, total, rows, truncated }`),
      list: q(api.modules.savedReports, "{} -> the caller's reports and the workspace's shared ones"),
      get: q(api.modules.savedReports, "{ reportId }"),
      create: m(api.modules.saveReport, `{ name, shared: boolean, ${SPEC} } -> reportId`),
      update: m(api.modules.saveReport, `{ reportId, name?, shared?, spec? } (its creator or an admin)`),
      remove: m(api.modules.removeReport, "{ reportId } (its creator or an admin)"),
      stage_history: a(api.modules.stageHistory, "{} -> { stages: [{ stage, entered, left, avgDays, medianDays, current, currentAvgDays }], byMonth: [{ month, stage, entered }], deals, partial } (from the ledger: every deal's stage changes since Canon first saw it)"),
    },
  ),
  groupTool(
    "canon_dashboards",
    "Dashboards: saved reports pinned in a grid, in order (a wide tile spans two columns). Read a dashboard's tiles, then run each with canon_reports run { reportId }. A shared dashboard holds only shared reports.",
    {
      list: q(api.modules.dashboards, "{} -> the caller's dashboards and the workspace's shared ones, each with tiles: [{ reportId, wide }]"),
      create: m(api.modules.saveDashboard, "{ name, shared: boolean, tiles?: [{ reportId, wide }] } -> dashboardId"),
      update: m(api.modules.saveDashboard, "{ dashboardId, name?, shared?, tiles? (the full ordered list) } (its creator or an admin)"),
      pin: m(api.modules.pinReport, "{ reportId, dashboardId? | name? (a new dashboard) } -> dashboardId"),
      remove: m(api.modules.removeDashboard, "{ dashboardId } (its creator or an admin)"),
      seed: m(api.modules.ensureShippedReports, "{} -> { created } (Reports' shipped reports and the Revenue and Activity dashboards; each once per workspace, never again once deleted)"),
    },
  ),
  groupTool(
    "canon_pacing",
    "Pacing against targets, as the Reports page shows it: what was booked (won deals by close date) or created (deals by created time) on each day of this month, quarter or year and of the periods before it, and the year's targets. A target is set top down: one number for the year, split into teams, reps and months like last year, evenly or by capacity; known amounts are locked and the rest rebalance. Amounts in cents.",
    {
      run: a(api.modules.pacing, "{ measure: \"booked\" | \"created\", grain: \"month\" | \"quarter\" | \"year\", compare: 0-8 (periods before this one) | \"yoy\", split?: a deal field such as \"ownerId\" or \"dealType\", or \"team\", filter: [{ field, op, value? }] (not closeDate, createdAt or isWon), teamIds?: [teamId] } -> { today, periods: [{ key, label, start, days }], shown: [periodKey] (newest first), series: [{ period, key (split value; null for the whole period), daily: [cents per day] }], approximate, teamNames, share, splitShare }"),
      targets: q(api.targets.get, "{ year } -> { plan: { total, coverage, months, teams, reps, repTeam, repMonths: { userId: [12 monthly cents] }, teamMonths } | null, roster: { teams, reps }, canEdit }"),
      history: a(api.targets.history, "{ year } -> { months: [12], reps: { userId: cents }, truncated } (won deals by close month and owner)"),
      set_targets: a(api.targets.set, "{ year, total (cents), coverage (pipeline target = bookings x this, e.g. 3), months: { method: \"history\" | \"even\" | \"custom\", custom?: [12 weights] }, teams: { method: \"history\" | \"even\", locks?: { teamId | \"none\": cents } }, reps: { method: \"history\" | \"capacity\" | \"even\", locks?: { userId: cents }, quarters?: { userId: [Q1, Q2, Q3, Q4 cents] }, profiles?: { userId: { start?: \"YYYY-MM-DD\", rampMonths? } } } } -> { total, teams, reps } (admins and managers; replaces the year's plan)"),
    },
  ),
];

const fallbackTools: Record<string, CanonTool> = {
  canon_reports: groupTool("canon_reports", "Canon fallback", {
    run: a(api.reports.run), list: q(api.reports.list), get: q(api.reports.get), create: m(api.reports.create),
    update: m(api.reports.update), remove: m(api.reports.remove), stage_history: a(api.stageHistory.run),
  }),
  canon_dashboards: groupTool("canon_dashboards", "Canon fallback", {
    list: q(api.dashboards.list), create: m(api.dashboards.create), update: m(api.dashboards.update),
    pin: m(api.dashboards.pin), remove: m(api.dashboards.remove), seed: m(api.templates.ensureDefaults),
  }),
  canon_pacing: groupTool("canon_pacing", "Canon fallback", { run: a(api.reportPacing.run) }),
};

export const canonReportTools: CanonTool[] = tools.map((tool) => ({
  ...tool,
  async run(convex, input) {
    const action = String(input.action);
    const args = { ...((input.args ?? {}) as Record<string, unknown>) };
    const targetRead = tool.name === "canon_pacing" && action !== "run";
    if (!targetRead) {
      const modules = await convex.query(api.modules.list, {});
      if (!modules.some((m) => m.moduleId === "@canon/reports" && m.reportsTakeover && m.nav)) return fallbackTools[tool.name].run(convex, input);
      args.module = "@canon/reports";
    }
    if (tool.name === "canon_reports") {
      if (args.spec && typeof args.spec === "object") {
        const spec = args.spec as Record<string, unknown>;
        const source = typeof spec.object === "string" ? reportSource(spec.object) : null;
        if (!source) throw new Error("That object has no Reports source.");
        args.spec = { ...spec, object: source };
      }
      if (["create", "update"].includes(action)) args.report = "deals";
      if (action === "get" || action === "list") {
        const reports = await convex.query(api.modules.savedReports, { module: "@canon/reports" });
        const summaries = reports.map(({ _id, name, shared, spec, mine, updatedAt, recipe }) => ({ _id, name, shared, spec: { ...spec, object: recordObjectName(spec.object) ?? spec.object }, mine, updatedAt, recipe }));
        return action === "list" ? summaries : summaries.find((r) => r._id === args.reportId) ?? null;
      }
    }
    if (tool.name === "canon_pacing" && action === "run") {
      args.id = "pace";
      args.source = args.measure;
      delete args.measure;
    }
    const result = await tool.run(convex, { ...input, args });
    return ["update", "remove"].includes(action) ? null : result;
  },
}));
