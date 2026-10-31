import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { ALLOWLIST } from "../scripts/visibility-allowlist.ts";

/**
 * Module data has one way in: convex/lib/modules/scope.ts (docs/modules.md, "The choke point"). The schema declares
 * its tables; nothing else may name them. Every public function in convex/modules.ts either builds its scope there
 * (a data surface) or touches no module data at all (install and enable), and is listed here as one or the other.
 */
const TABLES = /["'`](moduleDocs|moduleEvents|moduleFiles)["'`]/;
const ALLOWED = new Set(["convex/schema.ts", "convex/lib/modules/scope.ts", "convex/lib/modules/activityCapture.ts", "convex/lib/modules/activityPublication.ts"]);
/** A module's job keys and feed cursors: only jobs.ts, which scope.ts and convex/moduleJobs.ts call. */
const JOB_TABLES = /["'`](moduleJobs|moduleCursors)["'`]/;
const JOB_ALLOWED = new Set(["convex/schema.ts", "convex/lib/modules/jobs.ts"]);
/** convex/moduleJobs.ts: its queries and mutations build Canon's system scope (scopeIn); its actions reach data only through them. */
const JOB_DATA = ["lease", "stageKey", "applyKey", "finishEmpty", "failed", "bulkBatch", "initializeReports", "projectRead", "projectPage", "projectDone", "manifestFor", "feedPlan", "feedApply", "feedModules", "connectorFeedModules", "connectorItemsPlan", "connectorItemsApply", "timedDue", "sweep"];
const JOB_ACTIONS = ["run", "feed", "feedItems", "scheduled", "timed"];
const EPOCH_OUTPUTS = ["stageSet", "applyCall", "dryApply", "proposeCall", "dropGeneration", "aiFinish"];
const EPOCH_PLANS = ["callPlan", "callEpoch", "aiQueue", "aiCompletionPlan"];
const JOB_EPOCH_OUTPUTS = ["stageKey", "applyKey", "finishEmpty", "failed", "feedApply"];
const JOB_EPOCH_PLANS = ["lease", "manifestFor", "feedPlan"];
const EXECUTION_EXEMPTIONS = {
  op: "Single mutation, with the current manifest and document CAS.",
  transition: "Single mutation, with the current manifest and document CAS.",
  systemOp: "Single mutation, with the current manifest and document CAS.",
  systemTransition: "Single mutation, with the current manifest and document CAS.",
  migrationApply: "Already fenced by pending epoch, step, and cursor.",
  upgradeStep: "Already fenced by the pending epoch.",
  bulkBatch: "Host transition work in one mutation, with dirty sequence and document CAS.",
  projectRead: "Current document projection, without module code execution.",
  projectPage: "Current document projection, without module code execution.",
  projectDone: "Projection delivery completion uses dirty sequence, outside module code execution.",
};
const ROOTS = ["convex", "src", "modules", "scripts", "cli", "recipes"];
const SKIP = new Set(["_generated", "node_modules"]);

/** The functions that read or write module docs: each builds its scope with moduleScope. */
const DATA_SURFACES = ["callDispatch", "executeCanonCall", "issueLinkPlan", "issueLinkCommit", "links", "revokeLink", "extendLink", "previewShare", "describe", "view", "pick", "op", "applyOp", "recordGrants", "transition", "page", "callPlan", "callEpoch", "stageSet", "applyCall", "dropGeneration", "systemTransition", "systemOp", "exportPlan", "exportSource", "exportPdfPage", "verify", "devTamper", "devSeedDocs", "devUnseedDocs", "bulkStatus", "retryBulk", "pacingContext", "reportPlan", "retryReports", "reportInMemory", "reportMembers", "aggregatePlan", "aggregateInMemory", "reportLabels", "reportJoins", "refValues", "dashboards", "saveDashboard", "removeDashboard", "pinReport", "savedReports", "savedReportSpec", "saveReport", "removeReport", "ensureShippedReports", "uploadUrl", "fileUrl", "judge", "sendPreview", "suggest", "pickCall", "jobProgress", "contributions", "aiQueue", "aiCompletionPlan", "aiFinish", "dryApply", "proposeCall", "meetingProposalRows"];
/** Actions: no database of their own, so they read and write only through the data surfaces above (runCall). */
const ACTIONS = { prepareCanonSecret: /internal\.modules\.executeCanonCall/, issueLink: /requireCaller\(ctx\)[\s\S]*internal\.modules\.issueLinkPlan[\s\S]*resolveRoomAttribution[\s\S]*internal\.modules\.issueLinkCommit/, writeOp: /admitRecords\(ctx, \(admit\) => ctx\.runMutation\(internal\.modules\.applyOp/, records: /internal\.modules\.recordGrants[\s\S]*recordReader\(ctx\)/, call: /runCall\(/, systemCall: /runCall\(/, aiRun: /runCall\(/, exportCsv: /exportTable\(/, exportFile: /exportTable\(/, stageHistory: /internal\.modules\.reportPlan[\s\S]*readStageHistory\(ctx, plan\.orgId\)/, pacing: /api\.modules\.pacingContext[\s\S]*callerClient\(ctx, caller\)/, report: /runMetrics\(/, pagePdf: /printedPage\(/ };
/**
 * Module reports read the record service's module docs only through runReport, whose scope comes from reportPlan
 * (scope.ts reportPlan, the one place a report's scope is made); only the job runner sends docs there.
 */
const REPORT_READS = /\bmoduleAggregate\(/;
const REPORT_READ_ALLOWED = new Set(["convex/modules.ts", "convex/lib/recordClient.ts"]);
const REPORT_WRITES = /\bmoduleSync\(/;
const REPORT_WRITE_ALLOWED = new Set(["convex/moduleJobs.ts", "convex/lib/recordClient.ts"]);
const RUN_REPORT = /internal\.modules\.reportPlan[\s\S]*docScope: plan\.docScope[\s\S]*internal\.modules\.reportInMemory/;
const RUN_CALL = /internal\.modules\.callPlan[\s\S]*internal\.modules\.applyCall/;
/**
 * A team aggregate reads every doc, so its value is made in one place (docs/modules.md, "Team aggregates"): runAggregate
 * asks for groups by owner, and returns only what teamAggregate folds of them, withheld below its owners.
 */
const RUN_AGGREGATE = /internal\.modules\.aggregatePlan[\s\S]*docScope: null[\s\S]*internal\.modules\.aggregateInMemory[\s\S]*return teamAggregate\(/;
/** Install and upgrade: they reach module docs only through scope.ts's upgrade functions (hasDocs, upgradeBatch, migrations'). */
const UPGRADES = {
  storeModule: /\bapplyModule\(/, upgradeStep: /\bupgradeBatch\(/, migrationRead: /\bmigrationBatch\(/, migrationApply: /\bapplyMigration\(/,
  installShipped: /\bsystemScope\(/,
  importBatch: /\bsystemScope\([\s\S]*scope\.importDocs\(/, importStep: /internal\.modules\.importBatch/,
  resumeImports: /\bsystemScope\([\s\S]*startImports\(/,
  upgradeMigrate: /internal\.modules\.migrationRead[\s\S]*internal\.modules\.migrationApply/,
};
/** The functions that read only modulePackages and recipeEnablements: no module docs. */
/** Uploads: the route's ticket check and record, through scope.ts's own functions (no caller: the ticket is the capability). */
const UPLOADS = { uploadTicket: /\bticketOpen\(/, recordUpload: /\brecordUploadOf\(/ };
const PACKAGE_ONLY = ["list", "examples", "installed", "installState", "previewInstall", "install", "installFromLocalBase", "setEnabled", "uninstall", "cancelUpgrade"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

test("only moduleScope names the module data tables, and every module function is a listed surface", () => {
  const root = process.cwd();
  const offenders = ROOTS.flatMap((r) => files(join(root, r))).map((p) => relative(root, p)).filter((p) => !ALLOWED.has(p) && TABLES.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders, [], "module docs are read and written only through convex/lib/modules/scope.ts");
  const jobOffenders = ROOTS.flatMap((r) => files(join(root, r))).map((p) => relative(root, p)).filter((p) => !JOB_ALLOWED.has(p) && JOB_TABLES.test(readFileSync(p, "utf8")));
  assert.deepEqual(jobOffenders, [], "job keys and feed cursors are read and written only through convex/lib/modules/jobs.ts");

  const jobs = readFileSync(join(root, "convex/moduleJobs.ts"), "utf8");
  const jobExports = [...jobs.matchAll(/^export const (\w+) = (?:query|mutation|action|internalQuery|internalMutation|internalAction)\(/gm)].map((m) => m[1]);
  assert.deepEqual(jobExports.filter((n) => !JOB_DATA.includes(n) && !JOB_ACTIONS.includes(n)), [], "a new function in convex/moduleJobs.ts is listed here");
  const jobBody = (name: string) => jobs.slice(jobs.indexOf(`export const ${name} = `)).split(/^export const /m)[1];
  for (const name of JOB_DATA) assert.match(jobBody(name), /\bscopeIn\(/, `${name} builds Canon's scope`);
  for (const name of JOB_ACTIONS) assert.doesNotMatch(jobBody(name), /ctx\.db\b/, `${name} is an action: no database of its own`);

  const source = readFileSync(join(root, "convex/modules.ts"), "utf8");
  const exported = [...source.matchAll(/^export const (\w+) = (?:query|mutation|action|internalQuery|internalMutation|internalAction)\(/gm)].map((m) => m[1]);
  assert.deepEqual(exported.filter((name) => !DATA_SURFACES.includes(name) && !PACKAGE_ONLY.includes(name) && !Object.hasOwn(ACTIONS, name) && !Object.hasOwn(UPGRADES, name) && !Object.hasOwn(UPLOADS, name)), [], "a new function in convex/modules.ts is listed here as a data surface, an action, an upgrade or a package-only one");
  const body = (name: string) => source.slice(source.indexOf(`export const ${name} = `)).split(/^export const /m)[1];
  for (const name of DATA_SURFACES) assert.match(body(name), name === "contributions" ? /\bmoduleScopeCaller\(/ : /\b(moduleScope|scopeOrRefuse)\(/, `${name} builds its scope with moduleScope`);
  for (const name of EPOCH_OUTPUTS.filter((n) => n !== "aiFinish")) {
    assert.match(body(name), /epoch: v\.number\(\)/, `${name} requires the execution epoch`);
    assert.match(body(name), /scopeOrRefuse\([^\n]+(?:args|a)\.epoch(?:, (?:args|a)\.admit)?\)/, `${name} checks the epoch on its scope`);
  }
  for (const name of EPOCH_PLANS) assert.match(body(name), /epoch/, `${name} carries the execution epoch`);
  assert.match(body("aiFinish"), /epoch: v\.number\(\)[\s\S]*scope\.epoch !== a\.epoch/, "AI completion requires its original epoch");
  for (const name of JOB_EPOCH_PLANS) assert.match(jobBody(name), /epoch: scope\.epoch/, `${name} returns its scope epoch`);
  for (const name of JOB_EPOCH_OUTPUTS) assert.match(jobBody(name), /epoch: v\.number\(\)[\s\S]*scope\.epoch !== a\.epoch/, `${name} requires and checks its original epoch`);
  for (const [name, reason] of Object.entries(EXECUTION_EXEMPTIONS)) {
    assert.ok(exported.includes(name) || jobExports.includes(name), `${name}: ${reason}`);
  }
  for (const [name, path] of Object.entries(ACTIONS)) assert.match(body(name), path, `${name} reads and writes through the data surfaces`);
  // A report with metric filters or rates runs as plain parts, each through runReport (metricSplit.ts).
  assert.match(source.slice(source.indexOf("async function runMetrics(")).split(/^}/m)[0], /return runReport\(ctx, a\)[\s\S]*parts\.map\(\(p\) => runReport\(ctx, \{ module: a\.module, spec: p \}\)\)/, "runMetrics runs every part through runReport");
  assert.match(source.slice(source.indexOf("async function runCall(")), RUN_CALL, "runCall reads and writes through callPlan and applyCall");
  assert.match(source.slice(source.indexOf("async function printedPage(")).split(/^}/m)[0], /api\.modules\.page\b[\s\S]*runCall\(/, "a printed page reads as api.modules.page and its calls run through runCall");
  const all = ROOTS.flatMap((r) => files(join(root, r))).map((p) => relative(root, p));
  assert.deepEqual(all.filter((p) => !["convex/schema.ts", "convex/lib/modules/visitors.ts"].includes(p) && /["'`](moduleShareGrants|moduleVisitors|moduleVisitCodes|moduleRateLimits)["'`]/.test(readFileSync(p, "utf8"))), [], "only visitors.ts accesses share grants");
  assert.deepEqual(all.filter((p) => p !== "convex/lib/modules/scope.ts" && /\bshareDocs\(/.test(readFileSync(p, "utf8"))), ["convex/lib/modules/visitors.ts"], "only visitors.ts receives raw share docs");

  for (const capability of ["shareFileInfo", "recordVisitEvent", "recordVisitorDay", "writeShareDoc", "shareUploadField", "reserveVisitorUpload", "visitorUploadRow", "expiredVisitorUploads", "releaseVisitorUpload", "storeVisitorUpload", "shareFileDownload"]) assert.deepEqual(all.filter((p) => !["convex/lib/modules/scope.ts", "convex/lib/modules/visitors.ts"].includes(p) && new RegExp(`\\b${capability}\\s*\\(`).test(readFileSync(p, "utf8"))), []);
  const visitorSource = readFileSync(join(root, "convex/lib/modules/visitors.ts"), "utf8");
  assert.doesNotMatch(visitorSource, /\b(moduleScope|systemScope|personScope|getCurrentUser|findUser|callerOf)\s*\(/);
  const visits = readFileSync(join(root, "convex/visits.ts"), "utf8");
  const visitExports = [...visits.matchAll(/^export const (\w+) = (?:query|mutation|action|internalQuery|internalMutation|internalAction)\(/gm)].map((m) => m[1]);
  assert.deepEqual(visitExports, ["visitOpen", "visitPage", "visitOp", "visitTransition", "visitUpload", "visitFile", "visitRequestCode", "visitVerifyCode", "uploadTicket", "finishUpload", "releaseUpload", "notifyExpiring"]);
  const privateTickets = { notifyExpiring: /expiryNotices\(/, uploadTicket: /visitorUploadTicket\(/, finishUpload: /finishVisitorUpload\(/, releaseUpload: /cancelVisitorUpload\(/ };
  assert.deepEqual(Object.values(ALLOWLIST).flat().filter((ref) => ref.startsWith("visits.")).sort(),
    visitExports.filter((name) => !Object.hasOwn(privateTickets, name)).map((name) => `visits.${name}`).sort(),
    "visitor visibility exceptions cover exactly the signed capability handlers checked below");
  for (const [name, helper] of Object.entries(privateTickets)) {
    const body = visits.slice(visits.indexOf(`export const ${name} = `)).split(/^export const /m)[1];
    assert.match(body, /^\w+ = internalMutation\(/);
    assert.match(body, helper);
  }
  for (const name of visitExports.filter((name) => !Object.hasOwn(privateTickets, name))) assert.match(visits.slice(visits.indexOf(`export const ${name} = `)).split(/^export const /m)[1], new RegExp(`handler:[\\s\\S]*?const result = await visitorScope\\(ctx, envelope, "visits:${name}", args\\)`));
  const visitHttp = readFileSync(join(root, "src/lib/visitHttp.ts"), "utf8");
  for (const name of ["visitRequestCode", "visitVerifyCode"]) assert.match(visitHttp, new RegExp(`client\\.mutation\\(api\\.visits\\.${name}, \\{ \\.\\.\\.args, envelope: signVisitEnvelope\\(signer, "visits:${name}", args, seen\\)`));
  assert.doesNotMatch(visits, /\b(moduleScope|systemScope|personScope|getCurrentUser|findUser|callerOf|runQuery|runAction)\b/);
  assert.deepEqual(all.filter((p) => !["convex/lib/modules/visitors.ts", "convex/visits.ts"].includes(p) && /\bvisitorScope\s*\(/.test(readFileSync(p, "utf8"))), []);
  assert.deepEqual(all.filter((p) => p.startsWith("convex/") && !["convex/lib/modules/visitors.ts", "convex/visits.ts"].includes(p) && /envelope:\s*v\.string\(/.test(readFileSync(p, "utf8"))), []);

  assert.deepEqual(all.filter((p) => !REPORT_READ_ALLOWED.has(p) && REPORT_READS.test(readFileSync(p, "utf8"))), [], "module reports read the record service only through runReport");
  assert.deepEqual(all.filter((p) => !REPORT_WRITE_ALLOWED.has(p) && REPORT_WRITES.test(readFileSync(p, "utf8"))), [], "only the job runner sends module docs to the record service");
  assert.equal(source.match(/\bmoduleAggregate\(/g)?.length, 2, "convex/modules.ts asks the record service for a module report in runReport, and for a team aggregate in runAggregate");
  assert.match(source.slice(source.indexOf("async function runAggregate(")).split(/^export const /m)[0], RUN_AGGREGATE, "a team aggregate reaches the call only through teamAggregate");
  assert.deepEqual(all.filter((p) => p !== "convex/lib/modules/scope.ts" && /\baggregateDocs\(/.test(readFileSync(p, "utf8"))), ["convex/modules.ts"], "every doc of an aggregated collection is read only for the fake's aggregate");
  assert.equal(source.match(/\baggregateDocs\(/g)?.length, 1, "and only in aggregateInMemory");
  assert.match(source.slice(source.indexOf("async function runReport(")).split(/^export const /m)[0], RUN_REPORT, "runReport's scope is reportPlan's, in the service and the fake alike");
  for (const [name, path] of Object.entries(UPGRADES)) assert.match(body(name), path, `${name} reaches module docs only through scope.ts`);
  for (const [name, path] of Object.entries(UPLOADS)) assert.match(body(name), path, `${name} reaches module files only through scope.ts`);
});

/**
 * Canon's own pages (the deals list, Settings > Team) show what modules add to them only through api.modules.contributions,
 * which reads each module's docs through its scope as the caller (docs/modules.md, "On Canon's pages"). A module page
 * (src/app/dashboard/m, src/components/modules) is the module's own; the Customization page manages modules and packages.
 */
test("Canon's pages read module data only through api.modules.contributions", () => {
  const root = process.cwd();
  const OWN = [/^src\/app\/dashboard\/m\//, /^src\/components\/modules\//, /^src\/app\/dashboard\/customization\//, /^src\/app\/mcp\//, /^src\/components\/shell\//, /^src\/components\/recipes\//];
  const pages = [...files(join(root, "src/app/dashboard")), ...files(join(root, "src/components"))].map((p) => relative(root, p)).filter((p) => !OWN.some((r) => r.test(p)));
  const reads = pages.flatMap((p) => [...readFileSync(p, "utf8").matchAll(/api\.modules\.(\w+)/g)].map((m) => `${p}: ${m[1]}`));
  assert.deepEqual(reads.filter((r) => !r.endsWith(": contributions")), [], "a Canon page reads module data through contributions");
  for (const page of ["src/app/dashboard/deals/page.tsx", "src/app/dashboard/settings/team-tab.tsx"]) assert.match(readFileSync(join(root, page), "utf8"), /api\.modules\.contributions/, `${page} shows what modules add`);
  const source = readFileSync(join(root, "convex/modules.ts"), "utf8");
  const body = source.slice(source.indexOf("export const contributions = ")).split(/^export const /m)[1];
  assert.match(body, /caller\.enabledScope\(pkg\)[\s\S]*scope\.pageRows\(/, "contributions reads each module's docs through its scope, as the caller");
  assert.doesNotMatch(body, /ctx\.db\.query\(/, "contributions reads no module table itself");
});

/**
 * A company or person ref is the record service's, which a mutation can't read (docs/modules.md, "Refs"). So a write
 * judges one in one place, scope.ts refResolver, against what its action admitted through the writer's record client
 * in one place, admitRecords. These are the writes that take admitted refs; every other write (a transition, Canon's
 * own op or transition, an approved proposal) takes none, so only a ref its doc already held passes there.
 */
const ADMITTED_WRITES = { "convex/modules.ts": ["applyOp", "stageSet", "applyCall", "dryApply", "aiFinish"], "convex/moduleJobs.ts": ["stageKey", "applyKey", "connectorItemsApply"] };

test("a write's company and person refs are judged in refResolver, against refs only admitRecords admits", () => {
  const root = process.cwd();
  const scope = readFileSync(join(root, "convex/lib/modules/scope.ts"), "utf8");
  assert.equal(scope.match(/\bisRecordRef\(ref\.to\)\) return record\(/g)?.length, 1, "refResolver hands every company and person ref to the write's admission");
  assert.deepEqual([...scope.matchAll(/refResolver\(ctx\.db, [^)]*, (\w+)\)/g)].map((m) => m[1]), ["recordAdmits", "recordHeld"], "a write judges them by what it admitted; an upgrade keeps only the refs its own doc holds");
  for (const [file, names] of Object.entries(ADMITTED_WRITES)) {
    const source = readFileSync(join(root, file), "utf8");
    const takers = [...source.matchAll(/^export const (\w+) = internalMutation\(\{\n  args: \{[^\n]*admit: admitV/gm)].map((m) => m[1]);
    assert.deepEqual(takers.sort(), [...names].sort(), `${file}: the writes that take admitted refs are listed here`);
    const body = (name: string) => source.slice(source.indexOf(`export const ${name} = `)).split(/^export const /m)[1];
    for (const name of names) assert.match(body(name), name === "aiFinish" ? /written\(person, / : /written\(scope, /, `${name} throws the refs it found to admit, when asked`);
    // Each run of one passes the `admit` that admitRecords (or stageAndApply's call of it) handed its caller.
    const runs = [...source.matchAll(new RegExp(`runMutation\\(internal\\.(?:modules|moduleJobs)\\.(?:${Object.values(ADMITTED_WRITES).flat().join("|")}), \\{[^}]*\\}\\)`, "g"))];
    assert.ok(runs.length > 0, `${file} runs its admitted writes`);
    for (const m of source.matchAll(new RegExp(`runMutation\\(internal\\.(?:modules|moduleJobs)\\.(?:${Object.values(ADMITTED_WRITES).flat().join("|")}), \\{[^}]*\\}\\)`, "g"))) assert.match(m[0], /\badmit \}\)$/, `${file}: ${m[0].slice(0, 80)} passes its admitted refs`);
  }
  const modules = readFileSync(join(root, "convex/modules.ts"), "utf8");
  assert.equal(modules.match(/\bvisibleIds\(/g)?.length, 1, "refs are admitted only in admitRecords");
  assert.match(modules.slice(modules.indexOf("export async function stageAndApply(")).split(/^}/m)[0], /admitRecords\(ctx, \(admit\) => stage \? stage\(\{ \.\.\.g, offset, docs \}, admit\) : ctx\.runMutation\(internal\.modules\.stageSet[\s\S]*admitRecords\(ctx, \(admit\) => apply\(applied, admit\)/, "a call's default and job-adapted staged sets and writes retain the same admission");
});

test("module physical and lifecycle writers share the mandatory capture boundary", () => {
  const sourceOf = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callName = (node: ts.CallExpression) => node.expression.getText();
  const enclosedBy = (node: ts.Node, name: string) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isCallExpression(parent) && callName(parent) === name) return true;
    return false;
  };
  const visit = (node: ts.Node, fn: (node: ts.Node) => void) => { fn(node); node.forEachChild((child) => visit(child, fn)); };
  const find = (source: ts.SourceFile, name: string): ts.Node => {
    let result: ts.Node | undefined;
    visit(source, (node) => { if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText() === name) result = node; });
    assert.ok(result, `${source.fileName} still declares ${name}`);
    return result;
  };
  const scope = sourceOf("convex/lib/modules/scope.ts");
  const wrappers = ["insertModuleDoc", "patchModuleDoc", "deleteModuleDoc"];
  for (const name of wrappers) {
    const fn = find(scope, name);
    assert.match(fn.getText(), /ctx: MutationCtx, source: ModuleSourceState/);
    assert.match(fn.getText(), /writeModuleState\(ctx, source,/);
    visit(fn, (node) => {
      if (ts.isCallExpression(node) && /^db\.(insert|patch|replace|delete)$/.test(callName(node))) assert.equal(enclosedBy(node, "writeModuleState"), true, `${name} cannot write before capture`);
    });
  }
  visit(scope, (node) => {
    if (!ts.isCallExpression(node) || !wrappers.includes(callName(node))) return;
    assert.equal(node.arguments[0]?.getText(), "writeCtx(ctx)");
    assert.equal(node.arguments[1]?.getText(), "source");
  });
  for (const name of ["projectSq1Lifecycle", "recordVisitorDay", "writeShareDoc", "upgradeBatch", "applyMigration", "stopUpgrade", "seedDocs", "unseedDocs", "tamperDoc"]) assert.match(find(scope, name).getText(), /withModulePublication\(ctx,/);
  const scopeBody = find(scope, "scopeOf").getText();
  for (const name of ["stage", "dropGeneration", "importDocs", "copyCutover", "finishCanonCall", "complete", "bulkStep"]) assert.ok(scopeBody.includes(`${name}: captured(${name})`), `${name} enters the shared transaction session`);
  for (const name of ["op", "transition", "apply"]) assert.ok(scopeBody.includes(`${name}: memberCaptured(${name})`), `${name} enters the member transaction session`);
  assert.match(find(scope, "memberCaptured").getText(), /withModulePublication\(writeCtx\(ctx\),/);
  assert.match(find(scope, "memberCaptured").getText(), /principal\.kind === "user" && principal\.session && pkg\.pending && pkg\.activityPublication/);
  assert.deepEqual([...scopeBody.matchAll(/(\w+): memberCaptured\(/g)].map((m) => m[1]).sort(), ["apply", "op", "transition"]);
  assert.match(scopeBody, /rememberModuleRow\(ctx, await ctx\.db\.query/);

  const metadata = [
    ["convex/lib/modules/scope.ts", ["upgradeBatch", "activate", "stopUpgrade", "applyMigration", "cutoverBatch"]],
    ["convex/modules.ts", ["applyModule", "cancelUpgrade", "setEnabled", "setModuleEnabled", "uninstall"]],
  ] as const;
  for (const [path, names] of metadata) {
    const source = sourceOf(path);
    for (const name of names) visit(find(source, name), (node) => {
      if (ts.isCallExpression(node) && callName(node) === "ctx.db.patch" && /^(pkg|row)\._id$/.test(node.arguments[0]?.getText() ?? "")) assert.equal(enclosedBy(node, "capturePackageState"), true, `${path} ${name} captures metadata before patching it`);
    });
  }
  const installer = find(sourceOf("convex/modules.ts"), "applyModule");
  visit(installer, (node) => {
    if (ts.isCallExpression(node) && callName(node) === "ctx.db.insert" && node.arguments[0]?.getText() === '"modulePackages"') assert.equal(enclosedBy(node, "captureInstalledPackage"), true);
  });
  const packages = sourceOf("convex/lib/modules/packages.ts");
  assert.match(find(packages, "storePendingManifest").getText(), /capturePendingActivityDescriptor/);
  const defaults = sourceOf("convex/moduleDefaults.ts");
  assert.match(find(defaults, "applyDefault").getText(), /withModulePublication\(ctx,/);
  for (const path of ["convex/modules.ts", "convex/moduleDefaults.ts"]) visit(sourceOf(path), (node) => {
    if (ts.isCallExpression(node) && callName(node) === "ctx.db.insert" && node.arguments[0]?.getText() === '"recipeEnablements"') assert.equal(enclosedBy(node, "capturePackageState"), true, `${path} captures module enablement`);
  });

  for (const path of ["convex/lib/modules/scope.ts", "convex/lib/modules/activityCapture.ts", "convex/lib/modules/activityPublication.ts"]) visit(sourceOf(path), (node) => {
    if (!ts.isCallExpression(node) || !/\.(insert|replace|patch|delete)$/.test(callName(node)) || node.arguments[0]?.getText() !== '"moduleDocs"') return;
    assert.equal(path, "convex/lib/modules/scope.ts");
    assert.equal(enclosedBy(node, "writeModuleState"), true);
  });
  // These fields do not alter activity identity, visibility, declaration or physical data. The list is closed.
  const operational = [
    ["convex/lib/modules/scope.ts", "startImports", "imports"],
    ["convex/modules.ts", "importBatch", "imports"],
    ["convex/modules.ts", "importStep", "imports"],
    ["convex/moduleDefaults.ts", "applyDefault", "autoUpgrade"],
    ["convex/lib/modules/projection.ts", "initializeProjection", "projection"],
    ["convex/moduleJobs.ts", "projectDone", "projection"],
  ];
  for (const [path, name, field] of operational) visit(find(sourceOf(path), name), (node) => {
    if (!ts.isCallExpression(node) || callName(node) !== "ctx.db.patch" || enclosedBy(node, "capturePackageState")) return;
    const value = node.arguments[1];
    assert.ok(value && ts.isObjectLiteralExpression(value));
    assert.deepEqual(value.properties.map((p) => p.name?.getText()), [field], `${path} ${name} has only its enumerated operational package patch`);
  });
  const owners: Record<string, string[]> = {
    "convex/lib/modules/scope.ts": ["upgradeBatch", "activate", "stopUpgrade", "applyMigration", "cutoverBatch", "startImports"],
    "convex/modules.ts": ["applyModule", "cancelUpgrade", "setEnabled", "setModuleEnabled", "uninstall", "importBatch", "importStep"],
    "convex/moduleDefaults.ts": ["applyDefault"],
    "convex/moduleJobs.ts": ["projectDone"],
    "convex/lib/modules/projection.ts": ["initializeProjection"],
    "convex/lib/modules/activityCapture.ts": ["openSource"],
    "convex/lib/modules/activityPublication.ts": ["publishActivityStep"],
  };
  for (const [path, names] of Object.entries(owners)) visit(sourceOf(path), (node) => {
    if (!ts.isCallExpression(node) || callName(node) !== "ctx.db.patch") return;
    const target = node.arguments[0]?.getText() ?? "";
    if (target !== "pkg._id" && target !== "previous._id" && !(path === "convex/modules.ts" && target === "row._id")) return;
    let owner: ts.Node = node;
    while (owner.parent && !ts.isFunctionDeclaration(owner) && !(ts.isVariableDeclaration(owner) && names.includes(owner.name.getText()))) owner = owner.parent;
    assert.ok((ts.isFunctionDeclaration(owner) || ts.isVariableDeclaration(owner)) && owner.name && names.includes(owner.name.getText()), `${path} has an unlisted package writer`);
  });
  const capture = readFileSync("convex/lib/modules/activityCapture.ts", "utf8");
  assert.match(capture, /sessions\.get\(ctx\.db\)/);
  assert.match(capture, /!s\.depth/);
  assert.doesNotMatch(capture, /TRUSTED_MAINTENANCE|faultFlag|skipCapture|captureEnabled/);
  const publisher = readFileSync("convex/lib/modules/activityPublication.ts", "utf8");
  assert.doesNotMatch(publisher, /\.op\(|\.apply\(|\.transition\(|moduleScope\(|personScope\(|systemScope\(/);
});
