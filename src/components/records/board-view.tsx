"use client";

import type { ViewFilter } from "../../../convex/lib/objects/validators";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ListRow, ListSort } from "../../../convex/lib/objects/listSpec";
import { formatValue, type FieldDescription, type TeamMember } from "./fields";
import { useLookupTitles } from "./lookup-field";
import { RecordQuickView } from "./record-context";
import { recordHref } from "./record-target";
import { useObjectList, type ListedObject, type Save } from "./use-object-list";
import { cn, formatCurrency } from "@/lib/utils";

const CARD_LIMIT = 50;
const NONE = "";

/** Saves the board has made, with a counter so a column reloads once per batch. */
export type BoardSaves = { n: number; saves: Save[] };
export type BoardColumnSpec = { value: string; label: string; accepts: boolean };
/** A column's count and amount (cents), shown in its header in place of the list total. */
export type ColumnTotal = { count: number; amount: number };

function BoardColumn({
  object, label, value, groupBy, filter, sort, watch, onStale, cardFields, team, saves, writable, accepts, hrefOf, onDrop, sum,
}: {
  sum?: ColumnTotal;
  watch: readonly string[];
  onStale: () => void;
  object: ListedObject;
  sort?: ListSort;
  /** Whether cards can be dropped here: not on an inactive option. */
  accepts: boolean;
  label: string;
  value: string;
  groupBy: FieldDescription;
  filter: ViewFilter[];
  cardFields: readonly FieldDescription[];
  team?: readonly TeamMember[];
  saves: BoardSaves;
  writable: boolean;
  hrefOf: (row: ListRow) => string;
  onDrop: (row: ListRow, value: string) => void;
}) {
  const own: ViewFilter = value === NONE ? { field: groupBy.apiName, op: "empty" } : { field: groupBy.apiName, op: "eq", value };
  // The column's own predicate narrows the view's filters; a column the filters exclude stays empty.
  const query = { object, filter: [...filter, own], ...(sort ? { sort } : {}), limit: CARD_LIMIT };
  const { rows, total, reload, error } = useObjectList(query, { watch, onStale });
  const [over, setOver] = useState(false);
  // A company on a card reads by name, as it does in the table.
  const lookupTitles = useLookupTitles(cardFields.filter((f) => f.type === "lookup"), rows);

  useEffect(() => {
    if (saves.n > 0) void reload(saves.saves);
  }, [saves, reload]);

  return (
    <section
      aria-label={`${label} column`}
      onDragOver={(e) => {
        if (!accepts) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!accepts) return;
        const raw = e.dataTransfer.getData("application/x-canon-row");
        if (raw) onDrop(JSON.parse(raw) as ListRow, value);
      }}
      className={cn("flex w-72 shrink-0 flex-col border border-border bg-muted/30", over && "border-primary bg-primary/5")}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-medium">
        <span>{label}</span>
        <span className="text-muted-foreground">{sum ? `${sum.count} · ${formatCurrency(sum.amount)}` : rows === null ? "…" : total}</span>
      </header>
      <div className="flex min-h-24 flex-col gap-2 p-2">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {rows?.map((row) => (
          <article
            key={row.id}
            draggable={writable}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-canon-row", JSON.stringify(row));
              e.dataTransfer.effectAllowed = "move";
            }}
            className="relative border border-border bg-card p-2 text-sm shadow-sm hover:border-primary/50"
          >
            <div className="flex items-start gap-1">
              <Link
                href={hrefOf(row)}
                draggable={false}
                className="min-w-0 flex-1 font-medium after:absolute after:inset-0 hover:underline"
              >
                {row.title || "Untitled"}
              </Link>
              <RecordQuickView object={object} id={row.id} label={row.title || "Untitled"} className="relative z-[1]" />
            </div>
            {cardFields.map((f) => {
              const raw = row.values[f.fieldId];
              if (f.type === "lookup" && "lookupTo" in f && typeof raw === "string" && raw) {
                return (
                  <div key={f.fieldId} className="truncate text-xs text-muted-foreground">
                    {f.label}: <Link href={recordHref(f.lookupTo as ListedObject, raw)} draggable={false} className="relative z-[1] underline">{lookupTitles[raw] ?? raw}</Link>
                  </div>
                );
              }
              const shown = formatValue(f, raw as never, team);
              return shown ? <div key={f.fieldId} className="truncate text-xs text-muted-foreground">{f.label}: {shown}</div> : null;
            })}
          </article>
        ))}
        {rows !== null && total > rows.length && <p className="px-1 text-xs text-muted-foreground">{total - rows.length} more; filter to narrow</p>}
      </div>
    </section>
  );
}

/** A board: one column per option of a picklist, plus one for records with none. Dragging a card sets the field. */
export function BoardView({
  object, groupBy, filter, sort, watch, onStale, cardFields, team, writable, hrefOf, onMove, saves, columns: given, totals,
}: {
  /** Columns in place of the picklist's options (a deal pipeline's stages). */
  columns?: readonly BoardColumnSpec[];
  totals?: ReadonlyMap<string, ColumnTotal>;
  /** Membership fields (use-object-list watch), with the grouping field. */
  watch: readonly string[];
  /** Another person's edit moved a card: reload every column. */
  onStale: () => void;
  object: ListedObject;
  sort?: ListSort;
  groupBy: FieldDescription;
  filter: ViewFilter[];
  cardFields: readonly FieldDescription[];
  team?: readonly TeamMember[];
  writable: boolean;
  hrefOf: (row: ListRow) => string;
  onMove: (row: ListRow, value: string | null) => void;
  saves: BoardSaves;
}) {
  // Inactive options keep a column, so records that still hold one stay on the board; nothing can be dropped into it.
  const options = "options" in groupBy ? groupBy.options : [];
  const columns = given ?? [
    ...options.map((o) => ({ value: o.value, label: o.active ? o.label : `${o.label} (inactive)`, accepts: o.active })),
    { value: NONE, label: `No ${groupBy.label.toLowerCase()}`, accepts: true },
  ];
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {columns.map((c) => (
        <BoardColumn
          key={c.value}
          object={object}
          label={c.label}
          value={c.value}
          groupBy={groupBy}
          filter={filter}
          sort={sort}
          watch={[...watch, groupBy.fieldId]}
          onStale={onStale}
          cardFields={cardFields}
          team={team}
          saves={saves}
          writable={writable}
          accepts={writable && c.accepts}
          hrefOf={hrefOf}
          sum={totals ? totals.get(c.value) ?? { count: 0, amount: 0 } : undefined}
          onDrop={(row, value) => {
            const current = row.values[groupBy.fieldId] ?? NONE;
            if (current !== value) onMove(row, value === NONE ? null : value);
          }}
        />
      ))}
    </div>
  );
}
