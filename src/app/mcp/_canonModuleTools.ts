/**
 * canon_module: an agent's way into the workspace's installed modules (docs/modules.md, "Agents"). The same Convex
 * functions a module page calls, run as the caller, so the module's read scopes and each op's roles and agent mode
 * apply unchanged.
 */
import { api } from "../../../convex/_generated/api.js";
import type { FunctionArgs } from "convex/server";
import { runModuleOp } from "../../lib/module-op.ts";
import type { CanonTool } from "./_canonTools.ts";
import { a, groupTool, m, q } from "./_canonJobTools.ts";

const moduleTools: CanonTool[] = [
  groupTool(
    "canon_module",
    "The workspace's modules: installed packages that add their own data (collections of docs) and pages to Canon. list shows the ones turned on; describe shows a module's collections (each a JSON Schema: a field whose shape depends on a sibling, such as a rule's config on its type, is an allOf of if/then; a ref field holds a member's, deal's, team's, company's, person's or doc's id), its views with their arguments, its ops with the fields they write, and its machines: a field such as status that only the machine's transitions change, each transition with the states it moves from and to, the roles that run it and its guards; and its calls, server functions that read what you can read, compute, and write; and its exports, CSV of a view or a call's rows. An op or transition with agent \"allowed\" runs as you; \"propose\" makes a patch plan a person approves on the Patch plans page and returns { proposed }; \"human\" refuses an agent and says why. An op or transition whose guard fails is refused with the guard's message; one marked system runs only as Canon. You read and write only the docs your person could. Name a module by its slug (from list) or its id.",
    {
      list: q(api.modules.list, "{} -> [{ moduleId, slug, title, description, version, nav, autoUpgrade: { version, newReads, at } | null }]"),
      describe: q(api.modules.describe, "{ module } -> { collections, views: { <name>: { kind: list | one, collection, args } }, ops: { <name>: { label, kind: create | update | delete, collection, fields, roles, agent, needs } } }"),
      view: q(api.modules.view, "{ module, view, args?: { <arg>: string | number | boolean | a list of strings or numbers } } -> [{ key, version, data, owner, parentKey, createdAt, updatedAt }] for a list, or one doc or null"),
      records: a(api.modules.records, "{ module, to: companies | people, ids?: [record ids], search?: text, company?: company id for a people picker } -> [{ id, label, ...grantedFields }]: the companies or people you can see, named by ids or searched for a ref field"),
      op: m(api.modules.op, "{ module, op, data?: { <field>: value }, unset?: [optional fields an update removes], key? (update, delete), expect? (the version you read; refused if it changed), parentKey? (a create in a set collection) } -> { key, version } or { key, deleted: true } or { proposed: patchPlanId }"),
      call: a(api.modules.call, "{ module, call, args?: { <arg>: value } } -> { writes, proposed: [patchPlanId], value? }: runs one of the module's server functions as you (describe lists them with their args, reads and the collections they write); its writes apply all or none, and a transition it returns that needs approval comes back in proposed"),
      sequence_variables: a(api.sequenceVariables.review, "{ module: sequences, key: sequence key } -> { recipients, samples, failures, ready, token }: normalized variable samples for five real recipients and every failing recipient. Fix failures or explicitly finish their enrollments before launch. A human launch passes the ready token in transition args.__variableReview within two minutes."),
      transition: m(api.modules.transition, "{ module, machine, name, key, expect (the version you read), args?: { <arg>: value }, reason? } -> { key, version, state } or { proposed: patchPlanId }; refused with the guard's message when one fails"),
      export: a(api.modules.exportCsv, "{ module, export, args?: { <arg>: value } } -> { filename, csv, rows }: one of the module's exports (describe lists them) as CSV text, its rows as you read them, money as 1234.50 and dates as YYYY-MM-DD"),
      export_file: a(api.modules.exportFile, "{ module, export, args?, format: csv | xlsx | pdf } -> { filename, contentType, base64, rows }: an export as a file, CSV, an Excel workbook whose money, numbers and dates are typed cells, or (an export with a pdf page) one PDF of each doc its rows name"),
      pdf: a(api.modules.pagePdf, "{ module, path: [segments of the page's path, as \"visits\", \"<key>\"], query?: { <URL parameter>: value }, filename?, timeZone? (IANA, for times) } -> { filename, contentType, base64, pages }: a page of the module as a PDF, what printing it prints, as you read it"),
      file: q(api.modules.fileUrl, "{ module, collection, key, file (the file id a file field holds) } -> { name, type, bytes, url } or null: a file a doc you read holds, with a link to download it (anyone holding the link can; it is handed only to a reader of the doc)"),
      bulk_status: q(api.modules.bulkStatus, "{ module, machine, key } -> [{ via, label, state: moving | stopped, refused: [{ key, title, message }], count, canRetry }] or null: the bulk moves a doc waits on (a period paying its statements); a stopped one names the docs that refused, and the doc stays where it waits until they move"),
      retry_bulk: m(api.modules.retryBulk, "{ module, machine, transition (the move's via), key } -> { retried: true }: runs a stopped bulk move again once the docs that refused are fixed, as your person, who must be able to run that transition"),
      verify: q(api.modules.verify, "{ module, collection, key } -> { state: intact | changed | unsealed, seal } or null: whether a sealed doc (a locked statement) still matches the seal Canon stored when it was sealed; changed means a field or a line item it covers changed since"),
      pacing_context: q(api.modules.pacingContext, "{ module, id } -> { sources, plans, roster, fyStart, userId, role }: the declared pacing sources and fiscal target plans you may read"),
      pacing: a(api.modules.pacing, "{ module, id, source, grain: month | quarter | year, compare: 0..8 | yoy, split?: field | team, filter: [], teamIds?: [] } -> { today, fyStart, periods, shown, series, approximate, teamNames, share, splitShare }: caller-visible daily sums for pacing and its historical curve; money is in minor units"),
      report: a(api.modules.report, "{ module, reportId? (a saved report, from saved_reports), spec?: { object: <collection with a report, or a Canon source its reads grant: canon.deals, canon.members, canon.stageHistory, canon.companies, canon.people, canon.leads, canon.activities, canon.tasks, canon.calls, canon.meetings, canon.notes, canon.products, canon.custom_<slug>>, filter: [{ field, op, value? }], groupBy: [{ field, bucket?: day | week | month | quarter }] (at most 2), measures: [{ fn: count | sum | avg | min | max, field? }] (1 to 4), chart: table | bar | line | pie | number } } -> { groups: [{ keys, values }], subtotals, total, rows, truncated, fields, behind }: a report over every doc of the collection you can read (describe lists each collection's report dimensions and measures, and its pages' reports and their sources; a Canon source's fields come back as `fields`, as your role shows them); money is in minor units; behind means some changes are still reaching it"),
      retry_reports: m(api.modules.retryReports, "{ module, collection } -> null: as a reader of a declared collection report, retry bounded stopped report projection jobs; source documents and receipt completion stay unchanged"),
      saved_reports: q(api.modules.savedReports, "{ module, report? } -> [{ _id, name, shared, report, spec, mine }]: the saved versions of the module's reports you can see, yours and the ones shared with the workspace"),
      save_report: m(api.modules.saveReport, "{ module, report (a report id from describe), name?, shared?, spec?, reportId? (to change one you saved) } -> reportId: saves a version of one of the module's reports, yours until shared with the workspace"),
      remove_report: m(api.modules.removeReport, "{ module, reportId } -> null: deletes a saved report you made"),
      dashboards: q(api.modules.dashboards, "{ module } -> [{ _id, name, shared, tiles: [{ reportId, wide }], mine, canChange }]: your own and workspace-shared dashboards of this module"),
      save_dashboard: m(api.modules.saveDashboard, "{ module, dashboardId?, name?, shared?, tiles?: [{ reportId, wide }] } -> dashboardId: creates or edits a module dashboard; only its owner or a moderator of a shared one can edit it; shared dashboards require shared reports, all from this module and workspace"),
      remove_dashboard: m(api.modules.removeDashboard, "{ module, dashboardId } -> null: deletes a dashboard you own or a shared one you may moderate"),
      pin_report: m(api.modules.pinReport, "{ module, reportId, dashboardId?, name? (for a new private dashboard) } -> dashboardId: pins a saved report to an editable dashboard of the same module, up to 24 tiles"),
      notifications: q(api.notifications.list, "{ module?, limit? } -> { unread, items: [{ id, message, link, at, read, moduleId }] }: your person's in-app notifications, newest first (a module's transitions and jobs send them), one module's only when you name it"),
      outbox: q(api.outbound.outbox, "{ module, about? (\"<collection>/<key>\": what one doc caused), states? } -> [{ id, at, channel: email | slack | webhook, to, subject, text, state, reason, error, providerId }]: what the module sent or will send that your person sees (docs/modules.md, \"Outbound\"); approving, cancelling or sending one now is a person's, on the module's page"),
      email_choice: m(api.outbound.setEmailChoice, "{ moduleId, mode: instant | digest | off } -> null: how your person wants a module's notices emailed: each one as it happens, a daily digest, or not at all"),
      mark_read: m(api.notifications.markRead, "{ ids?: [notification id], all?: true } -> how many it marked read: your person's notifications, the ones named or all"),
      preview_install: a(api.modules.previewInstall, "{ source: \"github:owner/repo[/path]@ref\" } -> what installing it would add: its collections, pages and ops (installs nothing; installing and turning a module on are for an admin or manager on the Customization page)"),
    },
  ),
];

export const canonModuleTools: CanonTool[] = moduleTools.map((tool) => ({
  ...tool,
  run: (client, input) => input.action === "op"
    ? runModuleOp(client, (input.args ?? {}) as FunctionArgs<typeof api.modules.op>)
    : tool.run(client, input),
}));
