/**
 * An export as an Excel workbook (docs/modules.md, "Records, exports and print"): one sheet, a bold header row, and
 * each cell typed by its column, so money and numbers sum and dates sort in Excel. Written by hand (a zip of a few
 * XML parts, stored without compression) rather than with a spreadsheet library: no dependency, and pure, so Convex
 * builds it in its default runtime and tests read it back.
 */

/** How a column's cells are typed: money (2 decimals), a number, a date (`YYYY-MM-DD`), or text. */
export type CellKind = "money" | "number" | "date" | "text";

const enc = new TextEncoder();

/** CRC-32 (IEEE), as a zip entry records it. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Files in a zip, stored (method 0): what an .xlsx is. */
export function zipStore(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: DataView, at: number, x: number) => v.setUint16(at, x, true);
  const u32 = (v: DataView, at: number, x: number) => v.setUint32(at, x >>> 0, true);
  // 1980-01-01 00:00, the zip epoch: the same bytes for the same rows.
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0); u16(lv, 10, 0); u16(lv, 12, DOS_DATE);
    u32(lv, 14, crc); u32(lv, 18, f.data.length); u32(lv, 22, f.data.length); u16(lv, 26, name.length); u16(lv, 28, 0);
    local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const hv = new DataView(head.buffer);
    u32(hv, 0, 0x02014b50); u16(hv, 4, 20); u16(hv, 6, 20); u16(hv, 8, 0x0800); u16(hv, 10, 0); u16(hv, 12, 0); u16(hv, 14, DOS_DATE);
    u32(hv, 16, crc); u32(hv, 20, f.data.length); u32(hv, 24, f.data.length); u16(hv, 28, name.length); u16(hv, 30, 0); u16(hv, 32, 0);
    u16(hv, 34, 0); u16(hv, 36, 0); u32(hv, 38, 0); u32(hv, 42, offset);
    head.set(name, 46);
    parts.push(local, f.data);
    central.push(head);
    offset += local.length + f.data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, files.length); u16(ev, 10, files.length); u32(ev, 12, size); u32(ev, 16, offset); u16(ev, 20, 0);
  return concat([...parts, ...central, end]);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
  // Characters XML 1.0 can't hold (control characters but tab and line breaks) are left out.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
/** A column's letters: 0 is A, 26 is AA. */
const col = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : col(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
/** A date as Excel's serial day (1900 system): days since 1899-12-30. */
const serial = (d: string) => (Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** One cell's XML: a number, a date or money as a styled number, else inline text. Empty cells are left out. */
function cell(ref: string, value: string, kind: CellKind): string {
  if (value === "") return "";
  if (kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return `<c r="${ref}" s="1"><v>${serial(value)}</v></c>`;
  if ((kind === "money" || kind === "number") && NUMBER.test(value)) return `<c r="${ref}"${kind === "money" ? ' s="2"' : ""}><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

/**
 * A workbook of one sheet: `header` in bold, then `rows`, each column's cells typed by `kinds` (text by default). Text
 * that looks like a formula stays text: an inline string is never run.
 */
export function xlsx(sheet: string, header: readonly string[], rows: ReadonlyArray<readonly string[]>, kinds: readonly CellKind[] = []): Uint8Array {
  const name = xml(sheet.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet1");
  const line = (r: readonly string[], i: number, head: boolean) =>
    `<row r="${i + 1}">${r.map((v, j) => (head ? (v === "" ? "" : `<c r="${col(j)}${i + 1}" t="inlineStr" s="3"><is><t xml:space="preserve">${xml(v)}</t></is></c>`) : cell(`${col(j)}${i + 1}`, v, kinds[j] ?? "text"))).join("")}</row>`;
  const width = header.length;
  const cols = width ? `<cols><col min="1" max="${width}" width="18" customWidth="1"/></cols>` : "";
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${[line(header, 0, true), ...rows.map((r, i) => line(r, i + 1, false))].join("")}</sheetData></worksheet>`;
  const files: Array<[string, string]> = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    // Styles: 0 plain, 1 a date, 2 money (#,##0.00), 3 a bold header.
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ["xl/worksheets/sheet1.xml", sheetXml],
  ];
  return zipStore(files.map(([n, d]) => ({ name: n, data: enc.encode(d) })));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Bytes as base64, for a file an action hands back. */
export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? "=" : B64[c & 63]);
  }
  return out;
}
