"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { Eye } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { CompiledRecipe } from "../../../../recipes/md/parse";
import { pageOf, type PageObject } from "../../../../recipes";
import { RecordPage } from "@/components/records/record-page";
import { SelectField } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const OBJECTS: readonly PageObject[] = ["deal", "account", "contact"];
const PICKS = 5;

/** Which page a line of recipe.md lays out: the `{page=…}` heading above it, else the deal's. */
export function pageAtLine(markdown: string, line: number): PageObject {
  const lines = markdown.split("\n").slice(0, line);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^# .*\{[^}]*\bpage=(account|contact)\b/.exec(lines[i]);
    if (m) return m[1] as PageObject;
    if (/^# /.test(lines[i]) && i > 0) return "deal";
  }
  return "deal";
}

/**
 * The recipe editor's live preview (docs/recipes.md, "Customizing in the app"): a real record of this workspace, laid
 * out by the draft's page and actions through the app's own record page. It is inert, so its actions show but never
 * run. `recipe` is the last draft that checked clean; `stale` marks it once the draft has errors.
 */
export function RecipePreview({ recipe, stale, focus }: { recipe: CompiledRecipe; stale: boolean; focus: PageObject }) {
  const names = useObjectLabels();
  const pages = OBJECTS.filter((o) => pageOf(recipe, o).length > 0);
  // A tab picked holds until the caret moves into another page of recipe.md.
  const [picked, setPicked] = useState<{ object: PageObject; focus: PageObject } | null>(null);
  const chosen = picked?.focus === focus ? picked.object : focus;
  const object = pages.includes(chosen) ? chosen : pages[0];
  const list = useAction(api.objects.list);
  const [rows, setRows] = useState<Partial<Record<PageObject, Array<{ id: string; title: string }>>>>({});
  const [id, setId] = useState<Partial<Record<PageObject, string>>>({});

  useEffect(() => {
    if (!object || rows[object]) return;
    let live = true;
    void list({ object, limit: PICKS }).then(
      (r) => { if (live) setRows((all) => ({ ...all, [object]: r.rows.map((row) => ({ id: row.id, title: row.title || "Untitled" })) })); },
      () => { if (live) setRows((all) => ({ ...all, [object]: [] })); },
    );
    return () => { live = false; };
  }, [list, object, rows]);

  if (!object) return <p className="p-4 text-sm text-muted-foreground">This customization lays out no record page, so there is nothing to preview.</p>;
  const choices = rows[object];
  const current = id[object] ?? choices?.[0]?.id;
  return (
    <section aria-label="Preview" className="flex min-h-0 min-w-0 flex-col border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="flex items-center gap-1 font-medium"><Eye className="h-3.5 w-3.5" />Preview</span>
        <div role="tablist" className="flex gap-1">
          {pages.map((o) => (
            <button key={o} type="button" role="tab" aria-selected={o === object} onClick={() => setPicked({ object: o, focus })}
              className={cn("border px-1.5 py-0.5", o === object ? "border-foreground" : "border-border text-muted-foreground hover:bg-muted")}>{names(o)!.label}</button>
          ))}
        </div>
        {choices && choices.length > 1 && (
          <SelectField aria-label="Record" value={current ?? ""} onValueChange={(v) => setId((all) => ({ ...all, [object]: v }))}
            options={choices.map((r) => ({ value: r.id, label: r.title }))} className="min-w-0 max-w-48" />
        )}
        <span className={cn("ml-auto", stale ? "font-medium text-warning" : "text-muted-foreground")}>
          {stale ? "Stale: the draft has errors, so this is the last version that checked clean" : "Read-only: actions show but don't run"}
        </span>
      </div>
      <div className={cn("min-h-0 flex-1 overflow-auto", stale && "opacity-60")}>
        {choices === undefined ? <p className="p-4 text-sm text-muted-foreground">Finding a record…</p>
          : !current ? <p className="p-4 text-sm text-muted-foreground">This workspace has no {names(object)!.label.toLowerCase()} records to preview.</p>
          : <div inert className="pointer-events-none select-none">
              <RecordPage key={`${object}:${current}`} object={object} id={current} layout={{ page: pageOf(recipe, object), hasPlays: object === "deal" && recipe.data !== null }} />
            </div>}
      </div>
    </section>
  );
}
