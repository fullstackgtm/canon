export type ProseRun = { text: string; bold?: true };
export type ProseBlock =
  | { kind: "paragraph"; runs: ProseRun[] }
  | { kind: "list"; items: ProseRun[][] };

function inline(text: string): ProseRun[] {
  const runs: ProseRun[] = [];
  let at = 0;
  for (const match of text.matchAll(/\*\*(.+?)\*\*/g)) {
    if (match.index > at) runs.push({ text: text.slice(at, match.index) });
    runs.push({ text: match[1], bold: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}

/** A deliberately small grammar: blank-line paragraphs, `- ` bullets and paired `**` emphasis. */
export function parseProse(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let paragraph: string[] = [];
  let items: ProseRun[][] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", runs: inline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (items.length) blocks.push({ kind: "list", items });
    items = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (line.startsWith("- ") && line.slice(2).trim()) {
      flushParagraph();
      items.push(inline(line.slice(2).trim().replace(/[\t ]+/g, " ")));
    } else {
      flushList();
      paragraph.push(line.trim().replace(/[\t ]+/g, " "));
    }
  }
  flushParagraph(); flushList();
  return blocks;
}
