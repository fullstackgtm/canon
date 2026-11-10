import { Fragment } from "react";
import { parseProse, type ProseRun } from "../../../modules/kernel/prose";

const runs = (items: readonly ProseRun[]) => items.map((run, i) => run.bold ? <strong key={i}>{run.text}</strong> : <Fragment key={i}>{run.text}</Fragment>);

export function ModuleProse({ text }: { text: string }) {
  return <div className="max-w-[72ch] space-y-3 break-words text-sm leading-relaxed">
    {parseProse(text).map((block, i) => block.kind === "paragraph"
      ? <p key={i}>{runs(block.runs)}</p>
      : <ul key={i} className="list-disc space-y-1 pl-5">{block.items.map((item, j) => <li key={j}>{runs(item)}</li>)}</ul>)}
  </div>;
}
