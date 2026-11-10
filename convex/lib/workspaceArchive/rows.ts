/**
 * One row as an archive writes it: every value a schema validator declares `v.id(table)` becomes
 * `{"$ref": table, "id": old}`, so an import can remap ids mechanically. Ids inside strings (source refs, actor ids,
 * fact ids) are left verbatim and counted per grammar, so the import knows its remaining work. Storage ids are refs to
 * `_storage`, counted because archives do not carry files yet.
 *
 * Pure: no imports.
 */

/** The parts of a Convex validator this reads (convex/values `Validator` at runtime). */
export type ValidatorShape =
  | { kind: "id"; tableName: string }
  | { kind: "object"; fields: Record<string, ValidatorShape> }
  | { kind: "array"; element: ValidatorShape }
  | { kind: "union"; members: ValidatorShape[] }
  | { kind: "record"; key: ValidatorShape; value: ValidatorShape }
  | { kind: string };

/** Which of `tables` the id belongs to, or null when it is none of theirs (ctx.db.normalizeId). */
export type IdResolver = (id: string, tables: readonly string[]) => string | null;

export type RowStats = { rows: number; storageRefs: number; embedded: Record<string, number> };
export const emptyStats = (): RowStats => ({ rows: 0, storageRefs: 0, embedded: {} });

const ID = "[0-9a-z]{31,37}";
/** Ids Canon writes inside strings (convex/lib/canon/partyLedger.ts, dealLedger.ts, decider.ts, lib/objects/fold.ts factIdOf, lib/automations.ts, agentTurns.ts, dealState.ts, conversations.ts). */
export const EMBEDDED_ID_GRAMMARS: Readonly<Record<string, RegExp>> = {
  "user:<userId>": new RegExp(`\\buser:${ID}`, "g"),
  "agent:<agentId>": new RegExp(`\\bagent:${ID}`, "g"),
  "grant:<grantId>": new RegExp(`\\bgrant:${ID}`, "g"),
  "automation:<ruleId>:": new RegExp(`\\bautomation:${ID}:`, "g"),
  "module:<moduleId>:plan:<planId>": new RegExp(`\\bmodule:\\S+?:plan:${ID}`, "g"),
  "canon_field:<fieldId>:<streamId>": new RegExp(`\\bcanon_field:${ID}:${ID}`, "g"),
  "import:deal:<dealId>": new RegExp(`\\bimport:deal:${ID}`, "g"),
  "<streamId>@<version>#<index>": new RegExp(`\\b${ID}@\\d+#\\d+`, "g"),
  "deal.stage_changed:<dealId>@<version>": new RegExp(`\\bdeal\\.stage_changed:${ID}@\\d+`, "g"),
  "<streamId>:stages": new RegExp(`(?<![0-9a-z])${ID}:stages\\b`, "g"),
  "call:<callOrConversationId>": new RegExp(`^call:${ID}$`, "g"),
  "deal:<streamId>:<key>": new RegExp(`^deal:${ID}:`, "g"),
  "emaillog:<userId>": new RegExp(`\\bemaillog:${ID}(?![0-9a-z])`, "g"),
  "<sourceKind>:<label>:<recordId>[:<attribute>]": new RegExp(`\\b(?:agent_run|enrichment|call|email|linkedin|pipeline):\\S*?:${ID}(?=:[A-Za-z0-9_.]+$|$)`, "g"),
  "acc_s_/con_s_<hash of a stream id>": /\b(?:acc|con)_s_[0-9a-f]{20}\b/g,
  "a bare id in a string field": new RegExp(`^${ID}$`, "g"),
};

function countEmbedded(text: string, stats: RowStats) {
  for (const [name, pattern] of Object.entries(EMBEDDED_ID_GRAMMARS)) {
    const n = text.match(pattern)?.length ?? 0;
    if (n) stats.embedded[name] = (stats.embedded[name] ?? 0) + n;
  }
}

const flatten = (vs: readonly ValidatorShape[]): ValidatorShape[] => vs.flatMap((v) => (v.kind === "union" ? flatten((v as { members: ValidatorShape[] }).members) : [v]));

function encode(validators: readonly ValidatorShape[], value: unknown, resolve: IdResolver, stats: RowStats): unknown {
  const vs = flatten(validators);
  if (typeof value === "string") {
    const tables = vs.filter((v): v is { kind: "id"; tableName: string } => v.kind === "id").map((v) => v.tableName);
    const table = tables.length ? resolve(value, tables) : null;
    if (table) {
      if (table === "_storage") stats.storageRefs++;
      return { $ref: table, id: value };
    }
    countEmbedded(value, stats);
    return value;
  }
  if (typeof value === "bigint") return { $int64: value.toString() };
  if (value instanceof ArrayBuffer) return { $bytes: bytesToBase64(new Uint8Array(value)) };
  if (Array.isArray(value)) {
    const elements = vs.filter((v) => v.kind === "array").map((v) => (v as { element: ValidatorShape }).element);
    return value.map((item) => encode(elements, item, resolve, stats));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const fields = vs.flatMap((v) => (v.kind === "object" ? [(v as { fields: Record<string, ValidatorShape> }).fields[key]].filter(Boolean) : v.kind === "record" ? [(v as { value: ValidatorShape }).value] : []));
      out[key] = encode(fields, item, resolve, stats);
    }
    return out;
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A value encoded as a row's fields are, for rows with no schema (the record service's register). */
export const encodeValue = (validator: ValidatorShape, value: unknown, resolve: IdResolver, stats: RowStats) => encode([validator], value, resolve, stats);

/** The row as an archive line: `omit` drops fields, `pick` keeps only the system fields and these. */
export function encodeRow(validator: ValidatorShape, row: Record<string, unknown>, resolve: IdResolver, stats: RowStats, opts: { omit?: readonly string[]; pick?: readonly string[] } = {}): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (opts.omit?.includes(key)) continue;
    if (opts.pick && !key.startsWith("_") && !opts.pick.includes(key)) continue;
    kept[key] = value;
  }
  const { _id, _creationTime, ...fields } = kept;
  stats.rows++;
  return JSON.stringify({ _id, _creationTime, ...(encode([validator], fields, resolve, stats) as Record<string, unknown>) });
}
