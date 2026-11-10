/**
 * `canon workspace import [--dry-run] <archive>`: read an archive (cli/workspaceArchive.ts) into an empty workspace
 * through /api/v1/workspace/import (convex/workspaceImport.ts). The dry run decodes every row the import would write
 * with the same code Convex runs (convex/lib/workspaceArchive/importRows.ts), against the id map the archive implies,
 * and writes nothing. The import refuses to start while the dry run finds any refusal, and Convex checks every page
 * again whatever this sends.
 *
 * Node built-ins only, plus the pure import rows module.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { decodeRow, DEFERRED, IMPORT_TABLES, moduleOf, registerIdOf, SKIPPED, type RemapEnv, type Shape, type Unmapped } from "../convex/lib/workspaceArchive/importRows.ts";
import { arrive } from "../convex/lib/workspaceArchive/actors.ts";
import { verifyArchive, type Manifest } from "./workspaceArchive.ts";

/** Rows per import page: the Convex importer's limit (convex/workspaceImport.ts IMPORT_PAGE_MAX). */
const PAGE_ROWS = 100;
const PAGE_BYTES = 2_000_000;
const USERS_PAGE = 200;
const REGISTER_PAGE = 1000;

export type ImportPlan = {
  workspace: { id: string; name: string; slug: string };
  importedBy: { id: string; email: string };
  order: string[];
  shapes: Record<string, Shape>;
  secondPass: Record<string, { fields: string[]; after: string }>;
  scopeFields: Record<string, string | null>;
  registerMode: "service" | "convex";
  /** Modules installed in the destination workspace: only their rows are imported. */
  installedModules: string[];
  notEmpty: string[];
  current: { digest: string; status: "running" | "done"; progress: Record<string, number> } | null;
  /** Why this deployment can't read the archive's data (its data epoch, the record service contract), from the route. */
  refusals: string[];
  /** Once an import is done: every switch it could have brought, and what is connected here (convex/workspaceImport.ts gatesIn). */
  gates?: Gate[] | null;
};
/** One mechanism that sends or acts (convex/lib/workspaceArchive/actors.ts CENSUS), as the import left it. */
export type Gate = {
  key: string; does: string; arrives: string; open: number;
  imported: Array<{ table: string; rows: number; open: number }>;
  here: Array<{ table: string; count: number }>;
};
type Mapping = { oldId: string; email: string; name: string; role: string; as: "you" | "member" | "placeholder" | "former"; newId: string };

/** The import route's operations (src/app/api/v1/workspace/import/route.ts). */
export type ImportTransport = {
  plan(source: Manifest["source"]): Promise<ImportPlan>;
  begin(args: { digest: string; sourceWorkspaceId: string; registerRows: number }): Promise<{ status: "running" | "done"; progress: Record<string, number> }>;
  users(args: { offset: number; rows: string[]; formerIds: string[]; pass?: 2 }): Promise<{ mapping: Mapping[] }>;
  page(args: { section: string; offset: number; rows: string[]; pass?: 2 }): Promise<PageResult>;
  register(args: { section: string; offset: number; rows: string[] }): Promise<{ written: number; skipped: number; foreign: number }>;
  finish(args: { expected: Record<string, number> }): Promise<{ finishedAt: number; gates: Gate[] }>;
};

type PageResult = { written: number; skipped: number; cleared: Record<string, number>; notWritten: Record<string, number>; foreign: number };

/**
 * One archive section in the report. An imported one says what it leaves out: `notWritten` rows by why (a ref to
 * what isn't imported, or a module not installed here) and `cleared` refs by the table they named (`_storage` is a
 * file). A section not imported yet says why (importRows.ts DEFERRED).
 */
export type SectionReport = {
  section: string; rows: number; status: "import" | "not imported yet" | "empty";
  why?: string; notWritten?: Record<string, number>; cleared?: Record<string, number>;
  /** Rows that arrive switched off (actors.ts ARRIVALS), and how. */
  arrives?: { rows: number; why: string };
};

export type ImportReport = {
  dryRun: boolean;
  workspace: ImportPlan["workspace"];
  sections: SectionReport[];
  users: Array<{ email: string; name: string; role: string; as: Mapping["as"] }>;
  formerMembers: number;
  foreignLabels: number;
  refusals: string[];
  unmapped: Unmapped[];
  /** After the import: what sends or acts, as it arrived. Null on a dry run. */
  gates: Gate[] | null;
  seconds: number;
};

/** Every row of one section, as its NDJSON lines. */
export function sectionLines(files: Map<string, Uint8Array>, manifest: Manifest, section: string): string[] {
  const s = manifest.sections[section];
  if (!s) return [];
  return s.parts.flatMap((p) => gunzipSync(files.get(p.file)!).toString("utf8").split("\n").filter(Boolean));
}

const USER_KEYS = new Set(["ownerId", "userId", "actorId", "createdBy", "updatedBy", "primaryRepId", "dismissedBy", "mergedBy", "setBy"]);
const BARE = /^[0-9a-z]{31,37}$/;

/** Member ids the archive's history names in places only a member goes (`user:<id>`, a person's actor, an owner field). */
function userIdsIn(value: unknown, out: Set<string>, key = "", parent: Record<string, unknown> | null = null) {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\b(?:user|emaillog):([0-9a-z]{31,37})(?![0-9a-z])/g)) out.add(m[1]);
    if (BARE.test(value) && (USER_KEYS.has(key) || (key === "id" && parent?.kind === "user"))) out.add(value);
  } else if (Array.isArray(value)) value.forEach((v) => userIdsIn(v, out, key, parent));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.$ref === "users" && typeof o.id === "string") out.add(o.id);
    else for (const [k, v] of Object.entries(o)) userIdsIn(v, out, k, o);
  }
}

/** The sections this archive needs written, in the destination's order, with their rows. */
function sectionsToImport(files: Map<string, Uint8Array>, manifest: Manifest, plan: ImportPlan) {
  return plan.order.filter((s) => s !== "users" && (manifest.sections[s]?.count ?? 0) > 0).map((s) => ({ section: s, lines: sectionLines(files, manifest, s) }));
}

/**
 * Check the archive and decode everything the import would write, against the id map it implies: every row of a
 * section it imports gets an id, members match by email. Returns what an import would do and every value it refuses.
 */
export async function planImport(files: Map<string, Uint8Array>, plan: ImportPlan) {
  const { manifest, ok, checks } = verifyArchive(files);
  const refusals = [...plan.refusals];
  if (!ok) refusals.push(`The archive doesn't match its manifest: ${checks.filter((c) => c.problems.length).map((c) => `${c.section} (${c.problems.join("; ")})`).join(", ")}`);
  if (plan.notEmpty.length && !plan.current) refusals.push(`Import only goes into a new, empty workspace, and ${plan.workspace.name} isn't: ${plan.notEmpty.join("; ")}.`);
  if (plan.current && plan.current.digest !== digestOf(files)) refusals.push(`${plan.workspace.name} already took an import of another archive. Import into a fresh workspace.`);
  const registerRows = ["register.accounts", "register.contacts", "register.field_history"].reduce((n, s) => n + (manifest.sections[s]?.count ?? 0), 0);
  const fakeRows = ["fakeRecordAccounts", "fakeRecordContacts", "fakeRecordHistory"].reduce((n, s) => n + (manifest.sections[s]?.count ?? 0), 0);
  if (registerRows && plan.registerMode === "convex") refusals.push("The archive's register came from a record service, and this deployment has none.");
  if (fakeRows && plan.registerMode === "service") refusals.push("The archive's register is in Convex (no record service), and this deployment keeps it in a record service; importing it there isn't supported yet.");

  const users = sectionLines(files, manifest, "users").map((l) => JSON.parse(l) as Record<string, string>);
  const sections = sectionsToImport(files, manifest, plan);
  const sim = new Map<string, string>([[manifest.workspace.id, plan.workspace.id]]);
  for (const u of users) sim.set(u._id, `user:${u._id}`);
  const referenced = new Set<string>();
  // Where each id comes into the map: as Convex does, a section sees only ids of sections before it, its own (a
  // second pass fills refs to them) and the section its second pass waits for.
  const at = new Map<string, number>();
  for (const [i, { section, lines }] of sections.entries()) {
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row._id === "string" && !section.startsWith("register.")) { sim.set(row._id, `new:${row._id}`); at.set(row._id, i); }
      if (section === "canonEntities" && (row.entityType === "account" || row.entityType === "contact")) {
        const reg = await registerIdOf(row.entityType, row._id as string);
        sim.set(reg, `reg:${row._id}`);
        at.set(reg, i);
      }
      userIdsIn(row, referenced);
    }
  }
  const formerIds = [...referenced].filter((id) => !users.some((u) => u._id === id));
  for (const id of formerIds) sim.set(id, `former:${id}`);

  let current = -1, waitsFor = -1;
  const visible = (id: string) => { const i = at.get(id); return i === undefined || i <= current || i === waitsFor; };
  const env: RemapEnv = { orgId: plan.workspace.id, map: (id) => (visible(id) ? sim.get(id) : undefined), imported: (t) => t in IMPORT_TABLES || t === "organizations" };
  const indexOf = new Map(sections.map((s, i) => [s.section, i]));
  const installed = new Set(plan.installedModules);
  const unmapped: Unmapped[] = [];
  const outcome = new Map<string, { notWritten: Record<string, number>; cleared: Record<string, number>; arrives: number }>();
  let foreign = 0;
  for (const [i, { section, lines }] of sections.entries()) {
    current = i;
    waitsFor = indexOf.get(plan.secondPass[section]?.after ?? "") ?? -1;
    const shape: Shape = section.startsWith("register.") ? { kind: "any" } : plan.shapes[section];
    const counts = { notWritten: {} as Record<string, number>, cleared: {} as Record<string, number>, arrives: 0 };
    outcome.set(section, counts);
    const arrival = IMPORT_TABLES[section].arrive;
    for (const line of lines) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (IMPORT_TABLES[section].kind === "self") { delete raw.signupInvestigation; }
      const d = decodeRow(section, IMPORT_TABLES[section].kind === "self" ? { ...shape, fields: Object.fromEntries(Object.entries(shape.fields ?? {}).map(([k, f]) => [k, { ...f, optional: true }])) } : shape,
        section.startsWith("register.") ? { ...raw, _id: undefined } : raw, env, { deferSelf: !!plan.secondPass[section], scopeField: plan.scopeFields[section] ?? undefined });
      unmapped.push(...d.unmapped.filter((u) => !(typeof u.value === "string" && u.value.includes("\u0000"))));
      for (const [t, n] of Object.entries(d.cleared)) counts.cleared[t] = (counts.cleared[t] ?? 0) + n;
      foreign += d.foreign;
      // As Convex does: a row left out maps to SKIPPED, so the rows that need it are left out after it.
      const owner = moduleOf(section, raw);
      const why = owner && !installed.has(owner) ? `module ${owner}` : d.needs ? `needs ${d.needs}` : null;
      if (why) {
        counts.notWritten[why] = (counts.notWritten[why] ?? 0) + 1;
        if (typeof raw._id === "string") sim.set(raw._id, SKIPPED);
      } else if (arrival && JSON.stringify(arrive(section, arrival, d.row, { now: 0, heads: {} })) !== JSON.stringify(d.row)) counts.arrives++;
    }
  }
  const imported = new Set(sections.map((s) => s.section).concat("users"));
  const nonEmpty = <T extends Record<string, number>>(o: T | undefined) => (o && Object.keys(o).length ? o : undefined);
  const report: ImportReport = {
    dryRun: true,
    workspace: plan.workspace,
    sections: Object.entries(manifest.sections).map(([section, s]): SectionReport => {
      if (!s.count) return { section, rows: 0, status: "empty" };
      if (!imported.has(section)) return { section, rows: s.count, status: "not imported yet", why: DEFERRED[section]?.why ?? "a later Canon imports it" };
      const arrival = IMPORT_TABLES[section]?.arrive, arrives = outcome.get(section)?.arrives ?? 0;
      return { section, rows: s.count, status: "import", notWritten: nonEmpty(outcome.get(section)?.notWritten), cleared: nonEmpty(outcome.get(section)?.cleared), ...(arrival && arrives ? { arrives: { rows: arrives, why: arrival.why } } : {}) };
    }),
    users: users.map((u) => {
      const email = String(u.email ?? "").toLowerCase();
      const you = email === plan.importedBy.email.toLowerCase();
      return { email, name: String(u.name ?? ""), role: you ? "admin" : u.role === "admin" ? "rep" : String(u.role ?? "rep"), as: you ? "you" : "placeholder" };
    }),
    formerMembers: formerIds.length,
    foreignLabels: foreign,
    refusals,
    unmapped,
    gates: null,
    seconds: 0,
  };
  return { manifest, report, users: users.map((u) => JSON.stringify(u)), formerIds, sections };
}

export const digestOf = (files: Map<string, Uint8Array>) => createHash("sha256").update(files.get("manifest.json") ?? new Uint8Array()).digest("hex");

/** Pages of at most PAGE_ROWS rows and about PAGE_BYTES. */
function pages(lines: string[], rows: number, bytes = PAGE_BYTES): Array<{ offset: number; rows: string[] }> {
  const out: Array<{ offset: number; rows: string[] }> = [];
  let start = 0, size = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > start && (i - start >= rows || size + lines[i].length > bytes)) { out.push({ offset: start, rows: lines.slice(start, i) }); start = i; size = 0; }
    size += lines[i].length;
  }
  if (start < lines.length) out.push({ offset: start, rows: lines.slice(start) });
  return out;
}

/**
 * Import the archive: the dry run first, then members, then every section in order, each page at most once (a
 * rerun skips what is in and continues), then finish. Refuses to write anything while the dry run refuses.
 */
export async function importWorkspace(t: ImportTransport, files: Map<string, Uint8Array>, opts: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<ImportReport> {
  const started = Date.now();
  const manifest = JSON.parse(Buffer.from(files.get("manifest.json") ?? new Uint8Array()).toString("utf8") || "null") as Manifest | null;
  if (!manifest) throw new Error("Not a Canon workspace archive: it has no manifest.json.");
  const plan = await t.plan(manifest.source);
  const planned = await planImport(files, plan);
  const report = planned.report;
  if (opts.dryRun || report.refusals.length || report.unmapped.length) {
    report.seconds = (Date.now() - started) / 1000;
    if (!opts.dryRun) throw new ImportRefusedError(report);
    return report;
  }
  report.dryRun = false;
  const log = opts.log ?? (() => {});
  const registerRows = planned.sections.filter((s) => s.section.startsWith("register.")).reduce((n, s) => n + s.lines.length, 0);
  const begun = await t.begin({ digest: digestOf(files), sourceWorkspaceId: manifest.workspace.id, registerRows });
  const expected: Record<string, number> = {};
  if (begun.status !== "done") {
    const userLines = [...planned.users, ...planned.formerIds.map((id) => `former:${id}`)];
    const mapping: Mapping[] = [];
    for (const p of pages(userLines, USERS_PAGE)) {
      const rows = p.rows.filter((l) => !l.startsWith("former:"));
      const formerIds = p.rows.filter((l) => l.startsWith("former:")).map((l) => l.slice(7));
      mapping.push(...(await t.users({ offset: p.offset, rows, formerIds })).mapping);
    }
    for (const p of pages(planned.users, USERS_PAGE)) await t.users({ offset: p.offset, rows: p.rows, formerIds: [], pass: 2 });
    expected.users = userLines.length;
    expected["users#refs"] = planned.users.length;
    if (mapping.length) report.users = mapping.map((m) => ({ email: m.email, name: m.name, role: m.role, as: m.as }));
    const linesOf = new Map(planned.sections.map((s) => [s.section, s.lines]));
    const secondPasses = async (after: string) => {
      for (const [section, p] of Object.entries(plan.secondPass)) {
        const lines = linesOf.get(section);
        // A second pass runs after the section it waits for, or right after its own when that one has no rows.
        const runsAfter = linesOf.has(p.after) ? p.after : section;
        if (!lines || runsAfter !== after) continue;
        for (const page of pages(lines, PAGE_ROWS)) await t.page({ section, offset: page.offset, rows: page.rows, pass: 2 });
        expected[`${section}#refs`] = lines.length;
      }
    };
    for (const { section, lines } of planned.sections) {
      const sectionStarted = Date.now();
      expected[section] = lines.length;
      const register = section.startsWith("register.");
      const counts = { notWritten: {} as Record<string, number>, cleared: {} as Record<string, number> };
      for (const p of pages(lines, register ? REGISTER_PAGE : PAGE_ROWS, register ? 4_000_000 : PAGE_BYTES)) {
        if (register) { await t.register({ section, offset: p.offset, rows: p.rows }); continue; }
        const r = await t.page({ section, offset: p.offset, rows: p.rows });
        for (const k of ["notWritten", "cleared"] as const) for (const [why, n] of Object.entries(r[k] ?? {})) counts[k][why] = (counts[k][why] ?? 0) + n;
      }
      // What this run's pages left out; on a resumed run, pages already in report nothing and the dry run's counts stand.
      const entry = report.sections.find((x) => x.section === section);
      if (entry && (Object.keys(counts.notWritten).length || Object.keys(counts.cleared).length)) Object.assign(entry, { notWritten: counts.notWritten, cleared: counts.cleared });
      await secondPasses(section);
      log(`  ${section}: ${lines.length} rows, ${((Date.now() - sectionStarted) / 1000).toFixed(1)} s`);
    }
    report.gates = (await t.finish({ expected })).gates;
  } else report.gates = plan.gates ?? null;
  report.seconds = (Date.now() - started) / 1000;
  return report;
}

export class ImportRefusedError extends Error {
  readonly report: ImportReport;
  constructor(report: ImportReport) {
    super(`Import refused: ${[...report.refusals, ...(report.unmapped.length ? [`${report.unmapped.length} values the import can't map`] : [])].join("; ")}. Run with --dry-run to see each one.`);
    this.report = report;
  }
}

/** The import route of the deployment at `base`, authenticated with an import key. */
export function httpImportTransport(base: string, key: string, fetchImpl: typeof fetch = fetch): ImportTransport {
  const call = async (body: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1/workspace/import`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      throw new Error(`Could not reach ${base} (${error instanceof Error ? error.message : String(error)}). Check --url or CANON_URL.`);
    }
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (response.ok && payload) return payload;
    if (response.status === 404 && !payload) throw new Error(`${base} has no workspace import route (HTTP 404). Update the deployment, or check --url.`);
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  };
  return {
    plan: (source) => call({ op: "plan", source }) as Promise<ImportPlan>,
    begin: (args) => call({ op: "begin", ...args }) as Promise<{ status: "running" | "done"; progress: Record<string, number> }>,
    users: (args) => call({ op: "users", ...args }) as Promise<{ mapping: Mapping[] }>,
    page: (args) => call({ op: "page", ...args }) as Promise<PageResult>,
    register: (args) => call({ op: "register", ...args }) as Promise<{ written: number; skipped: number; foreign: number }>,
    finish: (args) => call({ op: "finish", ...args }) as Promise<{ finishedAt: number; gates: Gate[] }>,
  };
}

/** The report as the CLI prints it. */
export function printImportReport(r: ImportReport, print: (line: string) => void = console.log) {
  print(`${r.dryRun ? "Dry run: importing" : "Imported"} into ${r.workspace.name}${r.dryRun ? " would write" : ""}:`);
  const width = Math.max(7, ...r.sections.map((s) => s.section.length));
  for (const s of r.sections.filter((x) => x.status === "import")) print(`  ${s.section.padEnd(width)}  ${String(s.rows).padStart(8)}  ${s.status}`);
  print("Members:");
  for (const u of r.users) print(`  ${u.email.padEnd(32)} ${u.name.padEnd(24)} ${u.role.padEnd(10)} ${u.as === "you" ? "you" : u.as === "member" ? "a member here" : "inactive placeholder"}`);
  if (r.formerMembers) print(`  ${r.formerMembers} former member${r.formerMembers === 1 ? "" : "s"} the history names become inactive "Former member" placeholders.`);
  for (const s of r.sections) {
    const left = Object.entries(s.notWritten ?? {});
    if (left.length) print(`  ${s.section}: ${left.map(([why, n]) => `${n} left out (${why})`).join(", ")}`);
    const cleared = Object.entries(s.cleared ?? {});
    if (cleared.length) print(`  ${s.section}: cleared ${cleared.map(([t, n]) => `${n} ${t === "_storage" ? "file" : t} reference${n === 1 ? "" : "s"}`).join(", ")}`);
  }
  const notYet = r.sections.filter((s) => s.status === "not imported yet");
  if (notYet.length) print(`Not imported yet (${notYet.reduce((n, s) => n + s.rows, 0)} rows in ${notYet.length} sections):`);
  for (const s of notYet) print(`  ${s.section.padEnd(width)}  ${String(s.rows).padStart(8)}  ${s.why}`);
  if (r.sections.some((s) => s.cleared?._storage)) print("Files aren't in archives yet: their references are cleared, and a row that is only its file is left out.");
  const arriving = r.sections.filter((s) => s.arrives);
  if (arriving.length) print(`Arrives switched off${r.dryRun ? "" : " (turn each on here when you're ready)"}:`);
  for (const s of arriving) print(`  ${s.section.padEnd(width)}  ${String(s.arrives!.rows).padStart(8)}  ${s.arrives!.why}`);
  if (r.gates) {
    const open = r.gates.filter((g) => g.open);
    print(open.length ? `Able to act after the import: ${open.map((g) => g.key).join(", ")}.` : "Nothing the archive brought can send or act until a person here turns it on.");
    const connected = r.gates.flatMap((g) => g.here.map((h) => `${h.count} ${h.table}`));
    if (connected.length) print(`Connected on this deployment, so what you turn on can use it: ${connected.join(", ")}.`);
  }
  if (r.foreignLabels) print(`${r.foreignLabels} ids from the source name nothing here (agents, grants, rules, CRM mirror rows) and are kept as labels.`);
  for (const why of r.refusals) print(`Refused: ${why}`);
  for (const u of r.unmapped.slice(0, 50)) print(`Refused: ${u.table}${u.id ? ` ${u.id}` : ""} ${u.field} = ${u.value}: ${u.why}`);
  if (r.unmapped.length > 50) print(`Refused: …and ${r.unmapped.length - 50} more.`);
  print(`${r.seconds.toFixed(1)} s.`);
}

