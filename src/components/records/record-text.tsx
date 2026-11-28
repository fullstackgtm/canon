import { createElement } from "react";
import { recordTextSpans } from "../../../recipes/recordText";

const listItem = /^(?:([-+*])|(\d+)\.)\s+(.+)$/;
const heading = /^(#{1,6})\s+(.+)$/;

function inline(line: string) {
  return recordTextSpans(line).map(({ text, kind, href }, i) =>
    href ? <a key={i} href={href} className="text-primary underline">{text}</a> :
      kind ? createElement(kind, { key: i }, text) : text);
}

export function RecordText({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const start = i;
    const line = lines[i++];
    if (!line) continue;
    const title = heading.exec(line);
    if (title) {
      blocks.push(createElement(`h${Math.min(title[1].length + 1, 6)}`, { key: start, className: "font-semibold" }, inline(title[2])));
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      const items = [item[3]];
      for (let next = listItem.exec(lines[i] ?? ""); next && Boolean(next[2]) === ordered; next = listItem.exec(lines[i] ?? "")) {
        items.push(next[3]);
        i++;
      }
      blocks.push(createElement(ordered ? "ol" : "ul", {
        key: start, className: ordered ? "list-decimal pl-5" : "list-disc pl-5", ...(ordered ? { start: Number(item[2]) } : {}),
      }, items.map((text, n) => <li key={n}>{inline(text)}</li>)));
      continue;
    }
    const paragraph = [line];
    while (lines[i] && !heading.test(lines[i]) && !listItem.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={start}>{inline(paragraph.join(" "))}</p>);
  }
  return <div className="space-y-2 break-words record-value">{blocks}</div>;
}
