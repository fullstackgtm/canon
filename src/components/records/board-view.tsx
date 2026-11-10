"use client";

import type { ViewFilter } from "../../../modules/kernel/reportValidators";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, Lock } from "lucide-react";
import type { ListRow, ListSort, Scalar } from "../../../convex/lib/objects/listSpec";
import { boardColumns, type BoardColumnOf } from "../../../convex/lib/objects/views";
import { ReadFailure } from "@/components/dashboard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatValue, type FieldDescription, type TeamMember } from "./fields";
import { useLookupTitles } from "./lookup-field";
import { moneyText, useWorkspaceMoney } from "./money";
import { RecordQuickView } from "./record-context";
import { recordHref } from "./record-target";
import { useGroups } from "./use-groups";
import { useObjectList, type ListedObject, type Save } from "./use-object-list";
import { cn } from "@/lib/utils";

/** Cards a column shows before "Show more", which adds a page of the list's own size (50). */
const COLUMN_CARDS = 20;
const ROW_TYPE = "application/x-canon-row";
const keyId = (key: Scalar | null) => JSON.stringify(key);

/** Saves the board has made, with a counter so a column reloads once per batch. */
export type BoardSaves = { n: number; saves: Save[] };
/** A column given in place of the field's own (a deal pipeline's stages): `value` "" holds the records with none. */
export type BoardColumnSpec = { value: string; label: string; accepts: boolean };
/** A column's count and amount (cents), shown in its header. */
export type ColumnTotal = { count: number; amount: number };

function BoardColumn({
  object, column, field, filter, sort, watch, onStale, cardFields, team, saves, writable, total, dragging, setDragging, moving, hrefOf, moveTo, targets,
}: {
  object: ListedObject;
  column: BoardColumnOf;
  field: FieldDescription;
  filter: ViewFilter[];
  sort?: ListSort;
  watch: readonly string[];
  onStale: () => void;
  cardFields: readonly FieldDescription[];
  team?: readonly TeamMember[];
  saves: BoardSaves;
  writable: boolean;
  /** From the server's grouped counts; null while they load. */
  total: { count: number; sum: number | null } | null;
  dragging: ListRow | null;
  setDragging: (row: ListRow | null) => void;
  moving: ReadonlySet<string>;
  hrefOf: (row: ListRow) => string;
  moveTo: (row: ListRow, key: Scalar | null) => void;
  /** Columns a card can be moved into, for its Move to menu. */
  targets: readonly BoardColumnOf[];
}) {
  const own: ViewFilter = column.key === null ? { field: field.apiName, op: "empty" } : { field: field.apiName, op: "eq", value: column.key };
  // The column's own predicate narrows the view's filters. An empty column reads nothing.
  const query = total && total.count > 0 ? { object, filter: [...filter, own], ...(sort ? { sort } : {}), limit: COLUMN_CARDS } : null;
  const { rows, total: listed, hasMore, loadMore, loadingMore, reload, error } = useObjectList(query, { watch, onStale });
  const [over, setOver] = useState(false);
  // A company on a card reads by name, as it does in the table.
  const lookupTitles = useLookupTitles(cardFields.filter((f) => f.type === "lookup"), rows);
  const money = useWorkspaceMoney();
  const accepts = writable && column.accepts;
  const refused = dragging !== null && !accepts;

  useEffect(() => {
    if (query && saves.n > 0) void reload(saves.saves);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saves, reload]);

  return (
    <section
      aria-label={`${column.label} column`}
      onDragOver={(e) => {
        if (!accepts || !e.dataTransfer.types.includes(ROW_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!accepts) return;
        const raw = e.dataTransfer.getData(ROW_TYPE);
        if (raw) moveTo(JSON.parse(raw) as ListRow, column.key);
      }}
      className={cn(
        "flex w-[85vw] shrink-0 snap-start flex-col border border-border bg-muted/30 sm:w-72",
        dragging && accepts && "border-dashed border-primary/60",
        over && "border-solid border-primary bg-primary/5",
        refused && "opacity-50",
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs font-medium">
        <span className="flex min-w-0 items-center gap-1">
          {writable && !column.accepts && <Lock aria-label="Takes no cards" className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="truncate">{column.label}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{total === null ? "…" : `${total.count.toLocaleString()}${total.sum !== null ? ` · ${moneyText(total.sum, money)}` : ""}`}</span>
      </header>
      <div className="flex min-h-24 flex-col gap-2 p-2">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {query && rows === null && !error && <p className="px-1 text-xs text-muted-foreground">Loading…</p>}
        {rows?.map((row) => {
          const current = (row.values[field.fieldId] ?? null) as Scalar | null;
          const elsewhere = targets.filter((t) => keyId(t.key) !== keyId(current));
          return (
            <article
              key={row.id}
              draggable={writable && !moving.has(row.id)}
              onDragStart={(e) => {
                e.dataTransfer.setData(ROW_TYPE, JSON.stringify(row));
                e.dataTransfer.effectAllowed = "move";
                setDragging(row);
              }}
              onDragEnd={() => setDragging(null)}
              aria-busy={moving.has(row.id) || undefined}
              className={cn("relative border border-border bg-card p-2 text-sm shadow-sm hover:border-primary/50", moving.has(row.id) && "opacity-60")}
            >
              <div className="flex items-start gap-1">
                <Link href={hrefOf(row)} draggable={false} className="record-name min-w-0 flex-1 font-medium after:absolute after:inset-0 hover:underline">
                  {row.title || "Untitled"}
                </Link>
                <RecordQuickView object={object} id={row.id} label={row.title || "Untitled"} className="relative z-[1]" />
                {writable && elsewhere.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label={`Move ${row.title || "Untitled"} to…`} disabled={moving.has(row.id)} className="relative z-[1] inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground">
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                      <DropdownMenuLabel className="text-xs">Move to</DropdownMenuLabel>
                      {elsewhere.map((t) => <DropdownMenuItem key={keyId(t.key)} onSelect={() => moveTo(row, t.key)}>{t.label}</DropdownMenuItem>)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {cardFields.map((f) => {
                const raw = row.values[f.fieldId];
                if (f.type === "lookup" && "lookupTo" in f && typeof raw === "string" && raw) {
                  return (
                    <div key={f.fieldId} className="truncate text-xs text-muted-foreground">
                      {f.label}: <Link href={recordHref(f.lookupTo as ListedObject, raw)} draggable={false} className="relative z-[1] underline">{lookupTitles[raw] ?? "…"}</Link>
                    </div>
                  );
                }
                const shown = formatValue(f, raw as never, team, typeof row.values.currency === "string" && row.values.currency && object === "deal" ? { ...money, currency: row.values.currency } : money);
                return shown ? <div key={f.fieldId} className="truncate text-xs text-muted-foreground">{f.label}: <span className="tabular-nums">{shown}</span></div> : null;
              })}
            </article>
          );
        })}
        {rows !== null && hasMore && (
          <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="px-1 text-left text-xs text-primary hover:underline disabled:opacity-50">
            {loadingMore ? "Loading…" : `Show more (${rows.length.toLocaleString()} of ${listed.toLocaleString()})`}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * A board: a column per value of a picklist, user or yes/no field, in the field's order, then "No <field>". Counts
 * (and a deal's amount) come from the server's grouped read and each column's cards from the list, both through the
 * caller's scoped client. Dragging a card, or its Move to menu, sets the field through the record page's own edit.
 */
export function BoardView({
  object, groupBy, filter, sort, watch, onStale, cardFields, team, writable, readOnly, hrefOf, onMove, saves, columns: given, totals,
}: {
  /** Columns in place of the field's own (a deal pipeline's stages). */
  columns?: readonly BoardColumnSpec[];
  /** Org-wide totals by column value, in place of the grouped counts (a deal pipeline with no filter). */
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
  /** Why cards can't be moved, shown above a board that isn't writable. */
  readOnly?: string;
  hrefOf: (row: ListRow) => string;
  /** Set the field; resolves once the edit is answered (a refusal is reported by the caller). */
  onMove: (row: ListRow, key: Scalar | null) => Promise<void>;
  saves: BoardSaves;
}) {
  const { res, error, reload } = useGroups(totals ? null : { object, filter, group: { field: groupBy.apiName } }, saves);
  const [dragging, setDragging] = useState<ListRow | null>(null);
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const columns: BoardColumnOf[] = given
    ? given.map((c) => ({ key: c.value === "" ? null : c.value, label: c.label, accepts: c.accepts }))
    : boardColumns(groupBy, team ?? [], res?.groups.map((g) => g.key));
  const counts = new Map(res?.groups.map((g) => [keyId(g.key), { count: g.count, sum: g.sum }]));
  const totalOf = (key: Scalar | null) => {
    const org = totals?.get(key === null ? "" : String(key));
    if (totals) return org ? { count: org.count, sum: org.amount } : { count: 0, sum: 0 };
    return res ? counts.get(keyId(key)) ?? { count: 0, sum: res.summed ? 0 : null } : null;
  };
  const targets = writable ? columns.filter((c) => c.accepts) : [];
  const moveTo = (row: ListRow, key: Scalar | null) => {
    setDragging(null);
    if (keyId((row.values[groupBy.fieldId] ?? null) as Scalar | null) === keyId(key)) return;
    setMoving((cur) => new Set(cur).add(row.id));
    void onMove(row, key).finally(() => setMoving((cur) => { const next = new Set(cur); next.delete(row.id); return next; }));
  };
  if (error) return <ReadFailure message={error} retry={reload} retained={false} />;
  if (groupBy.type === "user" && team === undefined) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  return (
    <>
      {!writable && readOnly && <p className="mb-2 flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3 w-3" /> {readOnly}</p>}
      {res?.truncated && <p className="mb-2 text-xs text-muted-foreground">Showing the first {res.groups.length} values; filter to see the rest.</p>}
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 sm:snap-none">
        {columns.map((c) => (
          <BoardColumn
            key={keyId(c.key)}
            object={object}
            column={c}
            field={groupBy}
            filter={filter}
            sort={sort}
            watch={[...watch, groupBy.fieldId]}
            onStale={onStale}
            cardFields={cardFields}
            team={team}
            saves={saves}
            writable={writable}
            total={totalOf(c.key)}
            dragging={dragging}
            setDragging={setDragging}
            moving={moving}
            hrefOf={hrefOf}
            moveTo={moveTo}
            targets={targets}
          />
        ))}
      </div>
    </>
  );
}
