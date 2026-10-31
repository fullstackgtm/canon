"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search } from "lucide-react";
import { escapeCsvCell } from "@/lib/csv-export";
import { cn } from "@/lib/utils";

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number | boolean | Date | null | undefined;
  searchValue?: (row: T) => string | number | boolean | null | undefined;
  exportValue?:
    | ((row: T) => string | number | boolean | Date | null | undefined)
    | null;
  sortable?: boolean;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  className?: string;
  searchPlaceholder?: string;
  enableSearch?: boolean;
  enableExport?: boolean;
  exportFileName?: string;
  exportAllFields?: boolean;
  showRowCount?: boolean;
  filters?: React.ReactNode;
  initialSort?: {
    key: string;
    direction: "asc" | "desc";
  };
  /** Rows under a header per group (in the groups' name order), each header with its count. */
  groupBy?: (row: T) => string;
  /** Rows a page shows, with Previous and Next past them. All rows when left out. */
  pageSize?: number;
  /** What the body shows when no row matches (a way to clear the filters). A line of text when left out. */
  emptyState?: React.ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  className,
  searchPlaceholder = "Search table...",
  enableSearch = true,
  enableExport = true,
  exportFileName = "table-export.csv",
  exportAllFields = false,
  showRowCount = true,
  filters,
  initialSort,
  groupBy,
  pageSize,
  emptyState,
}: DataTableProps<T>) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const [sort, setSort] = useState<
    { key: string; direction: "asc" | "desc" } | undefined
  >(initialSort);

  const visibleData = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const filtered = normalizedSearch
      ? data.filter((row) => rowMatchesSearch(row, columns, normalizedSearch))
      : [...data];

    if (!sort) return filtered;

    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column || column.sortable === false) return filtered;

    return [...filtered].sort((a, b) => {
      const aValue = comparableValue(cellValue(a, column));
      const bValue = comparableValue(cellValue(b, column));

      if (aValue === bValue) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;

      const result = aValue > bValue ? 1 : -1;
      return sort.direction === "asc" ? result : -result;
    });
  }, [columns, data, search, sort]);
  // Grouped, the groups come in name order and each keeps the sort inside it.
  const orderedData = useMemo(() => {
    if (!groupBy) return visibleData;
    const groups = new Map<string, T[]>();
    for (const row of visibleData) groups.set(groupBy(row), [...(groups.get(groupBy(row)) ?? []), row]);
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, rows]) => rows);
  }, [visibleData, groupBy]);
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (groupBy) for (const row of visibleData) counts.set(groupBy(row), (counts.get(groupBy(row)) ?? 0) + 1);
    return counts;
  }, [visibleData, groupBy]);
  const pages = pageSize ? Math.max(1, Math.ceil(orderedData.length / pageSize)) : 1;
  const at = Math.min(page, pages - 1);
  const pageRows = pageSize ? orderedData.slice(at * pageSize, (at + 1) * pageSize) : orderedData;

  const showToolbar =
    (enableSearch && data.length > 0) ||
    filters ||
    (enableExport && data.length > 0) ||
    (showRowCount && data.length > 0);

  function toggleSort(column: Column<T>) {
    if (column.sortable === false) return;

    setSort((current) => {
      if (current?.key !== column.key) {
        return { key: column.key, direction: "asc" };
      }
      if (current.direction === "asc") {
        return { key: column.key, direction: "desc" };
      }
      return undefined;
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!onRowClick || pageRows.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveRowIndex((index) => Math.min(index + 1, pageRows.length - 1));
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveRowIndex((index) => Math.max(index - 1, 0));
    }

    if (event.key === "Enter") {
      event.preventDefault();
      onRowClick(pageRows[Math.min(activeRowIndex, pageRows.length - 1)]);
    }
  }

  function exportVisibleRows() {
    if (visibleData.length === 0) return;

    const excludedExportKeys = new Set(
      columns
        .filter((column) => column.exportValue === null)
        .map((column) => column.key),
    );
    const exportableColumns = exportAllFields
      ? Array.from(
          visibleData.reduce((keys, row) => {
            Object.keys(row as Record<string, unknown>).forEach((key) => {
              if (!excludedExportKeys.has(key)) keys.add(key);
            });
            return keys;
          }, new Set<string>()),
        ).map((key) => ({
          key,
          header: columns.find((column) => column.key === key)?.header ?? exportHeaderFromKey(key),
        }))
      : columns.filter((column) => column.exportValue !== null);
    const csv = [
      exportableColumns.map((column) => escapeCsvCell(column.header)).join(","),
      ...visibleData.map((row) =>
        exportableColumns
          .map((column) => escapeCsvCell(exportCellValue(row, column)))
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName.endsWith(".csv")
      ? exportFileName
      : `${exportFileName}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className={cn("overflow-hidden bg-transparent", className?.includes("mt-") ? className : undefined)}
      tabIndex={onRowClick ? 0 : undefined}
      onKeyDown={handleKeyDown}
    >
      {showToolbar && (
        <div className="flex flex-col gap-3 border-b border-border/70 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            {enableSearch && data.length > 0 ? (
              <label className="relative min-w-0 flex-1 sm:max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setActiveRowIndex(0);
                    setPage(0);
                  }}
                  placeholder={searchPlaceholder}
                  className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
              </label>
            ) : null}
            {showRowCount && data.length > 0 && (
              <div className="whitespace-nowrap text-xs text-muted-foreground">
                {visibleData.length === data.length
                  ? `${data.length} row${data.length === 1 ? "" : "s"}`
                  : `${visibleData.length} of ${data.length} rows`}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filters}
            {enableExport && data.length > 0 && (
              <button
                type="button"
                onClick={exportVisibleRows}
                disabled={visibleData.length === 0}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
            )}
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border/70">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-3 text-left font-medium text-muted-foreground",
                    col.className,
                  )}
                >
                  {col.sortable === false ? (
                    col.header
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(col)}
                      className="inline-flex items-center gap-1.5 text-left transition-colors hover:text-foreground"
                    >
                      {col.header}
                      <SortIcon
                        active={sort?.key === col.key}
                        direction={sort?.direction}
                      />
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  {emptyState ?? "No rows match the current view."}
                </td>
              </tr>
            ) : (
              pageRows.flatMap((row, rowIndex) => [
                ...(groupBy && (rowIndex === 0 || groupBy(pageRows[rowIndex - 1]) !== groupBy(row)) ? [
                  <tr key={`group:${groupBy(row)}`} className="bg-muted/40" data-group={groupBy(row)}>
                    <th colSpan={columns.length} scope="colgroup" className="px-4 py-1.5 text-left text-xs font-medium">
                      {groupBy(row)} <span className="font-normal text-muted-foreground">· {groupCounts.get(groupBy(row)) ?? 0}</span>
                    </th>
                  </tr>,
                ] : []),
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onMouseEnter={() => setActiveRowIndex(rowIndex)}
                  className={cn(
                    "transition-colors hover:bg-muted/30",
                    onRowClick && "cursor-pointer",
                    onRowClick &&
                      rowIndex === activeRowIndex &&
                      "bg-muted/40",
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn("px-4 py-3", col.className)}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>,
              ])
            )}
          </tbody>
        </table>
      </div>
      {pageSize !== undefined && orderedData.length > pageSize && (
        <nav aria-label="Pages" className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">Showing {at * pageSize + 1}–{Math.min((at + 1) * pageSize, orderedData.length)} of {orderedData.length}</span>
          <button type="button" className="border border-border px-2 py-1 hover:bg-muted disabled:opacity-40" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</button>
          <button type="button" className="border border-border px-2 py-1 hover:bg-muted disabled:opacity-40" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next</button>
        </nav>
      )}
    </div>
  );
}

function SortIcon({
  active,
  direction,
}: {
  active: boolean;
  direction?: "asc" | "desc";
}) {
  if (!active) {
    return <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />;
  }

  if (direction === "asc") {
    return <ArrowUp className="h-3.5 w-3.5" />;
  }

  return <ArrowDown className="h-3.5 w-3.5" />;
}

function cellValue<T>(row: T, column: Column<T>) {
  if (column.sortValue) return column.sortValue(row);
  if (column.searchValue) return column.searchValue(row);

  const rawRow = row as Record<string, unknown>;
  return rawRow[column.key];
}

function exportCellValue<T>(
  row: T,
  column: Column<T> | { key: string; header: string },
) {
  if ("exportValue" in column && column.exportValue) {
    return column.exportValue(row);
  }
  return cellValue(row, column as Column<T>);
}

function exportHeaderFromKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function comparableValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string") return value.toLowerCase();
  return null;
}

function searchableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(searchableValue).join(" ");
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "";
}

function rowMatchesSearch<T>(
  row: T,
  columns: Column<T>[],
  normalizedSearch: string,
) {
  const rowValues = Object.values(row as Record<string, unknown>)
    .map(searchableValue)
    .join(" ");
  const columnValues = columns
    .map((column) => {
      if (column.searchValue) return searchableValue(column.searchValue(row));
      return searchableValue(cellValue(row, column));
    })
    .join(" ");

  return `${rowValues} ${columnValues}`.toLowerCase().includes(normalizedSearch);
}
