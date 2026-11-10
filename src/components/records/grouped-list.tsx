"use client";

import type { ViewFilter } from "../../../modules/kernel/reportValidators";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ListRow, ListSort, Scalar } from "../../../convex/lib/objects/listSpec";
import type { ResolvedObjectDef } from "../../../convex/lib/objects/registry";
import { groupKeyKind } from "../../../convex/lib/objects/reportSpec";
import { groupFilter, type ViewGroup } from "../../../convex/lib/objects/views";
import { LoadingRows, ReadFailure } from "@/components/dashboard";
import { bucketLabel } from "@/components/reports/present";
import { useContactAnswers, type AiField } from "@/components/research/ai-cell";
import { formatValue, type CellValue, type FieldDescription, type TeamMember } from "./fields";
import { useLookupTitles } from "./lookup-field";
import { moneyText, useWorkspaceMoney } from "./money";
import { useObjectList, type ListedObject } from "./use-object-list";
import type { BoardSaves } from "./board-view";
import { useGroups } from "./use-groups";

/** Rows an open group shows before "Show more", which adds a page of the list's own size. */
const GROUP_ROWS = 10;
/** Groups open when the grouping is chosen; the rest wait for a click, so a large grouping reads one list per open group. */
const GROUPS_OPEN = 3;

const keyId = (key: Scalar | null) => JSON.stringify(key);

/** What a row needs from its group to render: lookup titles and AI answers for the rows on screen. */
export type RowContext = { lookupTitles: Record<string, string>; aiAnswers: ReturnType<typeof useContactAnswers> };

function GroupSection({
  object, def, group, groupKey, label, count, sum, filter, sort, watch, onStale, saves, columnCount, open, onToggle, lookupFields, aiFields, renderRow,
}: {
  object: ListedObject;
  def: ResolvedObjectDef;
  group: ViewGroup;
  groupKey: Scalar | null;
  label: string;
  count: number;
  sum: number | null;
  filter: ViewFilter[];
  sort?: ListSort;
  watch: readonly string[];
  onStale: () => void;
  saves: BoardSaves;
  columnCount: number;
  open: boolean;
  onToggle: () => void;
  lookupFields: readonly FieldDescription[];
  aiFields: readonly AiField[];
  renderRow: (row: ListRow, at: RowContext) => ReactNode;
}) {
  // A closed group reads nothing; an open one lists its records with the group's own predicate added to the view's filters.
  const query = open ? { object, filter: [...filter, ...groupFilter(def, group, groupKey)], ...(sort ? { sort } : {}), limit: GROUP_ROWS } : null;
  const { rows, total, hasMore, loadMore, loadingMore, reload, error } = useObjectList(query, { watch, onStale });
  const lookupTitles = useLookupTitles(lookupFields, rows);
  const aiAnswers = useContactAnswers(rows?.map((r) => r.id), aiFields);
  const money = useWorkspaceMoney();
  useEffect(() => {
    if (open && saves.n > 0) void reload(saves.saves);
  }, [saves, open, reload]);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <tbody>
      <tr className="border-t border-border bg-muted/30">
        <td colSpan={columnCount} className="px-3 py-1.5">
          <button type="button" aria-expanded={open} onClick={onToggle} className="inline-flex items-center gap-1.5 text-xs font-medium hover:text-foreground">
            <Icon className="h-3 w-3" aria-hidden />
            <span>{label}</span>
            <span className="tabular-nums text-muted-foreground">{count.toLocaleString()}{sum !== null ? ` · ${moneyText(sum, money)}` : ""}</span>
          </button>
        </td>
      </tr>
      {open && error && <tr><td colSpan={columnCount} className="px-3 py-2 text-xs text-destructive">{error}</td></tr>}
      {open && rows === null && !error && <tr><td colSpan={columnCount} className="px-3 py-2 text-xs text-muted-foreground">Loading…</td></tr>}
      {open && rows?.map((row) => renderRow(row, { lookupTitles, aiAnswers }))}
      {open && rows !== null && hasMore && (
        <tr>
          <td colSpan={columnCount} className="px-3 py-1.5">
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="text-xs text-primary hover:underline disabled:opacity-50">
              {loadingMore ? "Loading…" : `Show more (${rows.length.toLocaleString()} of ${total.toLocaleString()})`}
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

/**
 * A table grouped by one field: a header per group with its count (and a deal's amount), collapsible, and an open
 * group's records under it. Counts come from the server's aggregate, rows from the list, both through the caller's
 * scoped client, so neither shows a record the caller cannot see.
 */
export function GroupedRows({
  object, def, group, field, label, filter, sort, watch, onStale, team, saves, columnCount, header, lookupFields, aiFields, renderRow,
}: {
  object: ListedObject;
  def: ResolvedObjectDef;
  group: ViewGroup;
  /** The grouping field's description, when it is a field (not a system column). */
  field?: FieldDescription;
  label: string;
  filter: ViewFilter[];
  sort?: ListSort;
  watch: readonly string[];
  onStale: () => void;
  team?: readonly TeamMember[];
  saves: BoardSaves;
  columnCount: number;
  header: ReactNode;
  lookupFields: readonly FieldDescription[];
  aiFields: readonly AiField[];
  renderRow: (row: ListRow, at: RowContext) => ReactNode;
}) {
  const { res, error, reload } = useGroups({ object, filter, group }, saves);
  // Which groups are open, by key; the first few open whenever the grouping or filters change.
  const queryKey = JSON.stringify([object, filter, group]);
  const [toggledFor, setToggled] = useState<{ key: string; open: Map<string, boolean> }>({ key: queryKey, open: new Map() });
  const toggled = toggledFor.key === queryKey ? toggledFor.open : new Map<string, boolean>();
  const kind = groupKeyKind(def, group.field);
  const money = useWorkspaceMoney();
  const keyTitles = useLookupTitles(field?.type === "lookup" ? [field] : [], res?.groups.map((g) => ({ values: { [field?.fieldId ?? ""]: g.key } })));
  const labelOf = (key: Scalar | null): string => {
    if (key === null) return `No ${label.toLowerCase()}`;
    if (kind === "day" || kind === "instant") return bucketLabel(String(key), group.bucket ?? "month");
    if (field?.type === "lookup") return keyTitles[String(key)] ?? String(key);
    return field ? formatValue(field, key as CellValue, team, money) || String(key) : String(key);
  };
  const groupWatch = [...watch, ...(field ? [field.fieldId] : [])];
  if (error) return <ReadFailure message={error} retry={reload} retained={res !== null} />;
  if (!res) return <LoadingRows />;
  if (!res.groups.length) return <p className="p-4 text-sm text-muted-foreground">No records match these filters.</p>;
  return (
    <>
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {res.rows.toLocaleString()} in {res.groups.length.toLocaleString()} groups{res.sum !== null ? ` · ${moneyText(res.sum, money)}` : ""}
        {res.truncated && <> · showing the first {res.groups.length}; filter to see the rest</>}
      </div>
      <div className="overflow-x-auto border border-border">
        <table className="w-full text-sm">
          {header}
          {res.groups.map((g, i) => {
            const id = keyId(g.key);
            const open = toggled.get(id) ?? i < GROUPS_OPEN;
            return (
              <GroupSection
                key={id}
                object={object}
                def={def}
                group={group}
                groupKey={g.key}
                label={labelOf(g.key)}
                count={g.count}
                sum={g.sum}
                filter={filter}
                sort={sort}
                watch={groupWatch}
                onStale={onStale}
                saves={saves}
                columnCount={columnCount}
                open={open}
                onToggle={() => setToggled({ key: queryKey, open: new Map(toggled).set(id, !open) })}
                lookupFields={lookupFields}
                aiFields={aiFields}
                renderRow={renderRow}
              />
            );
          })}
        </table>
      </div>
    </>
  );
}
