// Ids, CSV and small helpers shared by the simulator.

const SUFFIX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** 18-character form of a 15-character Salesforce id. */
export function to18(id15: string): string {
  let suffix = "";
  for (let block = 0; block < 3; block++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const ch = id15[block * 5 + i];
      if (ch >= "A" && ch <= "Z") bits |= 1 << i;
    }
    suffix += SUFFIX[bits];
  }
  return id15 + suffix;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Deterministic id: 3-char key prefix + "Sm" + base62 counter (10 chars) + checksum suffix. */
export function makeId(prefix: string, n: number): string {
  let s = "";
  let v = n;
  for (let i = 0; i < 10; i++) {
    s = B62[v % 62] + s;
    v = Math.floor(v / 62);
  }
  return to18(`${prefix}Sm${s}`);
}

/** mulberry32: small deterministic PRNG. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Salesforce datetime format: 2026-01-02T03:04:05.000+0000 */
export const sfDateTime = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");
/** Parse Salesforce or ISO datetimes/dates to epoch ms (NaN if not a date). */
export const toMs = (s: string) => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

// ---------- CSV (RFC 4180) ----------

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return `"${s.replaceAll('"', '""')}"`;
}

export function toCsv(header: string[], rows: Array<Record<string, unknown>>, lineEnding = "\n"): string {
  const out = [header.map(csvEscape).join(",")];
  for (const r of rows) out.push(header.map((h) => csvEscape(r[h])).join(","));
  return out.join(lineEnding) + lineEnding;
}

/** Parse CSV text into rows of strings keyed by header. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let any = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') (field += '"'), (i += 2);
        else (quoted = false), i++;
      } else (field += ch), i++;
      continue;
    }
    if (ch === '"') (quoted = true), (any = true), i++;
    else if (ch === ",") row.push(field), (field = ""), (any = true), i++;
    else if (ch === "\r" || ch === "\n") {
      if (any || field || row.length) row.push(field), rows.push(row);
      row = [];
      field = "";
      any = false;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else (field += ch), (any = true), i++;
  }
  if (any || field || row.length) row.push(field), rows.push(row);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}
