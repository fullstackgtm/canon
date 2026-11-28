export const RECORD_MARKDOWN_MAX = 4_000;

const linkPattern = String.raw`\[([^\]\n]+)\]\(\s*([^\s)]+)\s*\)`;

export function recordTextHref(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try { return new URL(value).href; } catch { return undefined; }
}

export function safeRecordMarkdown(markdown: string): boolean {
  return [...markdown.matchAll(new RegExp(linkPattern, "g"))].every((match) => recordTextHref(match[2]) !== undefined);
}

export type RecordTextSpan = { text: string; kind?: "strong" | "em"; href?: string };

export function recordTextSpans(line: string): RecordTextSpan[] {
  const spans: RecordTextSpan[] = [];
  const pattern = new RegExp(`${linkPattern}|\\*\\*([^*]+)\\*\\*|__([^_]+)__|\\*([^*]+)\\*|_([^_]+)_`, "g");
  let offset = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > offset) spans.push({ text: line.slice(offset, match.index) });
    const [, label, url, strong, strongAlt, em, emAlt] = match;
    const href = url && recordTextHref(url);
    if (label) spans.push(href ? { text: label, href } : { text: match[0] });
    else if (strong || strongAlt) spans.push({ text: strong || strongAlt, kind: "strong" });
    else spans.push({ text: em || emAlt, kind: "em" });
    offset = match.index + match[0].length;
  }
  if (offset < line.length) spans.push({ text: line.slice(offset) });
  return spans;
}
