/**
 * A module page as a PDF (docs/modules.md, "Records, exports and print"): what the page's print stylesheet prints,
 * laid out on the server. A small document model (headings, text, labelled fields, figures, tables) is set in
 * Helvetica on US Letter pages, with a header row repeated on each page a table runs onto and "Page i of n" below.
 * Written by hand rather than with a PDF library: no dependency, no fonts to embed (Helvetica is one of the 14 fonts
 * every PDF reader has), and pure, so Convex renders it in its default runtime. Text is WinAnsi (Latin-1 and common
 * punctuation); a character outside it prints as "?".
 */
import { concat } from "./xlsx.ts";
import { parseProse, type ProseRun } from "./prose.ts";

export type PdfBlock =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; tone?: "muted" | "strong" }
  | { kind: "prose"; text: string }
  | { kind: "fields"; items: ReadonlyArray<{ label: string; value: string }>; columns?: number }
  | { kind: "figures"; items: ReadonlyArray<{ label: string; value: string }> }
  | { kind: "table"; columns: ReadonlyArray<{ label: string; align?: "end" }>; rows: ReadonlyArray<{ cells: readonly string[]; group?: boolean }>; total?: readonly string[] }
  /** Another document from a new page: its own heading, title and subtitle (one statement of many). */
  | { kind: "document"; title: string; subtitle?: string; heading?: string };
/** `heading`: a line over the title ("Commission Statement"); `wordmark`: a name at the top right of every page. */
export type PdfDoc = { title: string; subtitle?: string; heading?: string; wordmark?: string; footer?: string; blocks: readonly PdfBlock[] };

const PAGE_W = 612, PAGE_H = 792, MARGIN = 48;
const WIDTH = PAGE_W - 2 * MARGIN;
const TOP = PAGE_H - MARGIN, BOTTOM = MARGIN + 24;

// Helvetica's and Helvetica-Bold's advance widths (per 1000 em) for codes 32 to 126, from Adobe's AFM files.
const REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
/** WinAnsi codes past Latin-1's for the punctuation Intl and people type. */
const WIN_ANSI: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x201e: 0x84, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x2212: 0x2d };
const SPECIAL: Record<number, [number, number]> = { 0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000], 0xa0: [278, 278], 0xa9: [737, 737], 0xb0: [400, 400] };

/** Text as WinAnsi codes: Latin-1 stays, the punctuation above maps, other spaces are spaces, anything else is "?". */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x09 || c === 0x0a || c === 0x0d) out.push(0x20);
    else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN_ANSI[c] !== undefined) out.push(WIN_ANSI[c]);
    else if (c === 0x202f || c === 0x2009 || c === 0x2007 || c === 0x200a) out.push(0x20);
    else if (c >= 0x20) out.push(0x3f);
  }
  return out;
}
const advance = (code: number, bold: boolean) =>
  code >= 32 && code <= 126 ? (bold ? BOLD : REGULAR)[code - 32] : SPECIAL[code]?.[bold ? 1 : 0] ?? (code >= 0xc0 && code <= 0xde ? 722 : 556);
/** How wide `text` sets at `size` points. */
export const textWidth = (text: string, size: number, bold = false) => winAnsi(text).reduce((w, c) => w + advance(c, bold), 0) * size / 1000;

/** A PDF string literal of WinAnsi bytes: printable ASCII as is, the rest as octal escapes. */
const literal = (text: string) => `(${winAnsi(text).map((c) => (c === 0x28 || c === 0x29 || c === 0x5c ? `\\${String.fromCharCode(c)}` : c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : `\\${c.toString(8).padStart(3, "0")}`)).join("")})`;

/** `text` broken into lines no wider than `width`; a word too long for a line is broken where it must be. */
export function wrap(text: string, size: number, width: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width + 0.01) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (textWidth(line, size, bold) > width + 0.01 && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > width + 0.01) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

function wrapRuns(runs: readonly ProseRun[], size: number, width: number): ProseRun[][] {
  type Glyph = { text: string; bold?: true };
  const lines: Glyph[][] = [];
  let line: Glyph[] = [], used = 0;
  for (const run of runs) for (const text of run.text) {
    if (!line.length && text === " ") continue;
    line.push({ text, ...(run.bold ? { bold: true as const } : {}) });
    used += textWidth(text, size, run.bold);
    while (used > width + 0.01 && line.length > 1) {
      let space = line.length - 1;
      while (space >= 0 && line[space].text !== " ") space--;
      const cut = space > 0 ? space : line.length - 1;
      lines.push(line.slice(0, cut));
      line = line.slice(cut + (space > 0 ? 1 : 0));
      used = line.reduce((sum, g) => sum + textWidth(g.text, size, g.bold), 0);
    }
  }
  if (line.length) lines.push(line);
  return lines.map((glyphs) => {
    const out: ProseRun[] = [];
    for (const glyph of glyphs) {
      const prior = out.at(-1);
      if (prior && prior.bold === glyph.bold) prior.text += glyph.text;
      else out.push({ ...glyph });
    }
    return out;
  });
}

/** Lays blocks onto pages: each page a list of drawing operators. */
class Layout {
  pages: string[][] = [[]];
  y = TOP;
  get ops() { return this.pages[this.pages.length - 1]; }
  newPage() { this.pages.push([]); this.y = TOP; }
  /** Room for `h` more points on this page, else a new page. */
  need(h: number) { if (this.y - h < BOTTOM) this.newPage(); }
  text(x: number, y: number, s: string, size: number, bold = false, gray = 0) {
    this.ops.push(`BT ${gray ? `${gray} g ` : ""}/${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${literal(s)} Tj ET${gray ? " 0 g" : ""}`);
  }
  rule(y: number, gray = 0.8, x = MARGIN, w = WIDTH) { this.ops.push(`${gray} G 0.5 w ${x} ${y.toFixed(2)} m ${x + w} ${y.toFixed(2)} l S 0 G`); }
  fill(x: number, y: number, w: number, h: number, gray: number) { this.ops.push(`${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`); }
}

/**
 * Each column's width: its widest cell (header included) where they all fit. Else each gets at least its longest
 * word (so an amount never breaks), and the rest of the line is shared out by how much more each column holds.
 */
function columnWidths(header: readonly string[], rows: ReadonlyArray<{ cells: readonly string[]; group?: boolean }>, size: number): number[] {
  const pad = 8;
  const sample = rows.slice(0, 400);
  const want = header.map((h, j) => Math.max(textWidth(h, size, true), ...sample.map((r) => textWidth(r.cells[j] ?? "", size, r.group === true))) + pad);
  const sum = want.reduce((a, b) => a + b, 0);
  if (sum <= WIDTH) return want.map((w) => w + (WIDTH - sum) / want.length);
  const longest = (t: string, bold: boolean) => Math.max(0, ...t.split(/ +/).map((w) => textWidth(w, size, bold)));
  let min = header.map((h, j) => Math.min(WIDTH / 2, Math.max(longest(h, true), ...sample.map((r) => longest(r.cells[j] ?? "", r.group === true))) + pad));
  const floor = min.reduce((a, b) => a + b, 0);
  if (floor >= WIDTH) return min.map((w) => (w * WIDTH) / floor);
  min = min.map((w, j) => Math.min(w, want[j]));
  const extra = WIDTH - min.reduce((a, b) => a + b, 0);
  const more = want.map((w, j) => w - min[j]);
  const total = more.reduce((a, b) => a + b, 0) || 1;
  return min.map((w, j) => w + (extra * more[j]) / total);
}

/** A document's heading, title and subtitle at the top of a page. */
function titled(l: Layout, d: { title: string; subtitle?: string; heading?: string }) {
  if (d.heading) { l.y -= 12; l.text(MARGIN, l.y, d.heading.toUpperCase(), 9, true, 0.4); }
  for (const line of wrap(d.title, 18, WIDTH, true)) { l.y -= 22; l.text(MARGIN, l.y, line, 18, true); }
  if (d.subtitle) for (const line of wrap(d.subtitle, 10, WIDTH)) { l.y -= 14; l.text(MARGIN, l.y, line, 10, false, 0.4); }
  l.y -= 8;
}

/** Several documents as one: the first's title, then each from a new page under its own. */
export function joinDocs(docs: readonly PdfDoc[]): PdfDoc {
  const [first, ...rest] = docs;
  return { ...first, blocks: [...first.blocks, ...rest.flatMap((d): PdfBlock[] => [{ kind: "document", title: d.title, ...(d.subtitle ? { subtitle: d.subtitle } : {}), ...(d.heading ? { heading: d.heading } : {}) }, ...d.blocks])] };
}

function block(l: Layout, b: PdfBlock) {
  switch (b.kind) {
    case "document": {
      l.newPage();
      titled(l, b);
      return;
    }
    case "heading": {
      l.need(28);
      l.y -= 18;
      l.text(MARGIN, l.y, b.text, 12, true);
      l.y -= 6;
      l.rule(l.y);
      l.y -= 4;
      return;
    }
    case "text": {
      const size = 10;
      for (const line of wrap(b.text, size, WIDTH, b.tone === "strong")) { l.need(14); l.y -= 14; l.text(MARGIN, l.y, line, size, b.tone === "strong", b.tone === "muted" ? 0.4 : 0); }
      l.y -= 4;
      return;
    }
    case "prose": {
      const draw = (runs: readonly ProseRun[], bullet: boolean) => {
        const indent = bullet ? 12 : 0;
        wrapRuns(runs, 10, WIDTH - indent).forEach((line, i) => {
          l.need(14); l.y -= 14;
          if (bullet && i === 0) l.text(MARGIN, l.y, "•", 10);
          let x = MARGIN + indent;
          for (const run of line) { l.text(x, l.y, run.text, 10, run.bold); x += textWidth(run.text, 10, run.bold); }
        });
      };
      for (const part of parseProse(b.text)) {
        if (part.kind === "paragraph") draw(part.runs, false);
        else for (const item of part.items) draw(item, true);
        l.y -= 6;
      }
      return;
    }
    case "fields": case "figures": {
      const cols = b.kind === "figures" ? Math.min(4, Math.max(1, b.items.length)) : Math.min(4, Math.max(1, b.columns ?? 2));
      const w = WIDTH / cols;
      const valueSize = b.kind === "figures" ? 14 : 10;
      l.y -= 6;
      for (let i = 0; i < b.items.length; i += cols) {
        const row = b.items.slice(i, i + cols);
        const lines = row.map((x) => wrap(x.value || "-", valueSize, w - 12, b.kind === "figures"));
        const h = 12 + Math.max(...lines.map((ls) => ls.length)) * (valueSize + 3) + 8;
        l.need(h);
        row.forEach((x, k) => {
          const x0 = MARGIN + k * w;
          l.text(x0, l.y - 10, x.label, 8, false, 0.4);
          lines[k].forEach((line, j) => l.text(x0, l.y - 12 - (j + 1) * (valueSize + 3) + 2, line, valueSize, b.kind === "figures"));
        });
        l.y -= h;
      }
      return;
    }
    case "table": {
      const size = 8.5, lineH = 11;
      const header = b.columns.map((c) => c.label);
      const widths = columnWidths(header, [...b.rows, ...(b.total ? [{ cells: b.total, group: true }] : [])], size);
      const xs = widths.reduce<number[]>((acc, w, j) => [...acc, j ? acc[j - 1] + widths[j - 1] : MARGIN], []);
      const draw = (cells: readonly string[], bold: boolean, shade?: number) => {
        const lines = cells.map((c, j) => wrap(c ?? "", size, widths[j] - 8, bold));
        const h = Math.max(1, ...lines.map((ls) => ls.length)) * lineH + 5;
        if (l.y - h < BOTTOM) { l.newPage(); head(); }
        if (shade) l.fill(MARGIN, l.y - h, WIDTH, h, shade);
        lines.forEach((ls, j) => ls.forEach((line, k) => {
          const x = b.columns[j]?.align === "end" ? xs[j] + widths[j] - 4 - textWidth(line, size, bold) : xs[j] + 4;
          l.text(x, l.y - (k + 1) * lineH + 1, line, size, bold);
        }));
        l.y -= h;
        l.rule(l.y, 0.88);
      };
      const head = () => draw(header, true, 0.94);
      l.need(40);
      l.y -= 6;
      head();
      for (const r of b.rows) draw(r.cells, r.group === true, r.group ? 0.97 : undefined);
      if (b.total) draw(b.total, true);
      l.y -= 6;
      return;
    }
  }
}

/** The document as PDF bytes: its title and subtitle, its blocks, and a footer on every page. */
export function pdf(doc: PdfDoc): Uint8Array {
  const l = new Layout();
  titled(l, doc);
  for (const b of doc.blocks) block(l, b);
  const n = l.pages.length;
  l.pages.forEach((ops, i) => {
    const label = `Page ${i + 1} of ${n}`;
    if (doc.wordmark) ops.push(`BT 0.25 g /F2 10 Tf ${(PAGE_W - MARGIN - textWidth(doc.wordmark, 10, true)).toFixed(2)} ${PAGE_H - MARGIN + 18} Td ${literal(doc.wordmark)} Tj ET 0 g`);
    ops.push(`BT 0.4 g /F1 8 Tf ${MARGIN} ${MARGIN} Td ${literal(doc.footer ?? "")} Tj ET 0 g`);
    ops.push(`BT 0.4 g /F1 8 Tf ${(PAGE_W - MARGIN - textWidth(label, 8)).toFixed(2)} ${MARGIN} Td ${literal(label)} Tj ET 0 g`);
  });
  // Objects: 1 catalog, 2 pages, 3 and 4 the fonts, 5 the info, then each page and its content stream.
  const objects: string[] = [];
  const kids = l.pages.map((_, i) => `${6 + 2 * i} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objects.push(`<< /Title ${literal(doc.title)} /Producer (Canon) >>`);
  l.pages.forEach((ops, i) => {
    const stream = ops.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + 2 * i} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  // Every byte is ASCII (strings escape the rest), so a string's length is its byte count.
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return concat([new TextEncoder().encode(body)]);
}
