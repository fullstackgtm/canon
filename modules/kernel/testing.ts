/**
 * Testing a module's calls without Canon (docs/modules.md, "Change it and install again"). A call is a function of a
 * context and the reads its plan names, so a test hands it both. `runCall` first checks the reads against the
 * module's own manifest: every read the call declares is given and no other, each Canon record holds only `id`,
 * `createdAt` and the fields `reads` grants, each module doc only its collection's fields, fact rows only the
 * attributes `facts` declares, and no list is longer than its read's limit. So a test fails when it feeds the module
 * data Canon would not have read for it.
 *
 * It does not run Canon's read plan: which records the caller sees, a role's hidden fields, how a read orders or
 * pages its rows, and the real shape of reports, aggregates, trees and other modules' interfaces are Canon's. A
 * development install into a self-hosted Canon runs the real thing.
 */
import type { CallContext, CallFunctions, CallOutput, ReadValue, Workspace } from "./calls.ts";
import { CANON_READS, MAX_READ_DOCS, type CallDecl, type ModuleManifest, type Role } from "./manifest.ts";
import { FACTS_MAX_IDS } from "./facts.ts";

/** The docs a read returns when its declaration names no limit, as Canon reads it. */
const READ_DEFAULT = 1000;
/** Fields some Canon reads return besides `id`, `createdAt` and the granted ones. */
const EXTRA_FIELDS: Partial<Record<string, readonly string[]>> = {
  "deals.people": ["dealId", "role"],
  "companies.updatedSince": ["updatedAt", "next"],
  "people.updatedSince": ["updatedAt", "next"],
  "proposals.byIds": ["operation"],
  "suppression.check": ["email", "linkedin", "voice"],
};
/** Canon reads whose rows are not records of granted fields: `runCall` checks only that they are given. */
const SHAPED = new Set(["deals.changesBetween", "audiences.snapshot", "people.snapshot", "people.count", "market.facets", "market.sample", "me.context", "me.status", "web.search", "web.pages", "social.search", "ai.plan", "research.signup", "match.inbound", "calls.transcript", "targets.forYear"]);
const DOC_KEYS = new Set(["key", "version", "data", "owner", "parentKey", "createdAt", "updatedAt"]);

/** What is wrong with `reads` as the reads of `call`: an empty list when Canon could have read them for it. */
export function readProblems(manifest: ModuleManifest, call: string, reads: Readonly<Record<string, unknown>>): string[] {
  const decl: CallDecl | undefined = manifest.calls?.[call];
  if (!decl) return [`${manifest.id} declares no call ${call}`];
  const problems: string[] = [];
  for (const name of Object.keys(reads)) if (!Object.hasOwn(decl.reads, name)) problems.push(`reads.${name}: ${call} declares no read ${name}`);
  for (const [name, r] of Object.entries(decl.reads)) {
    const at = `reads.${name}`;
    if (!Object.hasOwn(reads, name)) { problems.push(`${at} is missing: ${call} reads it`); continue; }
    const value = reads[name];
    if ("view" in r) {
      const view = manifest.views[r.view];
      const fields = new Set(Object.keys(manifest.collections[view?.collection ?? ""]?.schema.value ?? {}));
      const docs = view?.kind === "one" ? (value === null ? [] : [value]) : value;
      if (!Array.isArray(docs)) { problems.push(`${at}: ${r.view} reads a list`); continue; }
      const limit = r.limit ?? (view && "limit" in view ? view.limit : undefined) ?? READ_DEFAULT;
      if (docs.length > limit) problems.push(`${at} holds ${docs.length} docs; ${r.view} reads at most ${limit}`);
      docs.forEach((d, i) => {
        if (d === null || typeof d !== "object" || !("data" in d)) return void problems.push(`${at}[${i}] is not a doc ({ key, data, ... })`);
        for (const k of Object.keys(d)) if (!DOC_KEYS.has(k)) problems.push(`${at}[${i}].${k} is not a doc's field`);
        for (const f of Object.keys((d as { data: object }).data ?? {})) if (!fields.has(f)) problems.push(`${at}[${i}].data.${f} is not a field of ${view?.collection}`);
      });
      continue;
    }
    if (!("canon" in r) || SHAPED.has(r.canon)) continue;
    const rows = value;
    if (!Array.isArray(rows)) { problems.push(`${at}: ${r.canon} reads a list`); continue; }
    const object = CANON_READS[r.canon].object as string;
    if (object === "facts") {
      const of = r.args?.object;
      const declared = new Set(typeof of === "string" ? manifest.facts?.[of as keyof NonNullable<ModuleManifest["facts"]>]?.read ?? [] : []);
      if (rows.length > FACTS_MAX_IDS) problems.push(`${at} holds ${rows.length} records; facts.forRecords reads at most ${FACTS_MAX_IDS}`);
      rows.forEach((row: { fields?: Array<{ attribute?: string }> }, i) => {
        for (const f of row?.fields ?? []) if (!declared.has(String(f.attribute))) problems.push(`${at}[${i}] has ${f.attribute}, which facts.${String(of)}.read doesn't declare`);
      });
      continue;
    }
    const limit = Math.min(r.limit ?? READ_DEFAULT, MAX_READ_DOCS);
    if (rows.length > limit) problems.push(`${at} holds ${rows.length} records; the read refuses past ${limit}`);
    const allowed = new Set(["id", "createdAt", ...((manifest.reads as Record<string, readonly string[] | undefined> | undefined)?.[object] ?? []), ...(EXTRA_FIELDS[r.canon] ?? []), ...(r.custom ? ["custom"] : [])]);
    rows.forEach((row, i) => {
      if (row === null || typeof row !== "object") return void problems.push(`${at}[${i}] is not a record`);
      for (const k of Object.keys(row)) if (!allowed.has(k)) problems.push(`${at}[${i}].${k}: reads.${object} doesn't grant ${k}`);
      if ("next" in row && i !== rows.length - 1) problems.push(`${at}[${i}].next: only a page's last row carries next`);
    });
  }
  return problems;
}

export type CallInput = { reads?: Record<string, unknown>; args?: Record<string, unknown>; now?: number; caller?: { userId: string; role: Role | "system" }; workspace?: Workspace };

/** A call's context as Canon gives it: `now` (1 January 2026 by default), an admin caller, and the given arguments. */
export const callContext = (input: CallInput = {}): CallContext => ({
  now: input.now ?? Date.UTC(2026, 0, 1), caller: input.caller ?? { userId: "users:test", role: "admin" }, args: input.args ?? {},
  workspace: input.workspace ?? { fiscalYearStartMonth: 1, currency: "USD" },
});

/** Run one call as Canon would hand it these reads, after checking them against the manifest. Throws every problem. */
export async function runCall(manifest: ModuleManifest, calls: CallFunctions, call: string, input: CallInput = {}): Promise<CallOutput> {
  const reads = input.reads ?? {};
  const problems = readProblems(manifest, call, reads);
  const fn = calls[call];
  if (!fn) problems.push(`server code exports no function ${call}`);
  if (problems.length) throw new Error(`${manifest.id} ${call}: ${problems.join("; ")}`);
  return fn!(callContext(input), reads as Record<string, ReadValue>);
}
