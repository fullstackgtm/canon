/**
 * Visibility inventory (CP14, #326): every public Convex query, mutation and
 * action that can reveal a record, and whether it is judged.
 *
 * A function is in the inventory when its arguments name a record (a record,
 * stream, record-service or CRM id, a domain or an email, or `v.id(...)` of a
 * table that holds record data), or when what it runs reads such a table or
 * the bare record client (`clientFor`). "What it runs" is its handler plus,
 * transitively, the helpers it calls in its own file, the functions it imports
 * from other Convex modules, and the Convex functions it calls by reference
 * (`ctx.runQuery(internal.x.y)`).
 *
 * It is judged when that same closure calls one of the judges in
 * `convex/permissions.ts` (entitySight and the helpers built on it), the scoped
 * record client (`records.callerClient`, `principalClient`, `visibleIds`), or
 * `canSeeRecord`. Anything else must be on the allowlist
 * (scripts/visibility-allowlist.ts) with its reason.
 *
 *   node --experimental-strip-types scripts/visibility-inventory.ts           # markdown table
 *   node --experimental-strip-types scripts/visibility-inventory.ts --unjudged  # only what fails the rule
 *   node --experimental-strip-types scripts/visibility-inventory.ts --json
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX = join(ROOT, "convex");

/** The judges: one of these in a function's closure means it decides visibility through the one layer. */
export const JUDGES = [
  // permissions.ts: one judge for record-keyed reads and gate writes, and the per-record checks it is made of
  "entitySight", "recordSight", "sightJudge", "querySees", "sightAdmits", "recordVisible", "dealVisible", "visibleDeals", "dealIdScope", "canSeeRecord", "requireRowAccess",
  // the scoped record client, and the action twins that admit through it
  "callerClient", "principalClient", "visibleIds", "visibleValues", "visibleDomains", "admitThenRead",
  // whole-workspace reads and operations: nothing, or refused, for a role that sees only part of the workspace
  "unrestrictedUser", "requireUnrestricted", "refuseNarrowed", "narrowsReads", "seesRunRecords", "seesEveryRecord",
] as const;

/** Tables whose rows carry a record's identity or values (a name, a domain, an email, a field value, a before-value). */
export const RECORD_TABLES = new Set([
  "crmAccounts", "crmContacts", "crmOpportunities", "deals", "dealContacts", "dealOverrides",
  "canonEntities", "canonExternalIds", "canonFieldState", "facts", "recordRows", "associations", "recordMerges", "duplicateDismissals",
  "observations", "observationHeads", "accountSignals", "proposalQueue", "canonOutboundShadow",
  "patchPlans", "patchOperations", "cliRuns", "sfImportJobs", "sfConflicts", "sfImportIds", "crmImports",
  "callRecordings", "callTranscriptSegments", "callInsights", "dialerCalls",
  "dialerQueueItems",
  "linkedinEnrollments", "linkedinSends", "linkedinActivity", "emailSends", "emailLookups",
  "stagedRecords", "agentTurns", "researchPages", "researchAttempts", "audienceMembers", "audienceAdditions",
  "icpScores", "leadScores", "scorecardResults", "accountEnrichments", "abmListAccounts", "customerHealthScores",
  "winLossRecords", "touchpoints", "partnerDeals", "ledgerEntries", "automationRuns",
  "fakeRecordAccounts", "fakeRecordContacts", "fakeRecordHistory", "fakeRecordKeys",
]);

/** Argument names that carry a record's identity when typed as a plain string. */
const RECORD_ARG = /^(record|entity|stream|account|contact|deal|lead|company|person|people|crm|external|hubspot|salesforce|sf|object|target|winner|loser|subject|row|merge)?(Id|Ids|Key|Keys)$|^(id|ids|domain|domains|email|emails|recordIds?)$/;

export type Fn = { file: string; name: string; kind: "query" | "mutation" | "action"; isPublic: boolean };
export type Entry = Fn & { ref: string; flaggedBy: string[]; judgedBy: string[] };

type Body = { node: ts.Node; text: string };
type Module = { file: string; source: ts.SourceFile; fns: Map<string, Fn & Body>; helpers: Map<string, Body>; imports: Map<string, { module: string; name: string }> };

function convexFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "_generated" ? [] : convexFiles(p);
    return f.endsWith(".ts") && !f.endsWith(".d.ts") ? [p] : [];
  });
}

const KINDS: Record<string, [Fn["kind"], boolean]> = {
  query: ["query", true], mutation: ["mutation", true], action: ["action", true],
  internalQuery: ["query", false], internalMutation: ["mutation", false], internalAction: ["action", false],
};

function parse(path: string): Module {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  const file = relative(CONVEX, path).replace(/\.ts$/, "");
  const mod: Module = { file, source, fns: new Map(), helpers: new Map(), imports: new Map() };
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith(".")) {
      const target = resolve(dirname(path), st.moduleSpecifier.text).replace(/\.ts$/, "");
      const named = st.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) mod.imports.set(el.name.text, { module: relative(CONVEX, target), name: (el.propertyName ?? el.name).text });
    } else if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      mod.helpers.set(st.name.text, { node: st, text: st.getText(source) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = d.initializer;
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && KINDS[init.expression.text]) {
          const [kind, isPublic] = KINDS[init.expression.text]!;
          mod.fns.set(d.name.text, { file, name: d.name.text, kind, isPublic, node: init, text: init.getText(source) });
        } else {
          mod.helpers.set(d.name.text, { node: init, text: init.getText(source) });
        }
      }
    }
  }
  return mod;
}

let modules: Map<string, Module> | null = null;
function allModules() {
  modules ??= new Map(convexFiles(CONVEX).map((p) => { const m = parse(p); return [m.file, m]; }));
  return modules;
}

const refCache = new WeakMap<ts.Node, { calls: Set<string>; fnRefs: Set<string> }>();

/**
 * Names a body calls or passes as a value (`foo(`, `rows.map(view)`), and the
 * Convex functions it runs or schedules by reference (`ctx.runQuery(internal.a.b)`,
 * `ctx.scheduler.runAfter(0, internal.a.b)`): a scheduled job returns nothing
 * to the caller, but what it writes is the caller's write.
 */
function refsOf(body: Body, source: ts.SourceFile) {
  const hit = refCache.get(body.node);
  if (hit) return hit;
  const calls = new Set<string>();
  const fnRefs = new Set<string>();
  // A name the body declares itself (`const merge = ...`, a parameter) is not the module's helper of that name.
  const local = new Set<string>();
  const declared = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n !== body.node) local.add(n.name.text);
    ts.forEachChild(n, declared);
  };
  declared(body.node);
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isMember = (ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n);
      if (!isMember && !local.has(n.text)) calls.add(n.text);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const m = /^(?:internal|api)\.([\w.]+)\.(\w+)$/.exec(n.getText(source));
      if (m) fnRefs.add(`${m[1]!.replace(/\./g, "/")}.${m[2]}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(body.node);
  const out = { calls, fnRefs };
  refCache.set(body.node, out);
  return out;
}

/**
 * What a function does at its entry: its handler and the same-file helpers it
 * reaches, plus one hop into other modules (a helper it imports from another
 * Convex module, a Convex function it runs) with that module's own helpers.
 * Deeper than that are shared writers and jobs (the ledger, the gate, the
 * importers): a judge there is not this function's decision, and a table
 * they read is not this function's answer.
 */
function entry(start: Module, fn: Body) {
  const mods = allModules();
  const seen = new Set<string>();
  const texts: string[] = [];
  const calls = new Set<string>();
  const stack: Array<{ m: Module; key: string; body: Body; hop: number }> = [{ m: start, key: `${start.file}#`, body: fn, hop: 0 }];
  while (stack.length) {
    const { m, key, body, hop } = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(body.text);
    const r = refsOf(body, m.source);
    for (const c of r.calls) {
      calls.add(c);
      const local = m.helpers.get(c);
      if (local) { stack.push({ m, key: `${m.file}#${c}`, body: local, hop }); continue; }
      const imp = hop === 0 ? m.imports.get(c) : undefined;
      const target = imp && mods.get(imp.module);
      const found = target?.helpers.get(imp!.name);
      if (target && found) stack.push({ m: target, key: `${target.file}#${imp!.name}`, body: found, hop: 1 });
    }
    if (hop > 0) continue;
    for (const ref of r.fnRefs) {
      const dot = ref.lastIndexOf(".");
      const target = mods.get(ref.slice(0, dot));
      const f = target?.fns.get(ref.slice(dot + 1));
      if (target && f) stack.push({ m: target, key: `${target.file}#${ref.slice(dot + 1)}`, body: f, hop: 1 });
    }
  }
  return { text: texts.join("\n"), calls };
}

/** The argument names and validators of a registered function. */
function argsOf(fn: Fn & Body, source: ts.SourceFile): Array<[string, string]> {
  const call = fn.node as ts.CallExpression;
  const def = call.arguments[0];
  if (!def || !ts.isObjectLiteralExpression(def)) return [];
  const args = def.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "args");
  if (!args || !ts.isPropertyAssignment(args)) return [];
  const out: Array<[string, string]> = [];
  const walk = (obj: ts.Node) => {
    if (!ts.isObjectLiteralExpression(obj)) return;
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        // `...teamArgs`: a same-file object of validators
        const name = p.expression.getText(source);
        const local = allModules().get(fn.file)?.helpers.get(name);
        if (local) walk(local.node);
        continue;
      }
      if (!ts.isPropertyAssignment(p) || !p.name) continue;
      out.push([p.name.getText(source).replace(/["']/g, ""), p.initializer.getText(source)]);
    }
  };
  walk(args.initializer);
  return out;
}

export function inventory(): Entry[] {
  const out: Entry[] = [];
  for (const mod of allModules().values()) {
    if (mod.file.startsWith("lib/")) continue;
    for (const fn of mod.fns.values()) {
      if (!fn.isPublic) continue;
      const flaggedBy: string[] = [];
      for (const [name, raw] of argsOf(fn, mod.source)) {
        const validator = raw.replace(/^v\.optional\(([\s\S]*)\)$/, "$1");
        const table = /v\.id\("(\w+)"\)/.exec(validator)?.[1];
        if (table ? RECORD_TABLES.has(table) : RECORD_ARG.test(name)) flaggedBy.push(`arg ${name}`);
        // An argument its validator does not type can name any record.
        else if (validator === "v.any()") flaggedBy.push(`arg ${name} (any)`);
      }
      const { text, calls } = entry(mod, fn);
      const tables = [...new Set([...text.matchAll(/\.query\("(\w+)"\)/g)].map((m) => m[1]!))].filter((t) => RECORD_TABLES.has(t)).sort();
      if (tables.length) flaggedBy.push(`reads ${tables.join(",")}`);
      if (calls.has("clientFor")) flaggedBy.push("record service");
      if (!flaggedBy.length) continue;
      
      const judgedBy = JUDGES.filter((j) => calls.has(j));
      out.push({ file: fn.file, name: fn.name, kind: fn.kind, isPublic: true, ref: `${fn.file.replace(/\//g, ".")}.${fn.name}`, flaggedBy, judgedBy });
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ALLOWLIST } = await import("./visibility-allowlist.ts");
  const allowed = new Map(Object.entries(ALLOWLIST).flatMap(([reason, refs]) => refs.map((r) => [r, reason] as const)));
  const entries = inventory();
  const status = (e: Entry) => (e.judgedBy.length ? `judged: ${e.judgedBy.join(", ")}` : allowed.has(e.ref) ? `allowlisted: ${allowed.get(e.ref)}` : "UNJUDGED");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(entries.map((e) => ({ ...e, status: status(e) })), null, 2));
  } else {
    const rows = process.argv.includes("--unjudged") ? entries.filter((e) => status(e) === "UNJUDGED") : entries;
    console.log("| Function | Kind | Why it is in the inventory | How it is judged |\n|---|---|---|---|");
    for (const e of rows) console.log(`| \`${e.ref}\` | ${e.kind} | ${e.flaggedBy.join("; ")} | ${status(e)} |`);
    const unjudged = entries.filter((e) => status(e) === "UNJUDGED").length;
    const judged = entries.filter((e) => e.judgedBy.length).length;
    console.log(`\n${entries.length} functions: ${judged} judged, ${entries.length - judged - unjudged} allowlisted, ${unjudged} unjudged.`);
  }
}
